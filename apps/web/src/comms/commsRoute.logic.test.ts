import { describe, expect, it } from "vite-plus/test";

import {
  chooseRoute,
  routeEnvironmentId,
  type CommsRoute,
  environmentRoute,
  orderRoutes,
  routeKey,
} from "./commsRoute.logic";

const bearerEnv = (id: string, url = `https://${id}.example:8463`) => ({
  id,
  httpBaseUrl: url,
  authorization: { _tag: "Bearer" as const, token: `${id}-token` },
});

describe("environmentRoute", () => {
  it("uses the environment's base URL and bearer", () => {
    expect(environmentRoute(bearerEnv("staging"), "t3code://app")).toEqual({
      kind: "environment",
      id: "staging",
      baseUrl: "https://staging.example:8463",
      bearer: "staging-token",
    });
  });

  it("skips DPoP (relay) environments, which need a proof per request", () => {
    const env = {
      id: "relay",
      httpBaseUrl: "https://relay.example",
      authorization: { _tag: "Dpop" as const, accessToken: "a", expiresAtEpochMs: 1 },
    };
    expect(environmentRoute(env, "t3code://app")).toBeNull();
  });

  it("uses a cookie session only on the page's own origin", () => {
    const env = { id: "web", httpBaseUrl: "https://host.example:8463/", authorization: null };
    expect(environmentRoute(env, "https://host.example:8463")).toMatchObject({ bearer: null });
    expect(environmentRoute(env, "https://other.example")).toBeNull();
  });
});

describe("orderRoutes", () => {
  it("prefers the active environment, then the primary, then the rest", () => {
    const routes = orderRoutes({
      hasPrimary: true,
      activeId: "prod",
      environments: [bearerEnv("staging"), bearerEnv("prod")],
      pageOrigin: "t3code://app",
    });
    expect(routes.map(routeKey)).toEqual(["environment:prod", "primary", "environment:staging"]);
  });

  it("works without a primary (desktop with its local server off)", () => {
    const routes = orderRoutes({
      hasPrimary: false,
      activeId: null,
      environments: [bearerEnv("staging")],
      pageOrigin: "t3code://app",
    });
    expect(routes.map(routeKey)).toEqual(["environment:staging"]);
  });

  it("drops a disconnected primary while a remote can take over", () => {
    const base = { hasPrimary: true, activeId: null, pageOrigin: "t3code://app" };
    expect(
      orderRoutes({ ...base, primaryConnected: false, environments: [bearerEnv("staging")] }).map(
        routeKey,
      ),
    ).toEqual(["environment:staging"]);
    // Alone, it stays: its connection may still be coming up.
    expect(
      orderRoutes({ ...base, primaryConnected: false, environments: [] }).map(routeKey),
    ).toEqual(["primary"]);
  });

  it("has no candidates when nothing is reachable", () => {
    expect(
      orderRoutes({ hasPrimary: false, activeId: null, environments: [], pageOrigin: null }),
    ).toEqual([]);
  });
});

describe("chooseRoute", () => {
  const routes: CommsRoute[] = [
    { kind: "environment", id: "a", baseUrl: "https://a", bearer: "t" },
    { kind: "primary" },
    { kind: "environment", id: "b", baseUrl: "https://b", bearer: "t" },
  ];

  it("takes the first candidate that serves comms", async () => {
    const answers = {
      "environment:a": "disabled",
      primary: "enabled",
      "environment:b": "enabled",
    } as const;
    const chosen = await chooseRoute(routes, async (route) =>
      answers[routeKey(route) as keyof typeof answers] === "enabled"
        ? { kind: "enabled", config: routeKey(route) }
        : { kind: "disabled" },
    );
    expect(chosen).toEqual({
      route: { kind: "primary" },
      config: "primary",
      retry: false,
      failed: [],
    });
  });

  it("flags a retry when a more-preferred candidate failed transiently", async () => {
    const chosen = await chooseRoute(routes, async (route) =>
      route.kind === "primary" ? { kind: "enabled", config: 1 } : { kind: "failed" },
    );
    expect(chosen.route).toEqual({ kind: "primary" });
    expect(chosen.retry).toBe(true);
    expect(chosen.failed.map(routeKey)).toEqual(["environment:a"]);
  });

  it("reports no route, and no retry, when every candidate definitely lacks comms", async () => {
    expect(await chooseRoute(routes, async () => ({ kind: "disabled" }))).toEqual({
      route: null,
      config: null,
      retry: false,
      failed: [],
    });
  });
});

describe("routeEnvironmentId", () => {
  const remote: CommsRoute = {
    kind: "environment",
    id: "staging",
    baseUrl: "https://s",
    bearer: "t",
  };

  it("acts on the remote environment when comms comes from it", () => {
    expect(routeEnvironmentId({ route: remote, chosen: true }, "local")).toBe("staging");
  });

  it("acts on the primary for the primary route, or before routing has chosen", () => {
    expect(routeEnvironmentId({ route: { kind: "primary" }, chosen: true }, "local")).toBe("local");
    expect(routeEnvironmentId({ route: null, chosen: false }, "local")).toBe("local");
  });

  it("acts on nothing once routing has run and no route is chosen (a remote just dropped)", () => {
    expect(routeEnvironmentId({ route: null, chosen: true }, "local")).toBeNull();
  });
});
