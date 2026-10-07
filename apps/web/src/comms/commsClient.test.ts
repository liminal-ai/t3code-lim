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
});
