// C: recall of the planted phrase after compaction, then after restarting only the LHC service.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { api, log, send, waitDone, lastText, OUT, reconnect } from "./lib.mjs";
const { threadId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
const ask =
  "Without tools: what phrase did I ask you to remember at the very start of this conversation? Reply with only that phrase.";
await send(threadId, ask);
let p = await waitDone(threadId);
log("c-recall.jsonl", {
  step: "recall after compaction",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 200),
  pass: lastText(p).includes("amber lantern 3071"),
});
api.ws.close();
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
log("c-recall.jsonl", { step: "LHC service restarted" });
await reconnect();
const { api: api2 } = await import("./lib.mjs");
await send(threadId, ask);
p = await waitDone(threadId);
log("c-recall.jsonl", {
  step: "recall after restart",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 200),
  pass: lastText(p).includes("amber lantern 3071"),
});
api2.ws.close();
