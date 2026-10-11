// Fork-only (artifacts): one artifact shown with T3's existing viewers
// (PROPOSAL §2.9): chat markdown (mermaid, checkboxes) for markdown, the
// sandboxed, themed HTML render frame for HTML, the browser document frame for
// PDF, the delimited table for CSV, the read-only source view for text, and
// plain media elements for images, video and audio. HTML, PDF and media load
// through a short-lived signed view link (artifactViewer.logic.ts).
import type { LimArtifactSummary } from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { AudioPreview } from "~/components/files/AudioPreview";
import { ReadOnlySourcePreview } from "~/components/files/AttachmentFilePreview";
import { BrowserDocumentFrame, HtmlRenderDocument } from "~/components/files/BrowserDocumentFrame";
import { DelimitedTablePreview } from "~/components/files/DelimitedTablePreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

import { ArtifactsError, createArtifactViewUrl } from "./artifactsClient";
import type { ArtifactsRoute } from "./artifactsRoute.logic";
import {
  artifactViewerKind,
  COPY_LINK_CHOICES,
  VIEWER_LINK_SECONDS,
  viewerLinkStale,
  viewerNeedsLink,
} from "./artifactViewer.logic";

interface ViewerLink {
  readonly url: string;
  readonly revision: string;
  readonly expiresAt: string;
}

/** The viewer's signed link for the artifact's current revision, minted again before it expires. */
function useViewerLink(
  route: ArtifactsRoute,
  artifact: Pick<LimArtifactSummary, "id" | "revision">,
  enabled: boolean,
) {
  const [link, setLink] = useState<ViewerLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When staleness was last judged; a timer moves it on, so a link nearing expiry is re-minted.
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const { id, revision } = artifact;
  useEffect(() => {
    if (!enabled || error !== null || !viewerLinkStale(link, revision, checkedAt)) return;
    let cancelled = false;
    createArtifactViewUrl(route, id, VIEWER_LINK_SECONDS).then(
      (minted) => {
        if (!cancelled) setLink({ url: minted.url, revision, expiresAt: minted.expiresAt });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof ArtifactsError ? cause.message : "couldn't open this artifact");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [checkedAt, enabled, error, id, link, revision, route]);
  useEffect(() => {
    if (!link) return;
    const timer = setInterval(() => setCheckedAt(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [link]);
  return {
    url: link?.revision === revision ? link.url : null,
    error,
    retry: () => {
      setLink(null);
      setCheckedAt(Date.now());
      setError(null);
    },
  };
}

export function ArtifactMarkdown(props: { readonly text: string; readonly className?: string }) {
  return (
    <ChatMarkdown
      text={props.text}
      cwd={undefined}
      className={props.className ?? "mx-auto max-w-4xl px-6 py-5"}
    />
  );
}

export function ArtifactViewer(props: {
  readonly route: ArtifactsRoute;
  readonly artifact: LimArtifactSummary;
  /** The read response's content: markdown's body, or a text file's text. */
  readonly content: string;
}) {
  const { artifact, content } = props;
  const name = artifact.path.split("/").at(-1) ?? artifact.path;
  const kind = artifactViewerKind(artifact);
  // A text file the server didn't send as text (not UTF-8): offer it as a file.
  const unreadable = (kind === "table" || kind === "text") && content === "" && artifact.size > 0;
  const needsLink = viewerNeedsLink(kind) || kind === "none" || unreadable;
  const link = useViewerLink(props.route, artifact, needsLink);

  if (kind === "markdown") {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <ArtifactMarkdown text={content} />
      </ScrollArea>
    );
  }
  if (!unreadable && kind === "table") {
    return (
      <DelimitedTablePreview
        name={name}
        text={content}
        delimiter={filePreviewDelimiter({ name }) ?? ","}
      />
    );
  }
  if (!unreadable && kind === "text") return <ReadOnlySourcePreview name={name} text={content} />;
  if (link.error) return <FileSurfaceFailure message={link.error} onRetry={link.retry} />;
  if (!link.url) return <FileSurfaceLoading />;
  const url = link.url;
  switch (unreadable ? "none" : kind) {
    case "html":
      // Keyed by revision: the frame keeps its first URL, so an edit remounts it.
      return (
        <HtmlRenderDocument
          key={artifact.revision}
          src={url}
          title={artifact.title}
          className="min-h-0 flex-1"
        />
      );
    case "pdf":
      return <BrowserDocumentFrame key={artifact.revision} src={url} title={artifact.title} pdf />;
    case "image":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img src={url} alt={artifact.title} className="max-h-full max-w-full object-contain" />
        </div>
      );
    case "video":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
          <video
            controls
            playsInline
            src={url}
            aria-label={artifact.title}
            className="max-h-full max-w-full"
          />
        </div>
      );
    case "audio":
      return <AudioPreview src={url} name={name} />;
    default:
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm font-medium">No preview for this file</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            download={name}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Download {name}
          </a>
        </div>
      );
  }
}

/**
 * Copies a link minted on click. Where the clipboard takes a promise
 * (ClipboardItem), the copy starts inside the click, as Safari requires;
 * otherwise the link is copied once minted.
 */
async function copyMintedLink(
  mint: () => Promise<string>,
): Promise<{ url: string; copied: boolean }> {
  const minting = mint();
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": minting.then((url) => new Blob([url], { type: "text/plain" })),
        }),
      ]);
      return { url: await minting, copied: true };
    } catch {
      // Fall through: a refused write still leaves the minted link to copy as text.
    }
  }
  const url = await minting;
  const copied = await writeTextToClipboard(url, "link").catch(() => false);
  return { url, copied };
}

/** "Copy link" (24 hours) and "Copy 7-day link": links that open without a T3 login. */
export function ArtifactLinkActions(props: {
  readonly route: ArtifactsRoute;
  readonly artifactId: string;
}) {
  const [busy, setBusy] = useState(false);
  const copy = (choice: (typeof COPY_LINK_CHOICES)[number]) => {
    setBusy(true);
    copyMintedLink(
      async () => (await createArtifactViewUrl(props.route, props.artifactId, choice.seconds)).url,
    )
      .then(({ url, copied }) =>
        toastManager.add(
          copied
            ? {
                type: "success",
                title: "Link copied",
                description: `Opens without a T3 login for ${choice.lasts}.`,
              }
            : {
                type: "info",
                title: "Copy this link",
                description: url,
              },
        ),
      )
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Couldn't make a link",
          description: cause instanceof Error ? cause.message : "Try again.",
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      {COPY_LINK_CHOICES.map((choice) => (
        <Button
          key={choice.seconds}
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => copy(choice)}
        >
          {choice.seconds === COPY_LINK_CHOICES[0].seconds ? <LinkIcon /> : null}
          {choice.label}
        </Button>
      ))}
    </div>
  );
}
