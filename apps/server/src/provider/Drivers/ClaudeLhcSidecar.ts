// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
/**
 * ClaudeLhcSidecar — the `createQuery` seam for LHC-backed Claude instances.
 *
 * Instead of calling the Claude Agent SDK in-process, an LHC instance spawns the
 * `claude-lhc` sidecar (Node, compiled JS) and speaks its JSONL
 * protocol over stdio. The sidecar runs the same SDK against the same binary,
 * records every message into LHC, and forwards the native `SDKMessage` stream
 * unchanged, so the adapter's parsing, approvals, and usage meter work as they
 * do for the native path.
 *
 * Wire (one JSON object per line):
 *   adapter → sidecar: `start` (SDK options minus callbacks), `user` (one
 *     SDKUserMessage), `req` (setModel / setPermissionMode / setMaxThinkingTokens),
 *     `res` (answer to a sidecar request), `abort`; stdin EOF closes the session.
 *   sidecar → adapter: `msg` (SDKMessage), `req` (canUseTool / onUserDialog),
 *     `res`, `abort` (the SDK aborted its own request), `error` (fatal).
 *
 * Sidecar location: `CLAUDE_LHC_SIDECAR` is the Node JS entry file. The server
 * always `spawn(process.execPath, [entry], { windowsHide: true })`. There is no
 * PATH fallback and no Bun launcher. The staged package must match the pin in
 * `lhc/sidecar.json` (version and integrity), checked when the instance is built.
 *
 * LHC state: the server sets the sidecar's `T3CODE_LHC_HOME` to `<T3 home>-lhc`
 * (`claudeLhcHomeDir`), whatever the environment says, so a start without the
 * service unit's environment can never reach another install's store. The old
 * fork's store, `~/.t3code-lhc`, is refused outright.
 *
 * @module provider/Drivers/ClaudeLhcSidecar
 */
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import sidecarPin from "../../../../../lhc/sidecar.json" with { type: "json" };
import { type CustomModelSetting, ProviderInstanceId } from "@t3tools/contracts";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../ClaudeModelCatalog.ts";

