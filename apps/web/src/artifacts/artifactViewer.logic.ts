// Fork-only (artifacts): which of T3's existing viewers shows an artifact
// (PROPOSAL §2.9), and the lifetimes of its view links (§2.7). Markdown, CSV
// and text come from the read response; HTML, PDF and media load through a
// signed `/a/<token>` link, so they open on any paired device and HTML stays
// sandboxed away from the app.
import {
  LIM_ARTIFACT_MAX_OTHER_BYTES,
  LIM_ARTIFACT_MAX_TEXT_BYTES,
  LIM_ARTIFACT_VIEW_LINK_SECONDS,
  LIM_ARTIFACT_VIEW_MAX_SECONDS,
  LIM_ARTIFACT_VIEW_VIEWER_SECONDS,
  type LimArtifactSummary,
} from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { filePreviewKind } from "@t3tools/shared/filePreview";

export type ArtifactViewerKind =
  | "markdown"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "table"
  | "text"
  | "none";

export function artifactViewerKind(
  artifact: Pick<LimArtifactSummary, "kind" | "path">,
): ArtifactViewerKind {
  if (artifact.kind === "md") return "markdown";
  if (artifact.kind === "html") return "html";
  const name = artifact.path.split("/").at(-1) ?? artifact.path;
  if (filePreviewDelimiter({ name })) return "table";
  const preview = filePreviewKind({ name });
  switch (preview) {
    case "pdf":
    case "image":
    case "video":
    case "audio":
    case "text":
      return preview;
    // An `other` artifact named .md or .html can't happen (the extension picks the kind).
    default:
      return "none";
  }
}

/** Viewers that load the artifact from a view link rather than the read response. */
export const viewerNeedsLink = (kind: ArtifactViewerKind): boolean =>
  kind === "html" || kind === "pdf" || kind === "image" || kind === "video" || kind === "audio";

/**
 * The in-app viewer's link is minted again this long before it expires, so a
 * page left open never reloads from a dead link.
 */
const VIEWER_LINK_MARGIN_MS = 10 * 60 * 1000;

export const VIEWER_LINK_SECONDS = LIM_ARTIFACT_VIEW_VIEWER_SECONDS;

/** Whether the viewer's link for a revision has to be minted (again). */
export function viewerLinkStale(
  link: { readonly revision: string; readonly expiresAt: string } | null,
  revision: string,
  nowMs: number,
): boolean {
  if (link === null || link.revision !== revision) return true;
  return Date.parse(link.expiresAt) - nowMs <= VIEWER_LINK_MARGIN_MS;
}

/** "Copy link" and "Copy 7-day link". */
export const COPY_LINK_CHOICES = [
  { label: "Copy link", seconds: LIM_ARTIFACT_VIEW_LINK_SECONDS, lasts: "24 hours" },
  { label: "Copy 7-day link", seconds: LIM_ARTIFACT_VIEW_MAX_SECONDS, lasts: "7 days" },
] as const;

/**
 * Why a file can't be uploaded, checked before sending it (the server checks
 * too): markdown and HTML up to 10 MB, other files up to 50 MB.
 */
export function uploadLimitError(file: { readonly name: string; readonly size: number }) {
  const text = /\.(md|markdown|html?)$/i.test(file.name);
  const limit = text ? LIM_ARTIFACT_MAX_TEXT_BYTES : LIM_ARTIFACT_MAX_OTHER_BYTES;
  if (file.size <= limit) return null;
  return `${file.name} is over the ${limit / (1024 * 1024)} MB limit for ${text ? "markdown and HTML" : "files"}.`;
}
