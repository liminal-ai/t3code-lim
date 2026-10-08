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
});
