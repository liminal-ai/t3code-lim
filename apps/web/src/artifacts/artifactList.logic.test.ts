import type { LimArtifactSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { artifactListView } from "./artifactList.logic";

const artifact = (id: string, updatedAt: string): LimArtifactSummary => ({
  id,
  path: `${id}.md`,
  absolutePath: `/store/${id}.md`,
  title: id,
  kind: "md",
  state: "kept",
  tags: [],
  revision: "r",
  size: 1,
  createdAt: updatedAt,
  updatedAt,
  createdBy: null,
  links: [],
});

describe("artifactListView", () => {
  const failure = new Error("couldn't reach the T3 server");

  it("keeps the last list after a failed re-read, with the error beside it", () => {
    const view = artifactListView(
      [artifact("old", "2026-10-01"), artifact("new", "2026-10-02")],
      failure,
    );
    expect(view).toMatchObject({ kind: "list", warning: "couldn't reach the T3 server" });
    expect(view.kind === "list" && view.artifacts.map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("still says why when the last list was empty", () => {
    expect(artifactListView([], failure)).toMatchObject({ kind: "list", warning: failure.message });
  });

  it("shows the error alone before any list was read, and loading before that", () => {
    expect(artifactListView(undefined, failure)).toEqual({
      kind: "error",
      message: failure.message,
    });
    expect(artifactListView(undefined, undefined)).toEqual({ kind: "loading" });
    expect(artifactListView([], undefined)).toMatchObject({ kind: "list", warning: null });
  });
});
