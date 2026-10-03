// A: a first Claude-LHC turn plants a phrase. Records the thread id for later checks.
import fs from "node:fs";
import { api, log, newProject, newThread, send, waitDone, lastText, OUT } from "./lib.mjs";
const projectId = await newProject(
  "LHC V2 checks",
  "/srv/work/t3code-v2-baseline/lhc/fixture/lhc-v2-checks",
);
const threadId = await newThread(projectId, "LHC V2 recall");
await send(
  threadId,
  "Do not use tools. Remember this phrase exactly: amber lantern 3071. Reply with exactly: amber lantern 3071",
);
const p = await waitDone(threadId);
log("a-plant.jsonl", {
  step: "plant",
  threadId,
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 200),
});
fs.writeFileSync(OUT + "ids.json", JSON.stringify({ projectId, threadId }, null, 2));
api.ws.close();
