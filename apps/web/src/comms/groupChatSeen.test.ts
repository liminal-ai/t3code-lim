import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("group chat seen state", { concurrent: false }, () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
    vi.resetModules();
  });

  it("keeps what the page has seen when storage refuses writes", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        },
      },
    });
    const { markGroupChatSeen, readGroupChatSeen } = await import("./groupChatSeen");
    markGroupChatSeen("c1", 7);
    expect(readGroupChatSeen("c1")).toBe(7);
  });
});
