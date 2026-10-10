// Fork-only (artifacts): the store's git history, through the git CLI as
// checkpoints use it. One commit per change; its author is the person or agent
// thread behind it. Trailers on each commit (`T3-Artifact`, `T3-Action`,
// `T3-Item`, `T3-Actor`) let a rebuilt index recover its event log.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { LimArtifactActor } from "@t3tools/contracts";

const COMMITTER = { name: "T3 Code", email: "t3code@users.noreply.github.com" };

// Hooks and signing from the user's own git config must never run on store
// commits, and writes are flushed like checkpoint writes.
const CONFIG = [
  "-c",
  "core.hooksPath=.t3/no-hooks",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.fsync=objects,reference",
  "-c",
  "core.fsyncMethod=fsync",
];

const GITIGNORE = ".t3/\n";

export class ArtifactGitError extends Error {}

export interface ArtifactCommitEvent {
  readonly artifactId: string;
  readonly action: string;
  readonly itemId?: string | null | undefined;
  readonly actor: LimArtifactActor;
  readonly summary: string;
}

export interface LoggedEvent extends ArtifactCommitEvent {
  readonly at: string;
}

const emailFor = (actor: LimArtifactActor) =>
  `${actor.kind}+${actor.id.replace(/[^a-zA-Z0-9._-]/g, "-") || "unknown"}@t3-artifacts.invalid`;

/** Trailer values are single-line. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

export const commitMessage = (subject: string, events: ReadonlyArray<ArtifactCommitEvent>) => {
  const trailers = events.flatMap((event) => [
    `T3-Artifact: ${event.artifactId}`,
    `T3-Action: ${oneLine(event.action)}`,
    ...(event.itemId ? [`T3-Item: ${event.itemId}`] : []),
    `T3-Actor: ${event.actor.kind}:${oneLine(event.actor.id)}:${oneLine(event.actor.name)}`,
    `T3-Summary: ${oneLine(event.summary)}`,
  ]);
  return `${oneLine(subject) || "Update artifacts"}\n\n${trailers.join("\n")}\n`;
};

/** Events recorded in one commit message's trailers, in order. */
export const parseCommitEvents = (body: string, at: string): LoggedEvent[] => {
  const events: LoggedEvent[] = [];
  let current: Partial<ArtifactCommitEvent> & { artifactId?: string } = {};
  const flush = () => {
    if (current.artifactId && current.action && current.actor) {
      events.push({
        artifactId: current.artifactId,
        action: current.action,
        itemId: current.itemId ?? null,
        actor: current.actor,
        summary: current.summary ?? current.action,
        at,
      });
    }
    current = {};
  };
  for (const line of body.split("\n")) {
    const match = /^T3-(Artifact|Action|Item|Actor|Summary): (.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (key === "Artifact") {
      flush();
      current.artifactId = value;
    } else if (key === "Action") current.action = value;
    else if (key === "Item") current.itemId = value;
    else if (key === "Summary") current.summary = value;
    else {
      const [kind = "", id = "", ...name] = value.split(":");
      if (["user", "agent", "external", "system"].includes(kind)) {
        current.actor = {
          kind: kind as LimArtifactActor["kind"],
          id,
          name: name.join(":") || id,
        };
      }
    }
  }
  flush();
  return events;
};

/** The environment for store git commands, free of anything pointing git elsewhere. */
const gitEnv = (extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete env[key];
  }
  return env;
};

export class ArtifactGit {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  run(
    args: ReadonlyArray<string>,
    options: { readonly env?: Record<string, string>; readonly allowExit?: number[] } = {},
  ): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        "git",
        [...CONFIG, ...args],
        { cwd: this.root, env: gitEnv(options.env), maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          if (code === 0 || options.allowExit?.includes(code)) {
            resolve({ stdout, code });
            return;
          }
          reject(
            new ArtifactGitError(
              `git ${args[0]} failed (${code}): ${String(stderr || error?.message).trim()}`,
            ),
          );
        },
      );
    });
  }

  /** Makes the store a repository with its `.gitignore`, if it isn't one yet. */
  async ensureRepo(): Promise<boolean> {
    await NodeFSP.mkdir(this.root, { recursive: true });
    const hasRepo = await NodeFSP.stat(NodePath.join(this.root, ".git")).then(
      () => true,
      () => false,
    );
    if (!hasRepo) await this.run(["init", "-q", "-b", "main"]);
    const ignorePath = NodePath.join(this.root, ".gitignore");
    const ignore = await NodeFSP.readFile(ignorePath, "utf8").catch(() => null);
    if (ignore === null || !ignore.split(/\r?\n/).includes(".t3/")) {
      await NodeFSP.writeFile(ignorePath, `${ignore ? `${ignore.trimEnd()}\n` : ""}${GITIGNORE}`);
      await this.commit({
        paths: [".gitignore"],
        subject: "Create artifact store",
        events: [],
        author: { kind: "system", id: "t3", name: "T3 Code" },
      });
    }
    return !hasRepo;
  }

  /**
   * Commits exactly `paths` (added, changed or deleted) with the events as
   * trailers. Returns the commit, or null when nothing in them changed.
   */
  async commit(input: {
    readonly paths: ReadonlyArray<string>;
    readonly subject: string;
    readonly events: ReadonlyArray<ArtifactCommitEvent>;
    readonly author: LimArtifactActor;
  }): Promise<string | null> {
    if (input.paths.length === 0) return null;
    // A path git never tracked and that no longer exists can't be named to git.
    const tracked = new Set(
      (await this.run(["ls-files", "-z", "--", ...input.paths])).stdout.split("\0"),
    );
    const paths: string[] = [];
    for (const path of new Set(input.paths)) {
      const exists = await NodeFSP.lstat(NodePath.join(this.root, path)).then(
        () => true,
        () => false,
      );
      if (exists || tracked.has(path)) paths.push(path);
    }
    if (paths.length === 0) return null;
    await this.run(["add", "-A", "--", ...paths]);
    const staged = await this.run(["diff", "--cached", "--quiet", "--", ...paths], {
      allowExit: [1],
    });
    if (staged.code === 0) return null;
    await this.run(
      [
        "commit",
        "-q",
        "--no-verify",
        "-m",
        commitMessage(input.subject, input.events),
        "--",
        ...paths,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: oneLine(input.author.name) || "T3 Code",
          GIT_AUTHOR_EMAIL: emailFor(input.author),
          GIT_COMMITTER_NAME: COMMITTER.name,
          GIT_COMMITTER_EMAIL: COMMITTER.email,
        },
      },
    );
    return (await this.run(["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Paths git sees as changed or new, store-relative (ignored files excluded). */
  async changedPaths(): Promise<string[]> {
    const { stdout } = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const paths: string[] = [];
    const entries = stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;
      paths.push(entry.slice(3));
      // A rename or copy is followed by its source path.
      if (entry[0] === "R" || entry[0] === "C") paths.push(entries[++i]!);
    }
    return paths;
  }

  /** Every event recorded in commit trailers, oldest first. */
  async loggedEvents(): Promise<LoggedEvent[]> {
    const { stdout, code } = await this.run(
      ["log", "--reverse", "--format=%aI%x1f%B%x1e"],
      { allowExit: [128] }, // a repository with no commits yet
    );
    if (code !== 0) return [];
    return stdout
      .split("\x1e")
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.includes("\x1f"))
      .flatMap((record) => {
        const [at, body] = record.split("\x1f") as [string, string];
        return parseCommitEvents(body, new Date(at).toISOString());
      });
  }
}
