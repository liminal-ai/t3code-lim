// E: recovery. (1) The sidecar is killed (SIGKILL) mid-turn: the run must end failed, not hang;
// the next turn starts a new sidecar and still recalls the phrase. (2) An interrupt ends a run
// as interrupted and the thread carries on. (3) Forking an LHC thread is refused.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { api, log, send, waitDone, lastText, OUT, projection } from "./lib.mjs";
const { threadId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
const pids = () => {
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
const waitRunning = async () => {
  for (let i = 0; i < 120; i++) {
    const r = (await projection(threadId)).runs.at(-1);
    if (r && r.status === "running") return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("run never started");
};

// (1) kill mid-turn
await send(
  threadId,
  "Run this shell command once with your shell tool, in the foreground: sleep 45; echo SLEPT. Then reply with its output.",
);
const run = await waitRunning();
await new Promise((r) => setTimeout(r, 8000));
const before = pids();
for (const pid of before) execFileSync("kill", ["-KILL", pid]);
log("e-recovery.jsonl", { step: "sidecar killed mid-turn", runId: run.id, killed: before });
let p = await waitDone(threadId, 300_000);
log("e-recovery.jsonl", {
  step: "run after kill",
  status: p.runs.at(-1).status,
  error: p.runs.at(-1).error ?? p.runs.at(-1).failure ?? null,
});
await send(
  threadId,
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.",
);
p = await waitDone(threadId);
log("e-recovery.jsonl", {
  step: "next turn after kill",
  status: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 200),
  pass: lastText(p).includes("amber lantern 3071"),
  newSidecar: pids(),
});

// (2) interrupt
await send(threadId, "Do not use tools. Write 300 numbered arithmetic examples, one per line.");
const r2 = await waitRunning();
await api.rpc("orchestration.dispatchCommand", {
  type: "run.interrupt",
  commandId: randomUUID(),
  threadId,
  runId: r2.id,
  holdQueue: true,
  reason: "LHC V2 recovery check",
});
p = await waitDone(threadId);
log("e-recovery.jsonl", { step: "interrupt", status: p.runs.at(-1).status });
await send(threadId, "Do not use tools. Reply with exactly: AFTER INTERRUPT");
p = await waitDone(threadId);
log("e-recovery.jsonl", {
  step: "turn after interrupt",
  status: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 100),
});

// (3) fork refused
const child = randomUUID();
let forkResult;
try {
  forkResult = await api.rpc("orchestration.dispatchCommand", {
    type: "thread.fork",
    commandId: randomUUID(),
    sourceThreadId: threadId,
    targetThreadId: child,
    sourcePoint: { type: "latest_stable" },
    title: "LHC fork attempt",
    createdBy: "user",
    creationSource: "web",
  });
  await new Promise((r) => setTimeout(r, 5000));
  let cp;
  try {
    cp = await projection(child);
  } catch (e) {
    cp = { error: String(e).slice(0, 300) };
  }
  log("e-recovery.jsonl", {
    step: "fork attempt",
    dispatched: forkResult,
    child: cp.error ?? {
      runs: cp.runs?.map((r) => r.status),
      messages: cp.messages?.length,
      state: cp.thread?.status ?? null,
    },
  });
} catch (e) {
  log("e-recovery.jsonl", {
    step: "fork attempt refused at dispatch",
    error: String(e).slice(0, 400),
  });
}
api.ws.close();
