// Fork-only (artifacts): the dev proxy forwards signed view links (`/a/<token>`)
// without catching `/artifacts` or `/assets`.
import { describe, expect, it } from "vite-plus/test";

import { devProxyKey, isDevProxiedPath } from "./devProxy.ts";

describe("dev proxy for view links", () => {
  it("forwards /a/<token> and nothing else starting with /a", () => {
    expect(isDevProxiedPath("/a/abc.def")).toBe(true);
    expect(isDevProxiedPath("/artifacts")).toBe(false);
    expect(isDevProxiedPath("/assets/index.js")).toBe(false);
  });

  it("gives /a a Vite key that needs the slash", () => {
    const key = new RegExp(devProxyKey("/a"));
    expect(key.test("/a/abc.def")).toBe(true);
    expect(key.test("/artifacts")).toBe(false);
    expect(key.test("/assets/index.js")).toBe(false);
    expect(devProxyKey("/api")).toBe("/api");
  });
});
