// Adds the claude-lhc instance on 13977 (defaults: trigger 380000, view 150000), as Settings would.
process.env.T3_TEST_LANE = "lhc";
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
const result = await api.rpc("server.updateSettings", {
  patch: {},
  providerInstanceMutation: {
    operation: "create",
    instanceId: "claude-lhc",
    instance: { driver: "claude-lhc", displayName: "Claude LHC", config: {} },
  },
});
console.log(
  JSON.stringify(
    result.providerInstances?.["claude-lhc"] ??
      result.settings?.providerInstances?.["claude-lhc"] ??
      Object.keys(result),
  ),
);
api.ws.close();
