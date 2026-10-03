// The fill that overflowed at 200k (parallel reads allowed), on a thread with the 1M context window.
import fs from "node:fs";
import * as L from "../live/lib.mjs";
const OUT = new URL(".", import.meta.url).pathname;
const log = (rec) => {
  const l = JSON.stringify({ at: new Date().toISOString(), ...rec });
  fs.appendFileSync(OUT + "fill-1m.jsonl", l + "\n");
  console.log(l);
};
const { projectId } = JSON.parse(
  fs.readFileSync(new URL("../live/ids.json", import.meta.url), "utf8"),
);
const threadId = await L.newThread(projectId, "LHC V2 2632, 1M window");
const sel = (await L.projection(threadId)).thread.modelSelection;
log({ step: "thread", threadId, modelSelection: sel });
await L.send(
  threadId,
  "Do not use tools. Remember this phrase exactly: indigo pebble 4410. Reply with exactly: indigo pebble 4410",
);
let p = await L.waitDone(threadId);
log({ step: "plant", run: p.runs.at(-1).status });
const files = Array.from(
  { length: 10 },
  (_, i) => `fill-${String(i + 1).padStart(2, "0")}.txt`,
).join(", ");
await L.send(
  threadId,
  `Use the Read tool to read each of these files completely, one file per tool call, in order: ${files}. Don't summarise them. When all 10 are read, reply with exactly: FILL DONE`,
);
p = await L.waitDone(threadId, 1_200_000);
log({ step: "fill", run: p.runs.at(-1).status, reply: L.lastText(p).slice(0, 60) });
await L.send(
  threadId,
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.",
);
p = await L.waitDone(threadId);
log({
  step: "recall",
  run: p.runs.at(-1).status,
  reply: L.lastText(p).slice(0, 60),
  pass: L.lastText(p).includes("indigo pebble 4410"),
});
L.api.ws.close();
