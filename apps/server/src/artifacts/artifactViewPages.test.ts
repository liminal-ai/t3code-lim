// Fork-only (artifacts): tests for what view links serve.
import { describe, expect, it } from "vite-plus/test";

import {
  byteRange,
  fileContentType,
  markdownPage,
  VIEW_FILE_CSP,
  VIEW_HTML_CSP,
  VIEW_MARKDOWN_CSP,
  viewResponse,
} from "./artifactViewPages.ts";

const artifact = (kind: "md" | "html" | "other", path: string) => ({
  kind,
  path,
  title: "Doc <1>",
});

describe("markdownPage", () => {
  it("renders GitHub markdown to a themed page, sanitized as chat markdown is", () => {
    const page = markdownPage(
      "Doc <1>",
      [
        "# Heading",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "- [x] done",
        "",
        "```mermaid",
        "graph TD; A-->B",
        "```",
        "",
        '<script>alert("x")</script><img src="x" onerror="alert(1)">',
        "",
        "[js](javascript:alert(1))",
      ].join("\n"),
    );
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain("<title>Doc &lt;1&gt;</title>");
    expect(page).toContain("<h1>Heading</h1>");
    expect(page).toContain("<table>");
    expect(page).toContain('type="checkbox"');
    expect(page).toContain("graph TD; A-->B");
    // Light and dark from the reader's system, in T3's palette.
    expect(page).toContain("@media (prefers-color-scheme: light)");
    expect(page).toContain("--background:");
    expect(page).not.toContain("<script");
    expect(page).not.toContain("onerror");
    expect(page).not.toContain("javascript:");
  });
});

describe("viewResponse", () => {
  it("sandboxes HTML with scripts and popups only, and gives it the theme bootstrap", () => {
    const { body, headers } = viewResponse(
      artifact("html", "a.html"),
      "<!doctype html><html><head><title>x</title></head><body><script>1</script></body></html>",
    );
    expect(headers["Content-Security-Policy"]).toBe(VIEW_HTML_CSP);
    expect(VIEW_HTML_CSP).toBe("sandbox allow-scripts allow-popups");
    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(String(body)).toContain('<style id="t3-theme">');
    expect(String(body)).toContain("<script>1</script>");
  });

  it("serves markdown as a page that runs nothing, without list item ids", () => {
    const { body, headers } = viewResponse(
      artifact("md", "a.md"),
      "# x\n\n- [x] shipped ^l8\n- [ ] next ^6v\n\n```\n- [ ] in code ^zz\n```\n",
    );
    expect(String(body)).toContain("shipped</li>");
    expect(String(body)).not.toContain("^l8");
    expect(String(body)).not.toContain("^6v");
    expect(String(body)).toContain("- [ ] in code ^zz");
    expect(headers["Content-Security-Policy"]).toBe(VIEW_MARKDOWN_CSP);
    expect(VIEW_MARKDOWN_CSP).toMatch(/^sandbox;/);
    expect(VIEW_MARKDOWN_CSP).not.toContain("allow-scripts");
  });

  it("serves other files with their content type, sandboxed except a PDF", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const png = viewResponse(artifact("other", "a.png"), bytes);
    expect(png.body).toBe(bytes);
    expect(png.headers["Content-Type"]).toBe("image/png");
    expect(png.headers["Content-Security-Policy"]).toBe(VIEW_FILE_CSP);
    const pdf = viewResponse(artifact("other", "a.pdf"), bytes);
    expect(pdf.headers["Content-Type"]).toBe("application/pdf");
    expect(pdf.headers["Content-Security-Policy"]).toBeUndefined();
    const svg = viewResponse(artifact("other", "a.svg"), bytes);
    expect(svg.headers["Content-Security-Policy"]).toContain("sandbox");
    expect(svg.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(
      viewResponse(artifact("other", "a.xhtml"), bytes).headers["Content-Security-Policy"],
    ).toBe(VIEW_FILE_CSP);
    expect(fileContentType("data.csv")).toBe("text/csv; charset=utf-8");
    expect(fileContentType("blob.unknownext")).toBe("application/octet-stream");
  });

  it("never sends the token on as a referrer, or lets it be cached", () => {
    for (const kind of ["md", "html", "other"] as const) {
      const { headers } = viewResponse(artifact(kind, `a.${kind === "other" ? "pdf" : kind}`), "x");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["Cache-Control"]).toBe("private, no-store");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });
});

describe("byteRange", () => {
  it("reads one range, open-ended or a suffix, clamped to the file", () => {
    expect(byteRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(byteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
  });

  it("serves the whole file for no header, another unit or several ranges; 416 past the end", () => {
    expect(byteRange(undefined, 10)).toBeNull();
    expect(byteRange("items=0-1", 10)).toBeNull();
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(byteRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 10)).toBe("unsatisfiable");
  });
});
