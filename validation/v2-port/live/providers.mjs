// Which provider instances the LHC lane (13977) reports. Auth via the baseline's rpc.mjs (private cookie file; nothing printed).
process.env.T3_TEST_LANE = "lhc";
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
const config = await api.rpc("server.getConfig", {});
for (const p of config.providers) {
  console.log(
    JSON.stringify({
      instanceId: p.instanceId,
      driver: p.driver,
      status: p.status,
      installed: p.installed,
      version: p.version,
      message: p.message,
      models: (p.models ?? []).slice(0, 3).map((m) => m.slug),
    }),
  );
}
api.ws.close();
