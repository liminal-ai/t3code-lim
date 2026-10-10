// Fork-only (agent comms): the Comms page behind the sidebar's Comms button.
// Agents (the registry: presence, homes, state, profiles, registering) and
// Group Chats (every group: members, activity, create, membership). Activity
// waits for the comms server's activity:recent query.
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { commsCall, useCommsQuery } from "./commsClient";
import { useCommsConfig, useCommsEnvironmentId } from "./useCommsConfig";
import {
  filterRoster,
  isOwnTestParticipant,
  localThreadId,
  machineSeenMap,
  presenceView,
  sortRoster,
  type PresenceStatus,
} from "./commsAdmin.logic";
import {
  CreateGroupDialog,
  DeleteGroupsDialog,
  EditProfileDialog,
  ManageMembersDialog,
  RegisterAgentDialog,
} from "./CommsDialogs";
import type { ConversationSummary, DirectoryList, RegistryEntry } from "./commsTypes";
import { chatTitle, filterGroupChats } from "./groupChat.logic";

export type CommsTab = "agents" | "groups";

const DOT_CLASS: Record<PresenceStatus, string> = {
  // Static on purpose: no continuously repainting animations (AGENTS.md).
  busy: "bg-info",
  idle: "bg-success",
  offline: "bg-muted-foreground/40",
  stale: "bg-warning",
  paused: "bg-muted-foreground/40",
  retired: "bg-muted-foreground/20",
  person: "bg-primary/60",
  system: "bg-muted-foreground/30",
};

