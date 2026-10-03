// G: forking a Claude-LHC thread. The LHC runner refuses forkSession; record exactly how V2 surfaces that.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { api, log, OUT, projection, send, waitDone } from "./lib.mjs";
const { threadId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
const child = randomUUID();
const res = await api.rpc("orchestration.dispatchCommand", {
  type: "thread.fork",
  commandId: randomUUID(),
  sourceThreadId: threadId,
  targetThreadId: child,
  sourcePoint: { type: "latest_stable" },
  title: "LHC fork attempt 2",
  createdBy: "user",
  creationSource: "web",
});
log("g-fork.jsonl", { step: "fork dispatched", child, res });
await new Promise((r) => setTimeout(r, 6000));
const cp = await projection(child);
log("g-fork.jsonl", {
  step: "child after 6 s",
  thread: {
    status: cp.thread?.status,
    forkedFrom: cp.thread?.forkedFrom ?? cp.thread?.fork ?? null,
    keys: Object.keys(cp.thread ?? {}),
  },
  runs: cp.runs.length,
  messages: cp.messages.length,
  contextTransfers: cp.contextTransfers,
  contextHandoffs: cp.contextHandoffs,
  providerThreads: cp.providerThreads,
});
let sent;
try {
  await send(
    child,
    "Without tools, what phrase was mentioned at the start of this conversation? Reply with only the phrase.",
  );
  sent = "sent";
} catch (e) {
  sent = String(e).slice(0, 400);
}
let after;
try {
  after = await waitDone(child, 120_000);
} catch (e) {
  after = { error: String(e).slice(0, 300) };
}
log("g-fork.jsonl", {
  step: "a turn on the child",
  sent,
  run: after.runs?.at(-1)?.status ?? after.error,
  attempts: after.attempts?.map((a) => ({
    status: a.status,
    ...(a.error ? { error: a.error } : {}),
  })),
  lastMessage: after.messages?.at(-1)?.text?.slice(0, 300) ?? null,
});
api.ws.close();
