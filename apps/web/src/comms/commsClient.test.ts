import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetDesktopPrimaryAuthForTests } from "~/environments/primary/desktopAuth";

const desktopWindow = (bridge: Partial<DesktopBridge>) => ({
  location: { origin: "t3code://app", href: "t3code://app/" },
  desktopBridge: {
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        bootstrapToken: "desktop-bootstrap-token",
      },
    ],
    getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
    ...bridge,
  } as unknown as DesktopBridge,
});

describe("comms client transport", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the desktop bearer, not cookies, in Electron", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ value: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall } = await import("./commsClient");
    await commsCall("inbox:markRead");
    const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe("http://127.0.0.1:3773/api/comms/call");
    expect(request.credentials).not.toBe("include");
    expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
  });

  it("has no comms, and never fetches, when the desktop's local server is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: desktopWindow({ getLocalEnvironmentEnabled: () => false }),
    });
    const { hasCommsServer } = await import("./commsClient");
    expect(hasCommsServer()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the session cookie for a same-origin browser", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ value: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "http://127.0.0.1:3773", href: "http://127.0.0.1:3773/" } },
    });
    const { commsCall } = await import("./commsClient");
    await commsCall("inbox:markRead");
    const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
    expect(request.credentials).toBe("include");
    expect(request.headers.get("authorization")).toBeNull();
  });

  const enabledConfig = {
    enabled: true,
    testMode: false,
    postAs: "lee",
    homeMachine: "lim-builder",
  };
  const respond = (byUrl: Record<string, number>) =>
    vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const status = Object.entries(byUrl).find(([prefix]) => url.startsWith(prefix))?.[1] ?? 404;
      if (status !== 200) return new Response("{}", { status });
      return new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
        status: 200,
      });
    });
  const staging = {
    id: "staging",
    httpBaseUrl: "https://lim-builder.example:8463",
    authorization: { _tag: "Bearer" as const, token: "staging-bearer" },
  };

  it("uses a connected remote T3 that serves comms when the local server is off", async () => {
    const fetchMock = respond({ "https://lim-builder.example:8463/api/comms/": 200 });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: desktopWindow({ getLocalEnvironmentEnabled: () => false }),
    });
    const { commsCall, hasCommsServer, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    expect(hasCommsServer()).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await commsCall("inbox:markRead");
    const request = new Request(
      fetchMock.mock.calls[1]?.[0] as string,
      fetchMock.mock.calls[1]?.[1],
    );
    expect(request.url).toBe("https://lim-builder.example:8463/api/comms/call");
    expect(request.headers.get("authorization")).toBe("Bearer staging-bearer");
    expect(request.credentials).not.toBe("include");
  });

  it("prefers the active remote over the local server when both serve comms", async () => {
    const fetchMock = respond({
      "https://lim-builder.example:8463/api/comms/": 200,
      "http://127.0.0.1:3773/api/comms/": 200,
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await commsCall("inbox:markRead");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "https://lim-builder.example:8463/api/comms/call",
    );
  });

  it("falls back to the local server when the active remote has no comms", async () => {
    const fetchMock = respond({ "http://127.0.0.1:3773/api/comms/": 200 });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await commsCall("inbox:markRead");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:3773/api/comms/call");
  });

  it("stops using a remote that disconnected, even while the rest are failing", async () => {
    const fetchMock = respond({
      "https://lim-builder.example:8463/api/comms/": 200,
      "http://127.0.0.1:3773/api/comms/": 500,
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // staging is now the route
    setCommsEnvironments({ activeId: null, list: [] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // primary 500
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No T3 serves comms right now: the call is refused rather than sent to the gone remote.
    await expect(commsCall("inbox:markRead")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("moves back to the preferred remote once it recovers", async () => {
    vi.useFakeTimers();
    try {
      let stagingStatus = 500;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        const status = url.startsWith("https://lim-builder.example:8463/") ? stagingStatus : 200;
        if (status !== 200) return new Response("{}", { status });
        return new Response(
          JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }),
          { status: 200 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
      const { commsCall, setCommsEnvironments } = await import("./commsClient");
      setCommsEnvironments({ activeId: "staging", list: [staging] });
      await vi.advanceTimersByTimeAsync(10);
      await commsCall("inbox:markRead");
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:3773/api/comms/call");
      stagingStatus = 200;
      await vi.advanceTimersByTimeAsync(2_100); // the retry after a preferred candidate failed
      await commsCall("inbox:markRead");
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
        "https://lim-builder.example:8463/api/comms/call",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a probe that a newer environment change superseded", async () => {
    let releaseStaging: (() => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://lim-builder.example:8463/api/comms/config") {
        await new Promise<void>((resolve) => (releaseStaging = resolve));
      }
      return new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(releaseStaging).toBeDefined());
    setCommsEnvironments({ activeId: null, list: [] }); // staging disconnected mid-probe
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releaseStaging?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await commsCall("inbox:markRead");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:3773/api/comms/call");
  });

  it("gives up on a stalled probe and falls back to the next candidate", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://lim-builder.example:8463/")) {
          // Never answers; only the abort ends it.
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
            status: 200,
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
      const { commsCall, setCommsEnvironments } = await import("./commsClient");
      setCommsEnvironments({ activeId: "staging", list: [staging] });
      await vi.advanceTimersByTimeAsync(8_100);
      await commsCall("inbox:markRead");
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:3773/api/comms/call");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a route that now says it has no comms, even while another candidate is failing", async () => {
    let stagingStatus = 200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const status = url.startsWith("https://lim-builder.example:8463/") ? stagingStatus : 500;
      if (status !== 200) return new Response("{}", { status });
      return new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // staging is now the route
    stagingStatus = 404; // comms switched off on staging
    setCommsEnvironments({ activeId: null, list: [staging] }); // re-probe: primary 500, staging 404
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(commsCall("inbox:markRead")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // nothing sent to staging
  });

  it("stops calling a disconnected remote at once, while the reprobe is still running", async () => {
    let primaryConfig: (() => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "http://127.0.0.1:3773/api/comms/config" && fetchMock.mock.calls.length > 1) {
        await new Promise<void>((resolve) => (primaryConfig = resolve)); // a slow reprobe
      }
      return new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // staging is now the route
    setCommsEnvironments({ activeId: null, list: [] }); // staging disconnected
    await expect(commsCall("inbox:markRead")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("8463/api/comms/call"))).toBe(
      false,
    );
    primaryConfig?.();
  });

  it("fails over to a connected remote when the selected primary drops", async () => {
    let primaryUp = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:3773/") && !primaryUp)
        throw new TypeError("connection refused");
      return new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: null, list: [staging], primaryConnected: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // primary first
    await new Promise((resolve) => setTimeout(resolve, 0));
    primaryUp = false;
    setCommsEnvironments({ activeId: null, list: [staging], primaryConnected: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // primary skipped, staging serves
    await new Promise((resolve) => setTimeout(resolve, 0));
    await commsCall("inbox:markRead");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "https://lim-builder.example:8463/api/comms/call",
    );
  });

  it("moves calls off a disconnected primary at once, even if its HTTP still answers", async () => {
    const fetchMock = respond({
      "https://lim-builder.example:8463/api/comms/": 200,
      "http://127.0.0.1:3773/api/comms/": 200,
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: null, list: [staging], primaryConnected: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // primary chosen
    await new Promise((resolve) => setTimeout(resolve, 0));
    setCommsEnvironments({ activeId: null, list: [staging], primaryConnected: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // staging probed
    await new Promise((resolve) => setTimeout(resolve, 0));
    await commsCall("inbox:markRead");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "https://lim-builder.example:8463/api/comms/call",
    );
  });

  it("rejects a call whose answer arrives after comms moved to another T3", async () => {
    let answerCall: (() => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://lim-builder.example:8463/api/comms/call") {
        await new Promise<void>((resolve) => (answerCall = resolve));
      }
      return new Response(JSON.stringify(url.endsWith("/config") ? enabledConfig : { value: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", { configurable: true, value: desktopWindow({}) });
    const { commsCall, setCommsEnvironments } = await import("./commsClient");
    setCommsEnvironments({ activeId: "staging", list: [staging] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // staging is now the route
    const pending = commsCall("inbox:markRead");
    await vi.waitFor(() => expect(answerCall).toBeDefined());
    setCommsEnvironments({ activeId: null, list: [] }); // failover to the primary
    answerCall?.();
    await expect(pending).rejects.toMatchObject({ status: 409 });
  });
});
