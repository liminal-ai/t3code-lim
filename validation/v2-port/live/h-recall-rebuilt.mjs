// After the web rebuild and restart: the LHC thread still recalls its planted phrase.
import fs from "node:fs";
import { api, log, send, waitDone, lastText, OUT } from "./lib.mjs";
const { threadId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
await send(
  threadId,
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.",
);
const p = await waitDone(threadId);
log("h-recall-rebuilt.jsonl", {
  step: "recall on the rebuilt server",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 100),
  pass: lastText(p).includes("amber lantern 3071"),
});
api.ws.close();
