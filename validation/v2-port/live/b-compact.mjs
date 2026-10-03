// B: Claude-LHC compaction on V2. The instance's trigger is set to the minimum (100k, view 40k);
// the thread from A reads 14 fill files (~140k tokens), which must cross the trigger; then a
// manual /compact. The sidecar's own log lines are extracted by the caller.
import fs from "node:fs";
import { api, log, send, waitDone, lastText, OUT, reconnect } from "./lib.mjs";
const { threadId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
await api.rpc("server.updateSettings", {
  patch: {},
  providerInstanceMutation: {
    operation: "upsert",
    instanceId: "claude-lhc",
    instance: {
      driver: "claude-lhc",
      displayName: "Claude LHC",
      config: { autoCompactWindow: "100000", lhcLowerBound: "40000" },
    },
  },
});
log("b-compact.jsonl", { step: "windows set", autoCompactWindow: 100000, lhcLowerBound: 40000 });
await new Promise((r) => setTimeout(r, 5000));
await reconnect();
const files = Array.from(
  { length: 14 },
  (_, i) => `fill-${String(i + 1).padStart(2, "0")}.txt`,
).join(", ");
await send(
  threadId,
  `Use the Read tool to read each of these files completely, one file per tool call, in order: ${files}. Don't summarise them. When all 14 are read, reply with exactly: FILL DONE`,
);
let p = await waitDone(threadId, 1_200_000);
log("b-compact.jsonl", {
  step: "fill",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 200),
});
await send(threadId, "/compact");
p = await waitDone(threadId);
log("b-compact.jsonl", {
  step: "manual compact",
  run: p.runs.at(-1).status,
  reply: lastText(p).slice(0, 200),
});
api.ws.close();
