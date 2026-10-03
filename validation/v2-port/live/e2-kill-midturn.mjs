// E (redo): the sidecar is killed while a run is streaming (a long reply, no tools). The run must
// end (failed or interrupted), not hang or report a normal completion; the next turn recovers.
// Also inspects the fork attempt's child thread.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
const before = (await projection(threadId)).runs.length;
await send(
  threadId,
  "Do not use tools. Write 400 numbered lines, each a different short fact about rivers.",
);
let run;
for (let i = 0; i < 120 && !run; i++) {
  const p = await projection(threadId);
  const r = p.runs.at(-1);
  if (p.runs.length > before && r.status === "running") run = r;
  else await new Promise((res) => setTimeout(res, 250));
}
await new Promise((r) => setTimeout(r, 4000));
const streamingText = (await projection(threadId)).messages
  .filter((m) => m.runId === run.id && m.role === "assistant")
  .map((m) => m.text?.length ?? 0);
const killed = pids();
for (const pid of killed) execFileSync("kill", ["-KILL", pid]);
log("e2-kill.jsonl", {
  step: "sidecar killed while streaming",
  run: run.id,
  status: (await projection(threadId)).runs.at(-1).status,
  assistantCharsSoFar: streamingText,
  killed,
});
let p = await waitDone(threadId, 300_000);
const r = p.runs.at(-1);
log("e2-kill.jsonl", {
  step: "run after kill",
  run: r.id,
  status: r.status,
  completedAt: r.completedAt,
  attempt: p.attempts
    .filter((a) => a.runId === r.id)
    .map((a) => ({ status: a.status, error: a.error ?? a.failure ?? a.failureReason ?? null })),
});
await send(
  threadId,
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.",
);
p = await waitDone(threadId);
log("e2-kill.jsonl", {
  step: "next turn after the kill",
  status: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 100),
  pass: lastText(p).includes("amber lantern 3071"),
  newSidecar: pids(),
});
// The fork attempt from e-recovery: what the child looks like.
const children = [];
api.ws.close();