import type {
  ClaudeCreateQuery as CreateQuery,
  ClaudeQueryRuntime as QueryRuntime,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

type SidecarFrame =
  | { type: "msg"; message: SDKMessage }
  | {
      type: "req";
      id: number;
      method: "canUseTool" | "onUserDialog";
      params: Record<string, unknown>;
    }
  | { type: "res"; id: number; ok: true; value: unknown }
  | { type: "res"; id: number; ok: false; error: string }
  | { type: "abort"; id: number }
  | { type: "error"; message: string };

type AdapterFrame =
  | { type: "start"; options: Record<string, unknown> }
  | { type: "user"; message: SDKUserMessage }
  | { type: "req"; id: number; method: string; params: unknown }
  | { type: "res"; id: number; ok: true; value: unknown }
  | { type: "res"; id: number; ok: false; error: string }
  | { type: "abort"; id: number };

/** The runner's query surface plus the sidecar's other controls. */
interface SidecarQueryRuntime extends QueryRuntime {
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
}

const CLOSE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 5_000;

/** Options members that cannot cross the process boundary; the sidecar supplies its own. */
const NON_WIRE_OPTIONS = new Set([
  "canUseTool",
  "onUserDialog",
  "abortController",
  "stderr",
  "spawnClaudeCodeProcess",
  "sessionStore",
  "hooks",
]);

/** The LHC store for a T3 home: beside it, `<base dir>-lhc`. */
export function claudeLhcHomeDir(baseDir: string): string {
  return NodePath.resolve(baseDir).replace(/[\\/]+$/, "") + "-lhc";
}

/** The old t3code-lhc fork's store (the live install on port 3773). This build never uses it. */
export const FORK_LHC_HOME = NodePath.join(NodeOS.homedir(), ".t3code-lhc");

/** Live stores this build never uses: the old fork's (3773) and the v0.0.44 install's (3780). */
export const REFUSED_LHC_HOMES: ReadonlyArray<string> = [
  FORK_LHC_HOME,
  NodePath.join(NodeOS.homedir(), ".t3code-v044-lhc"),
];

export interface SidecarPin {
  readonly package: string;
  readonly version: string;
  readonly integrity: string;
}

/** What the staged package beside the entry says about itself, or why it can't be read. */
function stagedSidecarMismatch(entry: string, pin: SidecarPin): string | undefined {
  // <prefix>/node_modules/<package>/dist/sidecar.js
  const packageDir = NodePath.dirname(NodePath.dirname(entry));
  const modulesDir = NodePath.dirname(packageDir);
  try {
    const staged = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    if (staged.name !== pin.package || staged.version !== pin.version) {
      return `the staged sidecar is ${staged.name}@${staged.version}; this build is pinned to ${pin.package}@${pin.version}`;
    }
    const lock = JSON.parse(
      NodeFS.readFileSync(NodePath.join(modulesDir, ".package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { integrity?: string }>;
    };
    const integrity = lock.packages?.[`node_modules/${pin.package}`]?.integrity;
    if (integrity !== pin.integrity)
      return `the staged ${pin.package} has integrity ${integrity ?? "(none recorded)"}, not the pinned one`;
  } catch (cause) {
    return `can't verify the staged sidecar against the pin: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return undefined;
}

/**
 * Why this server cannot start the sidecar, or undefined when it can try. The
 * Claude LHC instance reports it as its status so clients offer no LHC thread
 * that would only fail on its first turn (and never fall back to native).
 */
export function claudeLhcSidecarUnavailableReason(
  environment: NodeJS.ProcessEnv,
  baseDir: string,
  pin: SidecarPin = sidecarPin,
): string | undefined {
  const store = claudeLhcHomeDir(baseDir);
  if (store === FORK_LHC_HOME) {
    return `This T3 home (${baseDir}) would put LHC state in ${FORK_LHC_HOME}, the old fork's live store; use another T3 home.`;
  }
  if (REFUSED_LHC_HOMES.includes(store)) {
    return `This T3 home (${baseDir}) would put LHC state in ${store}, another install's live store; use another T3 home.`;
  }
  const configured = environment.CLAUDE_LHC_SIDECAR?.trim();
  if (configured === undefined || configured === "") {
    return "CLAUDE_LHC_SIDECAR must be set to the compiled claude-lhc JS entry.";
  }
  if (!NodeFS.existsSync(configured)) {
    return `CLAUDE_LHC_SIDECAR names a file that does not exist: ${configured}`;
  }
  const mismatch = stagedSidecarMismatch(configured, pin);
  return mismatch === undefined ? undefined : `${mismatch}. Run lhc/stage-sidecar.sh.`;
}

export function resolveClaudeLhcSidecarPath(
  environment: NodeJS.ProcessEnv,
  baseDir: string,
  pin: SidecarPin = sidecarPin,
): string {
  const unavailable = claudeLhcSidecarUnavailableReason(environment, baseDir, pin);
  if (unavailable !== undefined) throw new Error(unavailable);
  return environment.CLAUDE_LHC_SIDECAR!.trim();
}

function toWireOptions(options: ClaudeQueryOptions): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (NON_WIRE_OPTIONS.has(key) || typeof value === "function" || value === undefined) continue;
    wire[key] = value;
  }
  return wire;
}

/** An async queue of messages the runtime iterator drains; `fail` rejects the pending pull and every later one. */
class MessageQueue {
  readonly #items: SDKMessage[] = [];
  #ended = false;
  #failure: Error | undefined;
  #wake: (() => void) | undefined;

  push(message: SDKMessage): void {
    this.#items.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  fail(cause: Error): void {
    this.#failure ??= cause;
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) {
        if (this.#failure !== undefined) throw this.#failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = undefined;
          resolve();
        };
      });
    }
  }
}

export interface ClaudeLhcSidecarOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** The server's T3 home; the LHC store is derived from it. */
  readonly baseDir: string;
  /** Defaults to `lhc/sidecar.json`. */
  readonly pin?: SidecarPin;
  /** The instance's compaction windows (ClaudeLhcSettings); the sidecar requires both. */
  readonly windows?: { readonly autoCompactWindow: string; readonly lhcLowerBound: string };
  /** The instance's custom models; a declared `contextWindow` sizes its model. */
  readonly customModels?: ReadonlyArray<CustomModelSetting>;
}

