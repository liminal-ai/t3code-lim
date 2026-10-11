// Fork-only (artifacts): New list. A title, optional first items (one per
// line), and the threads to attach it to, picked from this environment's
// threads. Lee's lists are kept from the start (PROPOSAL §2.3).
import type { LimArtifactLinkAccess } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useThreadShells } from "~/state/entities";

import { createArtifact } from "./artifactsClient";
import type { ArtifactsRoute } from "./artifactsRoute.logic";
import { attachCandidates, initialListContent } from "./listEditor.logic";

export function NewListDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly route: ArtifactsRoute;
  /** The environment whose store this is; only its threads can be attached. */
  readonly environmentId: string;
  readonly onCreated: (id: string) => void;
}) {
  const threads = useThreadShells(props.open);
  const [title, setTitle] = useState("");
  const [itemsText, setItemsText] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlyMap<string, LimArtifactLinkAccess>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useMemo(
    () => attachCandidates(threads, props.environmentId, query),
    [props.environmentId, query, threads],
  );
  const titles = useMemo(
    () => new Map(threads.map((thread) => [thread.id as string, thread.title])),
    [threads],
  );
  const setPick = (threadId: string, access: LimArtifactLinkAccess | null) =>
    setPicked((current) => {
      const next = new Map(current);
      if (access) next.set(threadId, access);
      else next.delete(threadId);
      return next;
    });

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const content = initialListContent(itemsText);
      const created = await createArtifact(props.route, {
        title: title.trim(),
        ...(content ? { content } : {}),
        attach: [...picked].map(([threadId, access]) => ({ threadId, access })),
      });
      props.onOpenChange(false);
      props.onCreated(created.artifact.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New list</DialogTitle>
          <DialogDescription>
            A checklist you and the attached agents edit item by item. Agents see it in their
            artifact list.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="artifact-list-title">Title</Label>
              <Input
                id="artifact-list-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="artifact-list-items">Items (optional, one per line)</Label>
              <Textarea
                id="artifact-list-items"
                rows={4}
                value={itemsText}
                onChange={(event) => setItemsText(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="artifact-list-attach">Attach to threads</Label>
              {picked.size > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {[...picked].map(([threadId, access]) => (
                    <li
                      key={threadId}
                      className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-0.5 pl-2 text-xs"
                    >
                      <span className="max-w-48 truncate">{titles.get(threadId) ?? threadId}</span>
                      <button
                        type="button"
                        className="rounded px-1 text-muted-foreground hover:text-foreground"
                        aria-label={`Access for ${titles.get(threadId) ?? threadId}: ${access}. Switch`}
                        onClick={() => setPick(threadId, access === "write" ? "read" : "write")}
                      >
                        · {access}
                      </button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Don't attach ${titles.get(threadId) ?? threadId}`}
                        onClick={() => setPick(threadId, null)}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Input
                id="artifact-list-attach"
                type="search"
                size="compact"
                placeholder="Find a thread"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="grid max-h-48 gap-1 overflow-y-auto">
                {candidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No threads match.</p>
                ) : (
                  candidates.map((thread) => (
                    <label
                      key={thread.id}
                      className="flex cursor-pointer items-center gap-2 text-sm select-none"
                    >
                      <Checkbox
                        checked={picked.has(thread.id)}
                        onCheckedChange={(value) => setPick(thread.id, value ? "write" : null)}
                      />
                      <span className="truncate">{thread.title}</span>
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Attached threads can edit the list; switch one to read to let it only read.
              </p>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!title.trim() || busy}>
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
