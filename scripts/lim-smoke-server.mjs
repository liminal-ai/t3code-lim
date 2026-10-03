// Exercise the extracted artifact, not the checkout or build directory.
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
const archive = path.resolve(process.argv[2]);
// Windows TEMP may use an 8.3 alias; fs.watch needs the canonical directory.
const temp = await realpath(await mkdtemp(path.join(tmpdir(), "t3-lim-smoke-")));
let child;
try {
  execFileSync(
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/tar.exe")
      : "tar",
    ["-xf", archive, "-C", temp],
  );
  const [name] = await readdir(temp);
  const root = path.join(temp, name);
  const node = path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const launcher = path.join(root, "dist/bin.mjs");
  const preload = path.join(root, "lhc-env.cjs");
  const meta = JSON.parse(await readFile(path.join(root, "release.json"), "utf8"));
  const output = execFileSync(node, ["--require", preload, launcher, "--version"], {
    cwd: temp,
    encoding: "utf8",
  });
  if (!output.includes(meta.version)) throw new Error(`Version mismatch: ${output}`);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  child = spawn(
    node,
    [
      "--require",
      preload,
      launcher,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      path.join(temp, "state"),
      "--no-browser",
    ],
    { cwd: temp, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (x) => (log += x));
  child.stderr.on("data", (x) => (log += x));
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok && (await response.text()).includes("<html")) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`Server did not become ready: ${log}`);
  console.log(`PASS extracted ${meta.platform}/${meta.arch}: ${meta.version}, web HTTP 200`);
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  await rm(temp, { recursive: true, force: true });
}
