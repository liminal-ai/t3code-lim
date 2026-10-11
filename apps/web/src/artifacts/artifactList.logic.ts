// Fork-only (artifacts): what the Artifacts page's list column shows, given the
// store's last list and the last read's error.
import type { LimArtifactSummary } from "@t3tools/contracts";

export type ArtifactListView =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loading" }
  | {
      readonly kind: "list";
      /** Newest change first; empty when the store has none. */
      readonly artifacts: ReadonlyArray<LimArtifactSummary>;
      /** A re-read failed: the list shown is the last one read, so say why it may be stale. */
      readonly warning: string | null;
    };

export function artifactListView(
  artifacts: ReadonlyArray<LimArtifactSummary> | undefined,
  error: Error | undefined,
): ArtifactListView {
  if (!artifacts) return error ? { kind: "error", message: error.message } : { kind: "loading" };
  return {
    kind: "list",
    artifacts: artifacts.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    warning: error?.message ?? null,
  };
}
