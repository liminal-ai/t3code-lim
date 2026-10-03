// I: after moving the windows into the sidecar seam, a NEW LHC thread compacts at the instance's
// configured windows (trigger 100000, view 40000, set in b-compact.mjs), not the defaults.
import fs from "node:fs";
import { api, log, newThread, send, waitDone, lastText, OUT } from "./lib.mjs";
const { projectId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
const threadId = await newThread(projectId, "LHC V2 windows from settings");
await send(
  threadId,
  "Do not use tools. Remember this phrase exactly: violet harbor 5582. Reply with exactly: violet harbor 5582",
);
let p = await waitDone(threadId);
log("i-windows.jsonl", {
  step: "plant",
  threadId,
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 80),
});
const files = Array.from(
  { length: 7 },
  (_, i) => `fill-${String(i + 1).padStart(2, "0")}.txt`,
).join(", ");
await send(
  threadId,
  `Use the Read tool to read each of these files completely, one file per tool call, in order: ${files}. Don't summarise them. When all 7 are read, reply with exactly: FILL DONE`,
);
p = await waitDone(threadId, 1_200_000);
log("i-windows.jsonl", {
  step: "fill",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 80),
});
await send(
  threadId,
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.",
);
p = await waitDone(threadId);
log("i-windows.jsonl", {
  step: "recall",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 80),
  pass: lastText(p).includes("violet harbor 5582"),
});
api.ws.close();
