import fs from "node:fs";
import { api, projection, OUT } from "./lib.mjs";
const { threadId } = JSON.parse(fs.readFileSync(OUT + "ids.json", "utf8"));
const p = await projection(threadId);
for (const r of p.runs.slice(-6))
  console.log(
    "run",
    JSON.stringify({
      id: r.id.split(":").at(-1),
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.completedAt ?? r.endedAt,
      keys: Object.keys(r),
    }).slice(0, 400),
  );
for (const m of p.messages.slice(-10))
  console.log(
    "msg",
    m.role,
    JSON.stringify(m.text ?? "").slice(0, 120),
    m.runId?.split(":").at(-1) ?? "",
  );
console.log("thread keys", Object.keys(p).join(","));
api.ws.close();
