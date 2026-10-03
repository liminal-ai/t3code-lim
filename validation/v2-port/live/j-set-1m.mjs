// Settings on the LHC lane (13977): new threads default to Claude LHC, Sonnet 5.5, 1M context window.
process.env.T3_TEST_LANE = "lhc";
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
await api.rpc("server.updateSettings", {
  patch: {
    defaultModelSelection: {
      instanceId: "claude-lhc",
      model: "claude-sonnet-5-5",
      options: [{ id: "contextWindow", value: "1m" }],
    },
  },
});
const s = await api.rpc("server.getSettings", {});
console.log(
  JSON.stringify({
    defaultModelSelection: s.defaultModelSelection ?? s.settings?.defaultModelSelection,
  }),
);
api.ws.close();
