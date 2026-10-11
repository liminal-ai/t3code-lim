// Fork-only (artifacts): one artifact on the Artifacts page, with its list
// editor: check, add, inline edit, drag to reorder, remove, and the last change
// per item. State lives in listEditor.logic.ts; this file sends what it queues
// and re-reads when it asks.
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnvironmentId, LimArtifactListItem, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useReducer, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ArtifactsError, applyArtifactOps, readArtifact } from "./artifactsClient";
import type { ArtifactsRoute } from "./artifactsRoute.logic";
import {
  initialListEditorState,
  isTempId,
  lastChangeLabel,
  type ListEditorFailure,
  listEditorReducer,
  moveTarget,
  nextToSend,
  shouldFetch,
  visibleItems,
} from "./listEditor.logic";
import type { ArtifactWatchHub } from "./useArtifacts";

const toFailure = (error: unknown): ListEditorFailure =>
  error instanceof ArtifactsError
    ? { status: error.status, code: error.code, message: error.message }
    : {
        status: 0,
        code: "unknown",
        message: error instanceof Error ? error.message : String(error),
      };

/** Drag handles need a string id; an item without one yet can't be dragged. */
const sortId = (item: LimArtifactListItem, index: number) => item.id ?? `row:${index}`;

export function ArtifactDetail(props: {
  readonly route: ArtifactsRoute;
  readonly environmentId: string;
  readonly artifactId: string;
  readonly hub: ArtifactWatchHub;
  /** Narrow screens show the list and the detail as separate views. */
  readonly onBack: () => void;
}) {
  const { route, artifactId, hub } = props;
  const [state, dispatch] = useReducer(listEditorReducer, initialListEditorState);
  const items = useMemo(() => visibleItems(state), [state]);
  const [adding, setAdding] = useState("");

  useEffect(
    () =>
      hub.subscribe((event) => {
        if (event.type === "resync") dispatch({ type: "resync" });
        else if (event.change.artifactId === artifactId) {
          dispatch({ type: "change", change: event.change });
        }
      }),
    [artifactId, hub],
  );

  useEffect(() => {
    if (!shouldFetch(state)) return;
    const { epoch } = state;
    dispatch({ type: "fetchStarted" });
    readArtifact(route, artifactId).then(
      (read) => dispatch({ type: "fetched", epoch, read }),
      (error: unknown) => dispatch({ type: "fetchFailed", epoch, failure: toFailure(error) }),
    );
  }, [artifactId, route, state]);

  useEffect(() => {
    const next = nextToSend(state);
    if (!next) return;
    dispatch({ type: "sending", key: next.key });
    applyArtifactOps(route, artifactId, [next.op]).then(
      (response) => dispatch({ type: "settled", key: next.key, ...response }),
      (error: unknown) => dispatch({ type: "failed", key: next.key, failure: toFailure(error) }),
    );
  }, [artifactId, route, state]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortIds = items.map(sortId);
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = sortIds.indexOf(String(event.active.id));
    const to = moveTarget(items, from, sortIds.indexOf(String(event.over.id)));
    const id = items[from]?.id;
    if (to && id) dispatch({ type: "enqueue", op: { op: "move", id, to } });
  };

  const add = () => {
    const text = adding.trim();
    if (!text) return;
    dispatch({ type: "enqueue", op: { op: "add", text, at: "bottom" } });
    setAdding("");
  };
  const unassigned = items.some((item) => item.id === null);
  const assignIds = () => {
    // An empty op batch is a T3 write: the server gives every item an id.
    const { epoch } = state;
    applyArtifactOps(route, artifactId, []).then(
      () => dispatch({ type: "resync" }),
      (error: unknown) => dispatch({ type: "fetchFailed", epoch, failure: toFailure(error) }),
    );
  };

  const { artifact } = state;
  if (state.gone) {
    return (
      <DetailFrame onBack={props.onBack}>
        <p className="p-6 text-sm text-muted-foreground">This artifact doesn't exist here.</p>
      </DetailFrame>
    );
  }
  if (!artifact) {
    return (
      <DetailFrame onBack={props.onBack}>
        {state.loadError ? (
          <div className="flex items-center gap-3 p-6 text-sm text-destructive">
            {state.loadError}
            <Button size="xs" variant="outline" onClick={() => dispatch({ type: "resync" })}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        )}
      </DetailFrame>
    );
  }
  const open = items.filter((item) => !item.checked).length;
  // A failed re-read leaves the last list showing, with the reason.
  const notice = state.notice ?? state.loadError;
  return (
    <DetailFrame
      onBack={props.onBack}
      title={artifact.title}
      subtitle={`${artifact.path} · ${items.length ? `${open} open · ` : ""}rev ${artifact.revision.slice(0, 7)}`}
    >
      <LinkChips
        environmentId={props.environmentId}
        threadIds={artifact.links.map((l) => l.threadId)}
      />
      {notice ? (
        <div
          role="status"
          className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-warning/50 bg-warning/8 px-3 py-2 text-xs"
        >
          <span className="flex-1">{notice}</span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Dismiss"
            onClick={() => dispatch({ type: "dismissNotice" })}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {unassigned ? (
        <div className="mx-4 mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          Some items were written outside T3 and have no id yet, so they can't be edited here.
          <Button size="xs" variant="outline" onClick={assignIds}>
            Give them ids
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-6">
          {items.length === 0 && state.content.trim() ? (
            // v0 edits checklist items only; anything else in the file is shown as it is.
            <pre className="mb-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {state.content}
            </pre>
          ) : null}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
              <ul aria-label={`Items of ${artifact.title}`}>
                {items.map((item, index) => (
                  <ListItemRow
                    key={sortId(item, index)}
                    sortId={sortId(item, index)}
                    item={item}
                    onCheck={(checked) =>
                      item.id &&
                      dispatch({
                        type: "enqueue",
                        op: { op: checked ? "check" : "uncheck", id: item.id },
                      })
                    }
                    onEdit={(text) =>
                      item.id &&
                      dispatch({ type: "enqueue", op: { op: "edit", id: item.id, text } })
                    }
                    onRemove={() =>
                      item.id && dispatch({ type: "enqueue", op: { op: "remove", id: item.id } })
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Input
              size="compact"
              aria-label="New item"
              placeholder="Add item"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            />
            <Button type="submit" size="xs" variant="outline" disabled={!adding.trim()}>
              <PlusIcon /> Add
            </Button>
          </form>
        </div>
      </ScrollArea>
    </DetailFrame>
  );
}

function DetailFrame(props: {
  readonly onBack: () => void;
  readonly title?: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to the artifacts"
          className="md:hidden"
          onClick={props.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0">
          {props.title ? <h2 className="truncate text-sm font-medium">{props.title}</h2> : null}
          {props.subtitle ? (
            <p className="truncate font-mono text-2xs text-muted-foreground">{props.subtitle}</p>
          ) : null}
        </div>
      </div>
      {props.children}
    </div>
  );
}

/** The threads an artifact is attached to; each opens its thread. */
function LinkChips(props: {
  readonly environmentId: string;
  readonly threadIds: ReadonlyArray<string>;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells(props.threadIds.length > 0);
  const titles = useMemo(
    () =>
      new Map(
        threads
          .filter((thread) => thread.environmentId === props.environmentId)
          .map((thread) => [thread.id as string, thread.title]),
      ),
    [props.environmentId, threads],
  );
  if (props.threadIds.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2">
      {props.threadIds.map((threadId) => (
        <button
          key={threadId}
          type="button"
          className="max-w-56 truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: {
                environmentId: props.environmentId as EnvironmentId,
                threadId: threadId as ThreadId,
              },
            })
          }
        >
          {titles.get(threadId) ?? "Thread not on this device"}
        </button>
      ))}
    </div>
  );
}

function ListItemRow(props: {
  readonly sortId: string;
  readonly item: LimArtifactListItem;
  readonly onCheck: (checked: boolean) => void;
  readonly onEdit: (text: string) => void;
  readonly onRemove: () => void;
}) {
  const { item } = props;
  const editable = item.id !== null;
  const [draft, setDraft] = useState<string | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.sortId, disabled: !editable });
  const commit = () => {
    const text = draft?.trim();
    setDraft(null);
    if (text && text !== item.text) props.onEdit(text);
  };
  const change = item.lastChange;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 border-b border-border/70 py-1.5 text-sm",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
        isTempId(item.id) && "opacity-60",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={!editable}
        aria-label={`Reorder ${item.text}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <Checkbox
        aria-label={item.checked ? `Uncheck ${item.text}` : `Check ${item.text}`}
        checked={item.checked}
        disabled={!editable}
        onCheckedChange={(value) => props.onCheck(value === true)}
      />
      {draft !== null ? (
        <Input
          size="compact"
          aria-label="Item text"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
      ) : (
        // Narrow screens put the last change under the text.
        <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2">
          <button
            type="button"
            disabled={!editable}
            aria-label={`Edit ${item.text}`}
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              item.checked && "text-muted-foreground line-through",
            )}
            onClick={() => setDraft(item.text)}
          >
            {item.text || "\u00a0"}
          </button>
          {change ? (
            <span className="shrink-0 truncate text-2xs whitespace-nowrap text-muted-foreground">
              {lastChangeLabel(change)} · {formatRelativeTimeLabel(change.at)}
            </span>
          ) : null}
        </div>
      )}
      {editable && draft === null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Remove ${item.text}`}
          onClick={props.onRemove}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}
