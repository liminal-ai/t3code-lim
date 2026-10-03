process.env.T3_TEST_LANE = "lhc";
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
const s = await api.rpc("server.getSettings", {});
console.log(
  JSON.stringify({
    defaultModelSelection: s.defaultModelSelection ?? s.settings?.defaultModelSelection ?? null,
  }),
);
api.ws.close();
