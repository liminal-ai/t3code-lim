// Deletes the test threads and projects listed in inventory-before.json, through T3's own commands.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
process.env.T3_TEST_LANE = "lhc";
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
const inv = JSON.parse(
  fs.readFileSync(new URL("./inventory-before.json", import.meta.url), "utf8"),
);
const out = (r) => console.log(JSON.stringify(r));
let threads = 0,
  projects = 0;
for (const t of inv.threads) {
  try {
    await api.rpc("orchestration.dispatchCommand", {
      type: "thread.delete",
      commandId: randomUUID(),
      threadId: t.id,
    });
    threads++;
    out({ deleted: "thread", id: t.id, title: t.title });
  } catch (e) {
    out({ failed: "thread", id: t.id, title: t.title, error: String(e).slice(0, 300) });
  }
}
for (const p of inv.projects) {
  try {
    await api.rpc("projects.mutate", {
      type: "project.delete",
      commandId: randomUUID(),
      projectId: p.id,
    });
    projects++;
    out({ deleted: "project", id: p.id, title: p.title });
  } catch (e) {
    out({ failed: "project", id: p.id, title: p.title, error: String(e).slice(0, 400) });
  }
}
out({ threadsDeleted: threads, projectsDeleted: projects });
api.ws.close();
