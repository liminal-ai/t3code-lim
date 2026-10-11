// Fork-only (artifacts): tests for the page's artifacts client.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string, searchParams?: Record<string, string>) => {
    const url = new URL("https://lim-builder.example.ts.net");
    url.pathname = pathname;
    if (searchParams) url.search = new URLSearchParams(searchParams).toString();
    return url.toString();
  },
}));
vi.mock("~/environments/primary/httpLayer", () => ({ isSameOriginBrowserPrimary: () => true }));
vi.mock("~/environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => null,
}));

const { createArtifactViewUrl, uploadArtifact } = await import("./artifactsClient");

const READ = {
  store: { environmentId: "e", environmentName: "lim-builder", storeDir: "/s" },
  artifact: {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    path: "img/a b.png",
    absolutePath: "/s/img/a b.png",
    title: "a b",
    kind: "other",
    state: "kept",
    tags: [],
    revision: "r",
    size: 3,
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    createdBy: null,
    links: [],
  },
  content: "",
  items: [],
};

const stubFetch = (body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifacts client", () => {
  it("uploads a file as the raw body, its name and folder in the query (primary server)", async () => {
    const calls = stubFetch(READ);
    const file = new File([new Uint8Array([1, 2, 3])], "a b.png", { type: "image/png" });
    await uploadArtifact({ kind: "primary" }, file, { folder: "img" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://lim-builder.example.ts.net/api/artifacts?name=a+b.png&folder=img",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(file);
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("image/png");
  });

  it("makes a view link absolute on the server it came from", async () => {
    stubFetch({ url: "/a/abc.def", expiresAt: "2026-10-12T00:00:00.000Z" });
    const primary = await createArtifactViewUrl({ kind: "primary" }, READ.artifact.id, 86400);
    expect(primary.url).toBe("https://lim-builder.example.ts.net/a/abc.def");
    const remote = await createArtifactViewUrl(
      {
        kind: "environment",
        id: "staging",
        baseUrl: "https://staging.example.ts.net/",
        bearer: "t",
      },
      READ.artifact.id,
      86400,
    );
    expect(remote.url).toBe("https://staging.example.ts.net/a/abc.def");
  });
});
