// Fork-only (artifacts): tests for viewer choice, link lifetimes and upload limits.
import { describe, expect, it } from "vite-plus/test";

import {
  artifactViewerKind,
  COPY_LINK_CHOICES,
  uploadLimitError,
  viewerLinkStale,
  viewerNeedsLink,
} from "./artifactViewer.logic";

const MB = 1024 * 1024;

describe("artifactViewerKind", () => {
  it("picks T3's viewer for each kind of file", () => {
    expect(artifactViewerKind({ kind: "md", path: "t3/backlog.md" })).toBe("markdown");
    expect(artifactViewerKind({ kind: "html", path: "viz/q3.html" })).toBe("html");
    expect(artifactViewerKind({ kind: "other", path: "docs/spec.pdf" })).toBe("pdf");
    expect(artifactViewerKind({ kind: "other", path: "img/Logo.PNG" })).toBe("image");
    expect(artifactViewerKind({ kind: "other", path: "data/q3.csv" })).toBe("table");
    expect(artifactViewerKind({ kind: "other", path: "data/q3.tsv" })).toBe("table");
    expect(artifactViewerKind({ kind: "other", path: "notes.json" })).toBe("text");
    expect(artifactViewerKind({ kind: "other", path: "clip.mp4" })).toBe("video");
    expect(artifactViewerKind({ kind: "other", path: "archive.zip" })).toBe("none");
  });

  it("loads HTML, PDF and media through a view link, and text from the read", () => {
    expect(
      ["html", "pdf", "image", "video", "audio"].every((kind) => viewerNeedsLink(kind as never)),
    ).toBe(true);
    expect(["markdown", "table", "text"].some((kind) => viewerNeedsLink(kind as never))).toBe(
      false,
    );
  });
});

describe("viewerLinkStale", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const link = (expiresAt: string, revision = "r1") => ({ revision, expiresAt });

  it("mints for a new revision, and again shortly before the link expires", () => {
    expect(viewerLinkStale(null, "r1", now)).toBe(true);
    expect(viewerLinkStale(link("2026-10-11T12:59:00Z"), "r1", now)).toBe(false);
    expect(viewerLinkStale(link("2026-10-11T12:59:00Z"), "r2", now)).toBe(true);
    expect(viewerLinkStale(link("2026-10-11T12:09:00Z"), "r1", now)).toBe(true);
  });
});

describe("COPY_LINK_CHOICES", () => {
  it("copies a 24-hour link and an explicit 7-day one", () => {
    expect(COPY_LINK_CHOICES.map((choice) => [choice.label, choice.seconds])).toEqual([
      ["Copy link", 24 * 3600],
      ["Copy 7-day link", 7 * 24 * 3600],
    ]);
  });
});

describe("uploadLimitError", () => {
  it("allows markdown and HTML up to 10 MB and other files up to 50 MB", () => {
    expect(uploadLimitError({ name: "a.md", size: 10 * MB })).toBeNull();
    expect(uploadLimitError({ name: "a.html", size: 10 * MB + 1 })).toMatch(/10 MB/);
    expect(uploadLimitError({ name: "a.png", size: 20 * MB })).toBeNull();
    expect(uploadLimitError({ name: "a.png", size: 50 * MB + 1 })).toMatch(/50 MB/);
  });
});
