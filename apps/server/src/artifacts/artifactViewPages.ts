// Fork-only (artifacts): what `/a/<token>` sends for each kind (PROPOSAL §2.7,
// §2.13). The page is opened without a T3 session, on T3's own origin, so
// everything but a PDF is sandboxed by CSP into an opaque origin: agent HTML
// runs its scripts there and can't read T3's cookies or call T3 as Lee.
//
// - HTML: the document with the app theme bootstrap (as html_render pages
//   get), under `sandbox allow-scripts allow-popups`.
// - Markdown: rendered here to a standalone page in the T3 theme, light or
//   dark with the reader's system; sanitized as chat markdown is, no scripts,
//   and list items without their `^id` markers.
// - Other files: their own content type, sandboxed too (an SVG or XML file
//   can't script); a PDF only isn't, since the browser's PDF viewer needs an
//   unsandboxed page and a PDF runs no scripts there.
import { htmlRenderTheme, injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { limArtifactMarkdownTree } from "@t3tools/shared/limArtifactMarkdown";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "@t3tools/shared/themePalettes";
import * as Option from "effect/Option";
import * as Mime from "effect/http/Mime";
import { toHtml } from "hast-util-to-html";

import { withoutItemIds } from "./listOps.ts";

export const VIEW_HTML_CSP = "sandbox allow-scripts allow-popups";
/** Markdown pages run nothing and load only images. */
export const VIEW_MARKDOWN_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https: data:";
/** As the asset route serves SVG. */
const VIEW_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export const VIEW_FILE_CSP = "sandbox";

/** Headers every view response carries: the token in the URL never leaks as a referrer. */
const COMMON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export interface ViewResponse {
  readonly body: string | Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const rootRule = (variables: Readonly<Record<string, string>>, appearance: string) =>
  `:root{color-scheme:${appearance};${Object.entries(variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("")}}`;

const dark = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
const light = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");

const MARKDOWN_CSS = [
  rootRule(dark.variables, "dark"),
  `@media (prefers-color-scheme: light){${rootRule(light.variables, "light")}}`,
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:15px;line-height:1.6;-webkit-text-size-adjust:100%}",
  "body{margin:0}main{box-sizing:border-box;max-width:56rem;margin:0 auto;padding:2rem 1.5rem 4rem;overflow-wrap:anywhere}",
  "h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:1.75em}h2{font-size:1.4em;padding-bottom:.25em;border-bottom:1px solid var(--border)}h3{font-size:1.15em}",
  "a{color:var(--accent)}p,ul,ol,pre,table,blockquote{margin:0 0 1em}",
  "code,kbd,pre{font-family:var(--font-mono);font-size:.9em}",
  ":not(pre)>code{background:var(--code-background);color:var(--code-foreground);padding:.1em .35em;border-radius:.3em}",
  "pre{background:var(--code-background);color:var(--code-foreground);padding:.9em 1em;border-radius:var(--radius);overflow:auto}",
  "blockquote{border-left:3px solid var(--border);padding-left:1em;color:var(--muted-foreground)}",
  "table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--border);padding:.35em .7em;text-align:left}th{background:var(--muted)}",
  "img{max-width:100%}hr{border:0;border-top:1px solid var(--border);margin:2em 0}",
  "li.task-list-item{list-style:none}li.task-list-item input{margin:0 .5em 0 -1.4em}",
  ".t3-artifact-title{color:var(--muted-foreground);font-size:.8em;margin:0 0 1.5rem}",
].join("");

/** A markdown artifact as a standalone page. */
export const markdownPage = (title: string, markdown: string) => {
  const html = toHtml(limArtifactMarkdownTree(markdown) as Parameters<typeof toHtml>[0]);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${MARKDOWN_CSS}</style>`,
    "</head><body><main>",
    `<p class="t3-artifact-title">${escapeHtml(title)}</p>`,
    html,
    "</main></body></html>",
  ].join("");
};

/** The content type of an other file, by its extension. */
export const fileContentType = (path: string) => {
  const type = Option.getOrElse(Mime.getType(path), () => "application/octet-stream");
  return /^text\/|\/(json|javascript|xml)$|\+(json|xml)$/i.test(type)
    ? `${type}; charset=utf-8`
    : type;
};

/**
 * One byte range from a `Range` header, for media seeking: `bytes=a-b`,
 * `bytes=a-` or `bytes=-n`. `null` serves the whole file (no header, another
 * unit, or several ranges); `"unsatisfiable"` is a 416.
 */
export const byteRange = (
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | "unsatisfiable" | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
};

/** The response `/a/<token>` sends for an artifact's content (see `ArtifactStore.view`). */
export const viewResponse = (
  artifact: {
    readonly kind: "md" | "html" | "other";
    readonly path: string;
    readonly title: string;
  },
  content: string | Uint8Array,
): ViewResponse => {
  if (artifact.kind === "html") {
    return {
      body: injectHtmlRenderBootstrap(String(content)),
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": VIEW_HTML_CSP,
      },
    };
  }
  if (artifact.kind === "md") {
    return {
      body: markdownPage(artifact.title, withoutItemIds(String(content))),
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": VIEW_MARKDOWN_CSP,
      },
    };
  }
  const type = fileContentType(artifact.path);
  const essence = type.split(";", 1)[0]!.trim().toLowerCase();
  return {
    body: content,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": type,
      ...(essence === "application/pdf"
        ? {}
        : {
            "Content-Security-Policy": essence === "image/svg+xml" ? VIEW_SVG_CSP : VIEW_FILE_CSP,
          }),
    },
  };
};