/**
 * The window Claude Code assumes for a model it doesn't know (no `[1m]` suffix, no catalog entry,
 * no CLAUDE_CODE_MAX_CONTEXT_TOKENS), and so the window LHC fits such a model to unless its custom
 * model entry says otherwise. An unknown model is never left uncapped (Mira #305).
 */
export const UNCATALOGUED_CONTEXT_WINDOW = 200_000;

const catalogContextWindow = (model: string): number | undefined =>
  model.endsWith("[1m]")
    ? 1_000_000
    : resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
        instanceId: ProviderInstanceId.make("claude-lhc"),
        model,
      });

const customModelSlug = (entry: CustomModelSetting): string =>
  typeof entry === "string" ? entry : entry.slug;

/** An entry that declares its own window overrides the catalog, even for a slug the catalog knows. */
const declaresContextWindow = (entry: CustomModelSetting | undefined): boolean =>
  entry !== undefined && typeof entry !== "string" && entry.contextWindow !== undefined;

/** A positive CLAUDE_CODE_MAX_CONTEXT_TOKENS: what Claude Code then assumes for an unknown model. */
const environmentContextWindow = (env: NodeJS.ProcessEnv): number | undefined => {
  const value = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

/** The model's own custom entry's declared window, if it has one. */
const declaredContextWindow = (
  model: string,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): number | undefined => {
  const entry = customModels?.find((candidate) => customModelSlug(candidate) === model);
  return declaresContextWindow(entry) && typeof entry !== "string"
    ? entry?.contextWindow
    : undefined;
};

/**
 * The window for the model a query opens with. A model change opens a new query (the API model id
 * is part of `compileClaudeModelSelection`'s queryIdentity), so each query sizes its own model.
 * - `[1m]`: 1M, as Claude Code does.
 * - A declared `contextWindow` on the model's own entry overrides the catalog, even for a slug the
 *   catalog knows (an alias pointed elsewhere).
 * - The catalog.
 * - An explicit CLAUDE_CODE_MAX_CONTEXT_TOKENS in the environment: Claude Code uses it for a model it
 *   doesn't know, so the fit must too.
 * - The model's declared `contextWindow`.
 * - {@link UNCATALOGUED_CONTEXT_WINDOW}, so an unknown model is never uncapped.
 * An empty model (Claude Code's own default) stays unfitted.
 */
export function lhcFitContextWindow(
  model: string,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  env: NodeJS.ProcessEnv = {},
): number | undefined {
  if (model === "") return undefined;
  if (model.endsWith("[1m]")) return 1_000_000;
  const declared = declaredContextWindow(model, customModels);
  const catalogued = catalogContextWindow(model);
  if (catalogued !== undefined) return declared ?? catalogued;
  return environmentContextWindow(env) ?? declared ?? UNCATALOGUED_CONTEXT_WINDOW;
}

/**
 * Claude Code sizes a non-Claude model it doesn't know from CLAUDE_CODE_MAX_CONTEXT_TOKENS, else
 * assumes 200k. Pass the opened model's declared window, unless the environment already sets the
 * variable.
 */
export function withContextWindowEnv(
  env: NodeJS.ProcessEnv,
  model: string,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): NodeJS.ProcessEnv {
  if (environmentContextWindow(env) !== undefined) return env;
  const declared = declaredContextWindow(model, customModels);
  if (declared === undefined) return env;
  return { ...env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(declared) };
}

/**
 * The claude-lhc sidecar turns off Claude Code's own auto-compact and compacts only when context
 * reaches its trigger, so a trigger at or above the model's window lets the context overflow
 * first (the 700k default on a 200k model). Such a trigger drops to 80% of the window, leaving
 * room for one more tool result, and the rebuilt view to at most half of that.
 */
export function fitLhcCompactionToContextWindow(input: {
  readonly autoCompactWindow: number;
  readonly lhcLowerBound: number;
  readonly contextWindow: number | undefined;
}): { readonly autoCompactWindow: number; readonly lhcLowerBound: number } {
  const { autoCompactWindow, lhcLowerBound, contextWindow } = input;
  if (contextWindow === undefined) return { autoCompactWindow, lhcLowerBound };
  const maxTrigger = Math.floor(contextWindow * 0.8);
  if (autoCompactWindow <= maxTrigger) return { autoCompactWindow, lhcLowerBound };
  return {
    autoCompactWindow: maxTrigger,
    lhcLowerBound: Math.min(lhcLowerBound, Math.floor(maxTrigger / 2)),
  };
}

/** The query's settings with the instance's two windows, fitted to the query's model. */
function withLhcWindows(
  options: Parameters<CreateQuery>[0]["options"],
  sidecar: ClaudeLhcSidecarOptions,
): Parameters<CreateQuery>[0]["options"] {
  const { windows, customModels } = sidecar;
  if (windows === undefined) return options;
  // The API model id carries a "[1m]" suffix when the 1M window is selected.
  const model = typeof options.model === "string" ? options.model : "";
  const contextWindow = lhcFitContextWindow(model, customModels, {
    ...sidecar.environment,
    ...options.env,
  });
  const fitted = fitLhcCompactionToContextWindow({
    autoCompactWindow: Number(windows.autoCompactWindow),
    lhcLowerBound: Number(windows.lhcLowerBound),
    contextWindow,
  });
  const settings =
    typeof options.settings === "object" && options.settings !== null ? options.settings : {};
  return {
    ...options,
    settings: { ...settings, ...fitted } as NonNullable<typeof options.settings>,
  };
}

export function makeClaudeLhcCreateQuery(sidecar: ClaudeLhcSidecarOptions): CreateQuery {
  return (input) => startSidecarQuery(input, sidecar);
}

function startSidecarQuery(
  input: Parameters<CreateQuery>[0],
  sidecar: ClaudeLhcSidecarOptions,
): QueryRuntime {
  const sidecarPath = resolveClaudeLhcSidecarPath(
    sidecar.environment,
    sidecar.baseDir,
    sidecar.pin,
  );
  const messages = new MessageQueue();
  const pendingControls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  const inflightRequests = new Map<number, AbortController>();
  let nextControlId = 0;
  let closed = false;
  let stdinOpen = true;

  // The sidecar spreads env into the Claude Code child verbatim. The LHC store
  // is always the one derived from this server's T3 home.
  const childEnv: NodeJS.ProcessEnv = {
    ...withContextWindowEnv(
      { ...sidecar.environment, ...input.options.env },
      typeof input.options.model === "string" ? input.options.model : "",
      sidecar.customModels,
    ),
    T3CODE_LHC_HOME: claudeLhcHomeDir(sidecar.baseDir),
  };
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(process.execPath, [sidecarPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      windowsHide: true,
    });
  } catch (cause) {
    throw new Error(
      `Failed to spawn claude-lhc sidecar at ${sidecarPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause: cause },
    );
  }
  const log = (line: string): void => {
    process.stderr.write(`[claude-lhc:${child.pid ?? "?"}] ${line}\n`);
  };

  const send = (frame: AdapterFrame): void => {
    if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const endStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  const failAll = (cause: Error): void => {
    for (const waiter of pendingControls.values()) waiter.reject(cause);
    pendingControls.clear();
    for (const controller of inflightRequests.values()) controller.abort();
    inflightRequests.clear();
  };

  child.on("error", (cause) => {
    messages.fail(
      new Error(`claude-lhc sidecar failed to start (${sidecarPath}): ${cause.message}`),
    );
    failAll(cause);
  });
  child.on("exit", (code, signal) => {
    stdinOpen = false;
    if (closed || code === 0) messages.end();
    else
      messages.fail(
        new Error(`claude-lhc sidecar exited (code ${code ?? "null"}, signal ${signal ?? "none"})`),
      );
    failAll(new Error("claude-lhc sidecar exited"));
  });
  child.stdin?.on("error", (cause) => {
    log(`stdin: ${cause.message}`);
  });
  if (child.stderr !== null) {
    NodeReadline.createInterface({ input: child.stderr }).on("line", (line) => log(line));
  }

  const answerRequest = async (frame: Extract<SidecarFrame, { type: "req" }>): Promise<void> => {
    const controller = new AbortController();
    inflightRequests.set(frame.id, controller);
    try {
      let value: unknown;
      if (frame.method === "canUseTool") {
        const { toolName, input: toolInput, ...rest } = frame.params;
        if (input.options.canUseTool === undefined) throw new Error("canUseTool is not configured");
        value = await input.options.canUseTool(
          String(toolName),
          (toolInput ?? {}) as Record<string, unknown>,
          { ...rest, signal: controller.signal } as Parameters<
            NonNullable<ClaudeQueryOptions["canUseTool"]>
          >[2],
        );
      } else {
        if (input.options.onUserDialog === undefined)
          throw new Error("onUserDialog is not configured");
        // SDK >= 0.3.260 hands `onUserDialog` a `requestId`; the sidecar's
        // frame id is the per-request identity on this side of the pipe, and
        // any `requestId` the sidecar forwards from the SDK overrides it.
        const { request, ...dialogOptions } = frame.params;
        value = await input.options.onUserDialog(
          request as Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[0],
          {
            requestId: String(frame.id),
            ...dialogOptions,
            signal: controller.signal,
          } as Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[1],
        );
      }
      if (!controller.signal.aborted) send({ type: "res", id: frame.id, ok: true, value });
    } catch (cause) {
      if (!controller.signal.aborted) {
        send({
          type: "res",
          id: frame.id,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    } finally {
      inflightRequests.delete(frame.id);
    }
  };

  if (child.stdout !== null) {
    NodeReadline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
      "line",
      (line) => {
        if (line.trim() === "") return;
        let frame: SidecarFrame;
        try {
          frame = JSON.parse(line) as SidecarFrame;
        } catch (cause) {
          log(`unreadable frame: ${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        switch (frame.type) {
          case "msg":
            messages.push(frame.message);
            return;
          case "req":
            void answerRequest(frame);
            return;
          case "res": {
            const waiter = pendingControls.get(frame.id);
            if (waiter === undefined) return;
            pendingControls.delete(frame.id);
            if (frame.ok) waiter.resolve(frame.value);
            else waiter.reject(new Error(frame.error));
            return;
          }
          case "abort":
            inflightRequests.get(frame.id)?.abort();
            return;
          case "error":
            messages.fail(new Error(frame.message));
            return;
        }
      },
    );
  }

  const control = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || !stdinOpen) {
        reject(new Error("claude-lhc sidecar is closed"));
        return;
      }
      const id = ++nextControlId;
      pendingControls.set(id, { resolve, reject });
      send({ type: "req", id, method, params });
    });

  send({
    type: "start",
    options: toWireOptions(withLhcWindows(input.options, sidecar)),
  });

  void (async () => {
    try {
      for await (const message of input.prompt) {
        if (closed) break;
        send({ type: "user", message });
      }
    } catch (cause) {
      log(`prompt stream failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      endStdin();
    }
  })();

  const close = (): void => {
    if (closed) return;
    closed = true;
    endStdin();
    const term = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, CLOSE_GRACE_MS);
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CLOSE_GRACE_MS + KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    messages.end();
  };

  // V2 iterates the query object itself (next/return), as it does the SDK's Query, so the
  // runtime is its own iterator; return() closes the sidecar like Query.return() does.
  const iterator = messages[Symbol.asyncIterator]();
  const runtime: SidecarQueryRuntime = {
    next: () => iterator.next(),
    return: async () => {
      close();
      return { done: true, value: undefined };
    },
    throw: async (cause?: unknown) => {
      close();
      throw cause;
    },
    [Symbol.asyncIterator]() {
      return runtime;
    },
    interrupt: async () => {
      await control("interrupt", {});
    },
    setModel: async (model?: string) => {
      await control("setModel", { model });
    },
    setPermissionMode: async (mode: PermissionMode) => {
      await control("setPermissionMode", { mode });
    },
    setMaxThinkingTokens: async (maxThinkingTokens: number | null) => {
      await control("setMaxThinkingTokens", { maxThinkingTokens });
    },
    close,
  };
  return runtime;
}
