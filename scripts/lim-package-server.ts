#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Release assembly uses Node filesystem and native packaging commands.
// Build on the target OS/architecture. Reuse upstream's native dependency staging.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { stageRuntimeExternals } from "./build-cli-archive.ts";

const version = process.argv[2];
if (!version || !/^[0-9][0-9A-Za-z.+-]*$/.test(version))
  throw new Error("Pass the release version");
const platform =
  process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported architecture");
const arch = process.arch as "x64" | "arm64";
const root = process.cwd();
const stem = `t3code-lim-${version}-${process.platform}-${arch}`;
const staging = path.join(root, "build", "lim-server");
const dest = path.join(staging, stem);
await fs.rm(dest, { recursive: true, force: true });
await fs.mkdir(dest, { recursive: true });
await Effect.runPromise(
  stageRuntimeExternals({ repoRoot: root, stageDir: dest, platform, arch, version }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
await fs.cp("apps/server/dist", path.join(dest, "dist"), { recursive: true });
execFileSync(
  "cargo",
  ["build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml"],
  { stdio: "inherit" },
);
const monitorName = platform === "win" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
const monitorDir = path.join(dest, "dist/resource-monitor", `${process.platform}-${arch}`);
await fs.mkdir(monitorDir, { recursive: true });
await fs.copyFile(
  path.join("native/resource-monitor/target/release", monitorName),
  path.join(monitorDir, monitorName),
);

await fs.cp("lhc/.sidecar", path.join(dest, "lhc"), { recursive: true, dereference: true });
await fs.mkdir(path.join(dest, "runtime"));
await fs.copyFile(
  process.execPath,
  path.join(dest, "runtime", platform === "win" ? "node.exe" : "node"),
);
await fs.copyFile("LICENSE", path.join(dest, "LICENSE"));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await fs.writeFile(
  path.join(dest, "release.json"),
  JSON.stringify(
    {
      version,
      commit: sha,
      upstream: JSON.parse(await fs.readFile("fork/upstream.json", "utf8")),
      platform: process.platform,
      arch,
      node: process.version,
    },
    null,
    2,
  ) + "\n",
);
await fs.writeFile(
  path.join(dest, "lhc-env.mjs"),
  `import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_LHC_SIDECAR = path.join(root,'lhc/node_modules/claude-lhc/dist/sidecar.js');
`,
);
if (platform === "win") {
  await fs.writeFile(
    path.join(dest, "t3.cmd"),
    '@echo off\r\n"%~dp0runtime\\node.exe" --import "%~dp0lhc-env.mjs" "%~dp0dist\\bin.mjs" %*\r\n',
  );
} else {
  await fs.chmod(path.join(dest, "runtime/node"), 0o755);
  await fs.writeFile(
    path.join(dest, "t3"),
    '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/runtime/node" --import "$root/lhc-env.mjs" "$root/dist/bin.mjs" "$@"\n',
    { mode: 0o755 },
  );
}
await fs.mkdir("release-lim", { recursive: true });
const archive = path.resolve("release-lim", `${stem}.${platform === "win" ? "zip" : "tar.gz"}`);
if (platform === "win") {
  execFileSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/tar.exe"),
    ["-a", "-cf", archive, "-C", staging, stem],
    { stdio: "inherit" },
  );
} else {
  execFileSync("tar", ["-czf", archive, "-C", staging, stem], { stdio: "inherit" });
}
process.stdout.write(`${archive}\n`);
