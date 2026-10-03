// Re-pin 2632: every Claude-LHC live check on the LHC lane (13977), on a fresh thread.
// The instance keeps its windows from Settings (trigger 100000, view 40000).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as L from "../live/lib.mjs";

const OUT = new URL(".", import.meta.url).pathname;
const log = (rec) => {
  const l = JSON.stringify({ at: new Date().toISOString(), ...rec });
  fs.appendFileSync(OUT + "live-checks.jsonl", l + "\n");
  console.log(l);
};
const PHRASE = "cobalt meadow 6194";
const ASK =
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.";
const sidecarPids = () => {
  try {
    return execFileSync(
      "pgrep",
      ["-f", "/srv/work/t3code-v2-lhc/lhc/.sidecar/node_modules/claude-lhc/dist/sidecar.js"],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
};
const recall = async (threadId, step) => {
  await L.send(threadId, ASK);
  const p = await L.waitDone(threadId);
  log({
    step,
    run: p.runs.at(-1).status,
    reply: L.lastText(p).slice(0, 80),
    pass: L.lastText(p).includes(PHRASE),
  });
};

const { projectId } = JSON.parse(
  fs.readFileSync(new URL("../live/ids.json", import.meta.url), "utf8"),
);
const threadId = await L.newThread(projectId, "LHC V2 re-pin 2632");
fs.writeFileSync(OUT + "thread.json", JSON.stringify({ threadId }, null, 2));

// Plant, then automatic compaction (fill past the 100k trigger), then manual.
await L.send(
  threadId,
  `Do not use tools. Remember this phrase exactly: ${PHRASE}. Reply with exactly: ${PHRASE}`,
);
let p = await L.waitDone(threadId);
log({ step: "plant", threadId, run: p.runs.at(-1).status, reply: L.lastText(p).slice(0, 80) });
const files = Array.from(
  { length: 10 },
  (_, i) => `fill-${String(i + 1).padStart(2, "0")}.txt`,
).join(", ");
await L.send(
  threadId,
  `Use the Read tool to read each of these files completely, one file per tool call, in order: ${files}. Don't summarise them. When all 10 are read, reply with exactly: FILL DONE`,
);
p = await L.waitDone(threadId, 1_200_000);
log({
  step: "fill (automatic compaction)",
  run: p.runs.at(-1).status,
  reply: L.lastText(p).slice(0, 80),
});
await L.send(threadId, "/compact");
p = await L.waitDone(threadId);
log({ step: "manual compaction", run: p.runs.at(-1).status });
await recall(threadId, "recall after compaction");

// Restart only the LHC service.
L.api.ws.close();
execFileSync("systemctl", ["--user", "restart", "t3code-v2-lhc.service"], {
  env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000" },
});
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const r = await fetch("http://127.0.0.1:13977/.well-known/t3/environment", {
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
await L.reconnect();
log({ step: "LHC service restarted" });
await recall(threadId, "recall after restart");

// Sidecar killed while a run streams.
const before = (await L.projection(threadId)).runs.length;
await L.send(
  threadId,
  "Do not use tools. Write 400 numbered lines, each a different short fact about rivers.",
);
let run;
for (let i = 0; i < 120 && !run; i++) {
  const q = await L.projection(threadId);
  if (q.runs.length > before && q.runs.at(-1).status === "running") run = q.runs.at(-1);
  else await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 4000));
const killed = sidecarPids();
for (const pid of killed) execFileSync("kill", ["-KILL", pid]);
p = await L.waitDone(threadId, 300_000);
log({ step: "sidecar killed while streaming", killed, run: p.runs.at(-1).status });
await recall(threadId, "recall after the kill (new sidecar)");
log({ step: "sidecars now", pids: sidecarPids() });

// Interrupt.
const before2 = (await L.projection(threadId)).runs.length;
await L.send(threadId, "Do not use tools. Write 300 numbered arithmetic examples, one per line.");
let r2;
for (let i = 0; i < 120 && !r2; i++) {
  const q = await L.projection(threadId);
  if (q.runs.length > before2 && q.runs.at(-1).status === "running") r2 = q.runs.at(-1);
  else await new Promise((r) => setTimeout(r, 250));
}
await L.api.rpc("orchestration.dispatchCommand", {
  type: "run.interrupt",
  commandId: randomUUID(),
  threadId,
  runId: r2.id,
  holdQueue: true,
  reason: "re-pin check",
});
p = await L.waitDone(threadId);
log({ step: "interrupt", run: p.runs.at(-1).status });
await L.send(threadId, "Do not use tools. Reply with exactly: AFTER INTERRUPT");
p = await L.waitDone(threadId);
log({ step: "turn after interrupt", run: p.runs.at(-1).status, reply: L.lastText(p).slice(0, 40) });

// Fork refused.
const child = randomUUID();
await L.api.rpc("orchestration.dispatchCommand", {
  type: "thread.fork",
  commandId: randomUUID(),
  sourceThreadId: threadId,
  targetThreadId: child,
  sourcePoint: { type: "latest_stable" },
  title: "re-pin fork attempt",
  createdBy: "user",
  creationSource: "web",
});
await L.send(child, ASK);
const cp = await L.waitDone(child, 120_000);
log({ step: "fork attempt: the child's first turn", child, run: cp.runs.at(-1).status });
L.api.ws.close();
