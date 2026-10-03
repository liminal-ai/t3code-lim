// Shared helpers for the LHC lane (13977) live checks. Auth via the baseline's rpc.mjs.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
process.env.T3_TEST_LANE = "lhc";
export let api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
export const reconnect = async () => {
  try {
    api.ws.close();
  } catch {}
  api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs?r=" + Date.now());
};
export const OUT = new URL(".", import.meta.url).pathname;
export const log = (file, rec) => {
  const l = JSON.stringify({ at: new Date().toISOString(), ...rec });
  fs.appendFileSync(OUT + file, l + "\n");
  console.log(l);
};
export const projection = (threadId) => api.rpc("orchestration.getThreadProjection", { threadId });
export async function waitDone(threadId, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = await projection(threadId);
    const r = p.runs.at(-1);
    if (r && ["completed", "interrupted", "failed", "cancelled"].includes(r.status)) return p;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("run completion timeout " + threadId);
}
export const send = (threadId, text) =>
  api.rpc("orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: randomUUID(),
    threadId,
    messageId: randomUUID(),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
// Sonnet's context window defaults to 200k in T3's model manifest; the checks ask for 1M explicitly.
export async function newThread(
  projectId,
  title,
  instanceId = "claude-lhc",
  model = "claude-sonnet-4-6",
  options = [{ id: "contextWindow", value: "1m" }],
) {
  const threadId = randomUUID();
  await api.rpc("orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    projectId,
    threadId,
    title,
    modelSelection: { instanceId, model, options },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
}
export async function newProject(title, dir) {
  const projectId = randomUUID();
  fs.mkdirSync(dir, { recursive: true });
  await api.rpc("projects.mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title,
    workspaceRoot: dir,
    createWorkspaceRootIfMissing: true,
  });
  return projectId;
}
export const lastText = (p) => p.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
