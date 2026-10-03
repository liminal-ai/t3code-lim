// Read-only: every project and thread on the LHC lane (13977), from the shell snapshot.
process.env.T3_TEST_LANE = "lhc";
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
const snapshot = await new Promise((resolve, reject) => {
  const id = "inv-" + Date.now();
  const timer = setTimeout(() => reject(new Error("no snapshot")), 20000);
  api.ws.on("message", (b) => {
    const data = JSON.parse(b.toString());
    for (const m of Array.isArray(data) ? data : [data]) {
      if (String(m.requestId) !== id || m._tag !== "Chunk") continue;
      for (const item of m.values ?? [])
        if (item.kind === "snapshot") {
          clearTimeout(timer);
          resolve(item.snapshot);
        }
    }
  });
  api.ws.send(
    JSON.stringify({
      _tag: "Request",
      id,
      tag: "orchestration.subscribeShell",
      payload: {},
      headers: [],
    }),
  );
});
const out = {
  projects: snapshot.projects.map((p) => ({
    id: p.id,
    title: p.title,
    workspaceRoot: p.workspaceRoot,
    deletedAt: p.deletedAt ?? null,
  })),
  threads: snapshot.threads.map((t) => ({
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    instance: t.providerInstanceId ?? t.modelSelection?.instanceId,
    createdBy: t.createdBy,
    creationSource: t.creationSource,
    createdAt: t.createdAt,
    archivedAt: t.archivedAt ?? null,
    deletedAt: t.deletedAt ?? null,
  })),
};
console.log(JSON.stringify(out, null, 1));
api.ws.close();
process.exit(0);