function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function AgentRow(props: {
  readonly entry: RegistryEntry;
  readonly presence: { readonly status: PresenceStatus; readonly label: string };
  readonly threadId: string | null;
  readonly canWrite: boolean;
}) {
  const { entry, presence } = props;
  const navigate = useNavigate();
  const environmentId = useCommsEnvironmentId();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = entry.participant.name;
  const isAgent = entry.participant.kind === "agent";
  const setState = (state: "active" | "paused" | "retired") => {
    // Pause and retire are the disruptive actions taken as the configured poster (e.g. @lee),
    // so both confirm first.
    const question =
      state === "retired"
        ? `Retire @${name}? Retired names stay reserved; there's no undo.`
        : state === "paused"
          ? `Pause @${name}? Messages to @${name} queue until it's resumed.`
          : null;
    if (question && !window.confirm(question)) {
      return;
    }
    setError(null);
    commsCall("directory:setState", { name, state }).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  return (
    <li
      className={cn(
        // Narrow screens stack the cells; wider ones lay them out as columns.
        "grid grid-cols-1 items-start gap-1 border-b border-border px-4 py-2.5 text-sm md:grid-cols-[minmax(10rem,14rem)_minmax(8rem,12rem)_minmax(10rem,1fr)_auto] md:gap-4",
        entry.state === "retired" && "opacity-50",
      )}
      data-testid={`comms-agent-${name}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[presence.status])}
        />
        <span className="truncate font-medium">@{name}</span>
      </div>
      <div className="min-w-0 text-xs text-muted-foreground">
        <div className="truncate">{presence.label}</div>
        {isAgent ? (
          <div className="truncate">
            {entry.harness ?? "?"} · {entry.home?.machine ?? "?"}
            {entry.owner ? ` · @${entry.owner.name}` : ""}
          </div>
        ) : null}
      </div>
      <div className="min-w-0 text-xs">
        <div className="text-foreground/80">{entry.description ?? ""}</div>
        {entry.duties?.length ? (
          <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
            {entry.duties.map((duty) => (
              <li key={duty}>{duty}</li>
            ))}
          </ul>
        ) : null}
        {error ? <div className="text-destructive">{error}</div> : null}
      </div>
      <div className="flex items-center gap-1">
        {props.threadId && environmentId ? (
          <Button
            size="compact"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: props.threadId! },
              })
            }
          >
            Thread
          </Button>
        ) : null}
        {isAgent && props.canWrite ? (
          <>
            <Button size="compact" variant="ghost" onClick={() => setEditing(true)}>
              Profile
            </Button>
            {entry.state === "active" ? (
              <Button size="compact" variant="ghost" onClick={() => setState("paused")}>
                Pause
              </Button>
            ) : entry.state === "paused" ? (
              <Button size="compact" variant="ghost" onClick={() => setState("active")}>
                Resume
              </Button>
            ) : null}
            {entry.state !== "retired" ? (
              <Button size="compact" variant="ghost" onClick={() => setState("retired")}>
                Retire
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {editing ? <EditProfileDialog entry={entry} open onOpenChange={setEditing} /> : null}
    </li>
  );
}

function AgentsTab() {
  const config = useCommsConfig();
  const registry = useCommsQuery<{ agents: ReadonlyArray<RegistryEntry> }>("registry:list");
  const directory = useCommsQuery<DirectoryList>("directory:list");
  const now = useNow();
  const [query, setQuery] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [registering, setRegistering] = useState(false);
  const seen = useMemo(() => machineSeenMap(directory.data), [directory.data]);
  const roster = useMemo(
    () => filterRoster(sortRoster(registry.data?.agents ?? []), { query, showRetired }),
    [query, registry.data, showRetired],
  );
  const testMode = config?.testMode === true;
  const homeMachine = config?.homeMachine ?? null;
  const counts = useMemo(() => {
    const agents = (registry.data?.agents ?? []).filter(
      (e) => e.participant.kind === "agent" && e.state !== "retired",
    );
    const busy = agents.filter((e) => presenceView(e, seen, now).status === "busy").length;
    return { agents: agents.length, busy };
  }, [now, registry.data, seen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <div className="w-full sm:w-64">
          <Input
            type="search"
            aria-label="Search agents"
            placeholder="Search agents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <Switch checked={showRetired} onCheckedChange={setShowRetired} />
          Show retired
        </label>
        <span className="text-xs text-muted-foreground">
          {counts.agents} agents · {counts.busy} working
        </span>
        <div className="flex-1" />
        <Button size="compact" onClick={() => setRegistering(true)}>
          <PlusIcon /> Register agent
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {registry.error ? (
          <p className="p-6 text-sm text-destructive">{registry.error.message}</p>
        ) : !registry.data ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : (
          <ul>
            {roster.map((entry) => (
              <AgentRow
                key={entry.participant.id}
                entry={entry}
                presence={presenceView(entry, seen, now)}
                threadId={localThreadId(entry, homeMachine)}
                canWrite={!testMode || isOwnTestParticipant(entry, config)}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
      {/* Mounted only while open, once the config is known: the form starts from it. */}
      {registering && config ? <RegisterAgentDialog open onOpenChange={setRegistering} /> : null}
    </div>
  );
}

function GroupsTab() {
  const config = useCommsConfig();
  const navigate = useNavigate();
  const { data, error } = useCommsQuery<{ conversations: ReadonlyArray<ConversationSummary> }>(
    "conversations:list",
  );
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const groups = useMemo(
    () => (data?.conversations ?? []).filter((c) => c.kind === "group"),
    [data],
  );
  // Bulk select and delete (Lee, 2026-10-09; Mira #262), ported from Tess's
  // tess/archive-group-chats. Only rows on screen count: the filter never acts
  // on hidden ones.
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const canDelete = Boolean(config?.postAs);
  const shown = useMemo(() => filterGroupChats(groups, query), [groups, query]);
  const picked = shown.filter((group) => selected.has(group.id));
  const setPicked = (ids: ReadonlyArray<string>, value: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        {canDelete ? (
          <Checkbox
            aria-label="Select every group chat shown"
            checked={shown.length > 0 && picked.length === shown.length}
            indeterminate={picked.length > 0 && picked.length < shown.length}
            disabled={shown.length === 0}
            onCheckedChange={(value) =>
              setPicked(
                shown.map((group) => group.id),
                value === true,
              )
            }
          />
        ) : null}
        <div className="w-full sm:w-64">
          <Input
            type="search"
            aria-label="Filter group chats"
            placeholder="Filter by title or member"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-xs text-muted-foreground">{shown.length} group chats</span>
        <div className="flex-1" />
        {canDelete && picked.length ? (
          <Button
            size="compact"
            variant="destructive-outline"
            data-testid="comms-groups-delete"
            onClick={() => setDeleting(true)}
          >
            <Trash2Icon /> Delete {picked.length}…
          </Button>
        ) : null}
        <Button size="compact" onClick={() => setCreating(true)}>
          <PlusIcon /> New group chat
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {error ? (
          <p className="p-6 text-sm text-destructive">{error.message}</p>
        ) : !data ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : groups.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No group chats yet.</p>
        ) : shown.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No group chats match.</p>
        ) : (
          <ul>
            {shown.map((group) => (
              <li
                key={group.id}
                className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-sm"
                data-testid={`comms-group-${group.id}`}
              >
                {canDelete ? (
                  <Checkbox
                    aria-label={`Select ${chatTitle(group)}`}
                    checked={selected.has(group.id)}
                    onCheckedChange={(value) => setPicked([group.id], value === true)}
                  />
                ) : null}
                <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{chatTitle(group)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {group.members.map((m) => `@${m.name}`).join(", ")}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">{group.lastSeq} messages</span>
                <Button size="compact" variant="ghost" onClick={() => setManaging(group.id)}>
                  Members
                </Button>
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/group-chats/$conversationId",
                      params: { conversationId: group.id },
                    })
                  }
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
      {creating && config ? <CreateGroupDialog open onOpenChange={setCreating} /> : null}
      {deleting ? (
        <DeleteGroupsDialog
          groups={picked}
          open
          onOpenChange={setDeleting}
          onDeleted={() =>
            setPicked(
              picked.map((group) => group.id),
              false,
            )
          }
        />
      ) : null}
      {managing ? (
        <ManageMembersDialog
          conversationId={managing}
          open
          onOpenChange={(open) => !open && setManaging(null)}
        />
      ) : null}
    </div>
  );
}

export function CommsPage(props: {
  readonly tab: CommsTab;
  readonly onTabChange: (tab: CommsTab) => void;
}) {
  const config = useCommsConfig();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto gap-4 py-2">
          <h1 className="text-sm font-medium">Comms</h1>
          <ToggleGroup
            aria-label="Comms section"
            variant="segmented"
            value={[props.tab]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "agents" || value === "groups") props.onTabChange(value);
            }}
          >
            <Toggle value="agents">Agents</Toggle>
            <Toggle value="groups">Group Chats</Toggle>
          </ToggleGroup>
          {config?.homeMachine ? (
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              via {config.homeMachine}
            </span>
          ) : null}
          {config?.testMode ? (
            <span className="shrink-0 rounded-full border border-warning/60 px-1.5 text-3xs whitespace-nowrap text-warning">
              test mode
              <span className="hidden md:inline">
                : writes limited to ta- agents and tg- groups
              </span>
            </span>
          ) : null}
        </WorkspacePageHeader>
        {config && !config.enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            This server isn't connected to a comms server.
          </p>
        ) : props.tab === "agents" ? (
          <AgentsTab />
        ) : (
          <GroupsTab />
        )}
      </div>
    </SidebarInset>
  );
}
