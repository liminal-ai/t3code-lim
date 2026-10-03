// Re-pin 2632: automatic compaction with reads one at a time (no parallel batch), on a fresh thread.
import fs from "node:fs";
import * as L from "../live/lib.mjs";
const OUT = new URL(".", import.meta.url).pathname;
const log = (rec) => {
  const l = JSON.stringify({ at: new Date().toISOString(), ...rec });
  fs.appendFileSync(OUT + "auto-compact-sequential.jsonl", l + "\n");
  console.log(l);
};
const { projectId } = JSON.parse(
  fs.readFileSync(new URL("../live/ids.json", import.meta.url), "utf8"),
);
const threadId = await L.newThread(projectId, "LHC V2 re-pin 2632, sequential reads");
await L.send(
  threadId,
  "Do not use tools. Remember this phrase exactly: saffron quarry 2287. Reply with exactly: saffron quarry 2287",
);
let p = await L.waitDone(threadId);
log({ step: "plant", threadId, run: p.runs.at(-1).status });
const files = Array.from(
  { length: 10 },
  (_, i) => `fill-${String(i + 1).padStart(2, "0")}.txt`,
).join(", ");
await L.send(
  threadId,
  `Read these files completely with the Read tool, strictly one at a time: make exactly one Read call per message, never several tool calls in parallel, and wait for each result before the next. Order: ${files}. Don't summarise them. When all 10 are read, reply with exactly: FILL DONE`,
);
p = await L.waitDone(threadId, 1_200_000);
log({ step: "fill, sequential", run: p.runs.at(-1).status, reply: L.lastText(p).slice(0, 60) });
await L.send(
  threadId,
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.",
);
p = await L.waitDone(threadId);
log({
  step: "recall",
  run: p.runs.at(-1).status,
  reply: L.lastText(p).slice(0, 60),
  pass: L.lastText(p).includes("saffron quarry 2287"),
});
L.api.ws.close();
