// Fork-only (artifacts): the Artifacts page behind the sidebar's Artifacts
// button (PROPOSAL §2.9, v0). Its header names the environment and store it
// shows; below are the store's artifacts and the open one, side by side on wide
// screens and as separate views on narrow ones. One change stream per store
// keeps both current.
import type { LimArtifactSummary } from "@t3tools/contracts";
import { FileTextIcon, ListChecksIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { artifactListView } from "./artifactList.logic";
import { artifactsRouteKey, displayStorePath } from "./artifactsRoute.logic";
import type { ArtifactWatchStatus } from "./artifactsWatch.logic";
import { ArtifactDetail } from "./ListEditor";
import { NewListDialog } from "./NewListDialog";
import { useArtifactList, useArtifactsEnvironment, useArtifactsWatch } from "./useArtifacts";

const STATUS_LABEL: Record<ArtifactWatchStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  retrying: "Reconnecting",
  failed: "Not live",
};

export function ArtifactsPage(props: {
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
}) {
  const environment = useArtifactsEnvironment();
  const selected = environment.selected;
  const route = selected?.route ?? null;
  const list = useArtifactList(route);
  const watch = useArtifactsWatch(route);
  const [creating, setCreating] = useState(false);
  const { refetch } = list;
  // Any change may add, retitle or reorder artifacts; reads are coalesced.
  useEffect(() => watch.hub.subscribe(() => refetch()), [refetch, watch.hub]);

  const store = list.data?.store;
  const storePath = store ? displayStorePath(store.storeDir) : null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto gap-3 py-2">
          <h1 className="shrink-0 text-sm font-medium">Artifacts</h1>
          {environment.options.length > 1 && selected ? (
            <Select
              value={selected.id}
              onValueChange={(value) => {
                if (typeof value !== "string" || value === selected.id) return;
                environment.choose(value);
                // The open artifact belongs to the other store.
                props.onSelect(undefined);
              }}
            >
              <SelectTrigger size="sm" aria-label="Environment" className="w-auto shrink-0">
                <SelectValue>{selected.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environment.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {store ? (
            <span
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
              data-testid="artifacts-store"
            >
              {store.environmentName} · {storePath}
            </span>
          ) : null}
          <div className="flex-1" />
          {route ? (
            <span
              className={cn(
                "hidden shrink-0 text-2xs sm:inline",
                watch.status === "live" ? "text-muted-foreground" : "text-warning",
              )}
            >
              {STATUS_LABEL[watch.status]}
              {watch.status === "failed" && watch.error ? `: ${watch.error.message}` : ""}
            </span>
          ) : null}
          <Button size="compact" disabled={!route} onClick={() => setCreating(true)}>
            <PlusIcon /> New list
          </Button>
        </WorkspacePageHeader>
        {!selected ? (
          <p className="p-6 text-sm text-muted-foreground">
            No connected T3 server can show its artifacts here.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 border-t border-border">
            <div
              className={cn(
                "min-h-0 w-full flex-col md:flex md:w-80 md:shrink-0 md:border-r md:border-border",
                props.selectedId ? "hidden" : "flex",
              )}
            >
              <ArtifactList
                artifacts={list.data?.artifacts}
                error={list.error}
                selectedId={props.selectedId}
                onSelect={props.onSelect}
              />
            </div>
            <div
              className={cn(
                "min-h-0 min-w-0 flex-1 flex-col",
                props.selectedId ? "flex" : "hidden md:flex",
              )}
            >
              {props.selectedId ? (
                <ArtifactDetail
                  // A new store or artifact starts from a fresh editor.
                  key={`${artifactsRouteKey(selected.route)}\u0000${props.selectedId}`}
                  route={selected.route}
                  environmentId={selected.id}
                  artifactId={props.selectedId}
                  hub={watch.hub}
                  onBack={() => props.onSelect(undefined)}
                />
              ) : (
                <p className="p-6 text-sm text-muted-foreground">
                  Pick an artifact, or make a new list.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      {creating && selected ? (
        <NewListDialog
          // A new environment's threads are different: remount, dropping the picks.
          key={selected.id}
          open
          onOpenChange={setCreating}
          route={selected.route}
          environmentId={selected.id}
          onCreated={(id) => {
            refetch();
            props.onSelect(id);
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

function ArtifactList(props: {
  readonly artifacts: ReadonlyArray<LimArtifactSummary> | undefined;
  readonly error: Error | undefined;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const view = artifactListView(props.artifacts, props.error);
  if (view.kind === "error") {
    return <p className="p-6 text-sm text-destructive">{view.message}</p>;
  }
  if (view.kind === "loading") {
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }
  return (
    <>
      {view.warning ? (
        <p className="px-4 py-2 text-2xs text-warning" role="status">
          {view.warning}
        </p>
      ) : null}
      {view.artifacts.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No artifacts in this store yet.</p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <ul aria-label="Artifacts">
          {view.artifacts.map((artifact) => {
            const Icon = artifact.kind === "md" ? ListChecksIcon : FileTextIcon;
            return (
              <li key={artifact.id}>
                <button
                  type="button"
                  aria-current={artifact.id === props.selectedId ? "true" : undefined}
                  className={cn(
                    "flex w-full items-start gap-2.5 border-b border-border px-4 py-2.5 text-left text-sm hover:bg-accent/50",
                    artifact.id === props.selectedId && "bg-accent",
                  )}
                  onClick={() => props.onSelect(artifact.id)}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{artifact.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {artifact.path}
                      {artifact.links.length
                        ? ` · ${artifact.links.length} thread${artifact.links.length === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {formatRelativeTimeLabel(artifact.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </>
  );
}
