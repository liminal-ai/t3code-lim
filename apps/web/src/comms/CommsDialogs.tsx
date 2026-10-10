// Fork-only (agent comms): the Comms page's forms. Register an agent (default:
// from one of this server's T3 threads), create a group chat, and manage a
// group's members. Every write goes through the /api/comms proxy, which also
// enforces test mode; its refusal text is shown as-is.
import { useNavigate } from "@tanstack/react-router";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useThreadShells } from "~/state/entities";

import { commsCall, commsRouteGeneration, useCommsQuery } from "./commsClient";
import { useCloseOnCommsRetarget, useCommsConfig, useCommsEnvironmentId } from "./useCommsConfig";
import {
  HARNESS_HELP,
  isOwnTestParticipant,
  harnessLocator,
  harnessOptions,
  machineOptions,
  nameProblem,
  parseDuties,
  pickedCandidate,
} from "./commsAdmin.logic";
import type {
  ConversationSummary,
  ConversationView,
  DirectoryList,
  RegistryEntry,
} from "./commsTypes";
import { chatTitle, deleteBatches } from "./groupChat.logic";

const TEST_AGENT_PREFIX = "ta-";
const TEST_GROUP_PREFIX = "tg-";

function useRegistry(): ReadonlyArray<RegistryEntry> {
  return (
    useCommsQuery<{ agents: ReadonlyArray<RegistryEntry> }>("registry:list").data?.agents ?? []
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clearError: () => setError(null) };
}

function FormError(props: { readonly error: string | null }) {
  return props.error ? <p className="text-xs text-destructive">{props.error}</p> : null;
}

export function RegisterAgentDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  useCloseOnCommsRetarget(props.open, props.onOpenChange);
  const config = useCommsConfig();
  const registry = useRegistry();
  const directory = useCommsQuery<DirectoryList>("directory:list", props.open ? {} : "skip");
  const environmentId = useCommsEnvironmentId();
  const threads = useThreadShells(props.open);
  const testMode = config?.testMode === true;
  const homeMachine = config?.homeMachine ?? null;

  const taken = useMemo(() => new Set(registry.map((e) => e.participant.name)), [registry]);
  const registeredThreads = useMemo(
    () => new Set(registry.flatMap((e) => (e.home?.harness === "t3" ? [e.home.locator] : []))),
    [registry],
  );
  const people = useMemo(
    () =>
      registry
        .filter((e) => e.participant.kind === "human" && e.state !== "retired")
        .map((e) => e.participant.name),
    [registry],
  );
  const machines = useMemo(() => machineOptions(directory.data), [directory.data]);
  const harnesses = useMemo(() => harnessOptions(registry), [registry]);
  const candidateThreads = useMemo(
    () =>
      threads
        .filter(
          (t) =>
            t.environmentId === environmentId &&
            t.archivedAt === null &&
            !registeredThreads.has(t.id),
        )
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [environmentId, registeredThreads, threads],
  );

  // "This T3" needs to know which comms machine this server is; without it, only Other machine.
  const [source, setSource] = useState<"local" | "machine">(homeMachine ? "local" : "machine");
  const [threadId, setThreadId] = useState("");
  const [name, setName] = useState(testMode ? TEST_AGENT_PREFIX : "");
  // The config can arrive after the dialog mounts: until a choice is made, the owner is the post-as person.
  const [ownerChoice, setOwner] = useState("");
  const owner = ownerChoice || config?.postAs || "";
  const [description, setDescription] = useState("");
  const [machine, setMachine] = useState("");
  const [harness, setHarness] = useState("t3");
  const [locator, setLocator] = useState("");
  const submit = useSubmit();

  const effectiveLocator = harnessLocator(harness, name, locator);
  // A pick only counts while it's one of the comms server's threads: if comms moves to
  // another T3, an earlier pick must not be registered under the new home machine.
  const pickedThread = pickedCandidate(candidateThreads, threadId);
  const home =
    source === "local"
      ? homeMachine && pickedThread
        ? { machine: homeMachine, harness: "t3", locator: pickedThread }
        : null
      : machine && harness && effectiveLocator
        ? { machine, harness, locator: effectiveLocator }
        : null;
  const problem =
    nameProblem(name, taken) ??
    (!owner ? "Pick its owner (a person)." : undefined) ??
    (!home
      ? source === "local"
        ? "Pick the T3 thread it lives in."
        : !machine
          ? "Pick the machine it lives on."
          : `Give its ${HARNESS_HELP[harness]?.label ?? "locator"}.`
      : undefined);

  const reset = () => {
    setThreadId("");
    setLocator("");
    setName(testMode ? TEST_AGENT_PREFIX : "");
    setDescription("");
    submit.clearError();
  };
  const save = async () => {
    if (problem || !home) return;
    const ok = await submit.run(() =>
      commsCall("directory:promote", {
        name,
        kind: "agent",
        owner,
        home,
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    );
    if (ok) {
      reset();
      props.onOpenChange(false);
    }
  };
  const help = HARNESS_HELP[harness];

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Register an agent</DialogTitle>
          <DialogDescription>
            Put an agent on the comms network. Its machine's connector wakes it when a message names
            it.
            {testMode ? ` Test mode: names start with ta- and live on ${homeMachine ?? "?"}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <ToggleGroup
              aria-label="Where the agent lives"
              variant="segmented"
              value={[source]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "local" || value === "machine") setSource(value);
              }}
            >
              <Toggle value="local" disabled={!homeMachine}>
                This T3{homeMachine ? ` (${homeMachine})` : ""}
              </Toggle>
              <Toggle value="machine">Another machine</Toggle>
            </ToggleGroup>
            {source === "local" ? (
              <div className="grid gap-1.5">
                <Label>T3 thread</Label>
                <Select
                  value={pickedThread}
                  onValueChange={(value) => setThreadId(String(value ?? ""))}
                >
                  <SelectTrigger aria-label="T3 thread">
                    <SelectValue>
                      {candidateThreads.find((t) => t.id === threadId)?.title ?? "Pick a thread"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {candidateThreads.map((thread) => (
                      <SelectItem key={thread.id} value={thread.id}>
                        {thread.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Threads already registered aren't listed.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1.5">
                    <Label>Machine</Label>
                    <Select
                      value={machine}
                      onValueChange={(value) => setMachine(String(value ?? ""))}
                    >
                      <SelectTrigger aria-label="Machine">
                        <SelectValue>{machine || "Pick a machine"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {machines.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.id}
                            <span className="ml-2 text-xs text-muted-foreground">{m.label}</span>
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Harness</Label>
                    <Select
                      value={harness}
                      onValueChange={(value) => setHarness(String(value ?? ""))}
                    >
                      <SelectTrigger aria-label="Harness">
                        <SelectValue>{HARNESS_HELP[harness]?.name ?? harness}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {harnesses.map((h) => (
                          <SelectItem key={h} value={h}>
                            {HARNESS_HELP[h]?.name ?? h}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </div>
                {help?.fromName ? (
                  <p className="text-xs text-muted-foreground">{help.hint}</p>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="comms-register-locator">{help?.label ?? "Locator"}</Label>
                    <Input
                      id="comms-register-locator"
                      value={locator}
                      onChange={(e) => setLocator(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {help?.hint ??
                        "What this harness's connector uses to find the agent; ask the agent's owner."}
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="comms-register-name">Name</Label>
                <Input
                  id="comms-register-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Owner</Label>
                <Select value={owner} onValueChange={(value) => setOwner(String(value ?? ""))}>
                  <SelectTrigger aria-label="Owner">
                    <SelectValue>{owner ? `@${owner}` : "Pick a person"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {people.map((person) => (
                      <SelectItem key={person} value={person}>
                        @{person}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="comms-register-description">Description (optional)</Label>
              <Input
                id="comms-register-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <FormError error={submit.error ?? (name.length > 3 ? (problem ?? null) : null)} />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={Boolean(problem) || submit.busy}>
            Register
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Active participants (not system) that can join a group. */
function useJoinable(): ReadonlyArray<RegistryEntry> {
  const registry = useRegistry();
  return useMemo(
    () => registry.filter((e) => e.participant.kind !== "system" && e.state === "active"),
    [registry],
  );
}

function MemberPicker(props: {
  readonly entries: ReadonlyArray<RegistryEntry>;
  readonly checked: ReadonlySet<string>;
  readonly onToggle: (name: string, value: boolean) => void;
  readonly locked?: ReadonlySet<string>;
}) {
  return (
    <div className="grid max-h-64 grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto">
      {props.entries.map((entry) => {
        const name = entry.participant.name;
        return (
          <label key={name} className="flex cursor-pointer items-center gap-2 text-sm select-none">
            <Checkbox
              checked={props.checked.has(name)}
              disabled={props.locked?.has(name)}
              onCheckedChange={(value) => props.onToggle(name, value === true)}
            />
            <span className="truncate">@{name}</span>
            {entry.participant.kind === "human" ? (
              <span className="text-xs text-muted-foreground">person</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

export function CreateGroupDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  useCloseOnCommsRetarget(props.open, props.onOpenChange);
  const config = useCommsConfig();
  const navigate = useNavigate();
  const joinable = useJoinable();
  const testMode = config?.testMode === true;
  const self = config?.postAs ?? null;
  const shown = useMemo(
    () => (testMode ? joinable.filter((e) => isOwnTestParticipant(e, config)) : joinable),
    [config, joinable, testMode],
  );
  const [title, setTitle] = useState(testMode ? TEST_GROUP_PREFIX : "");
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(self ? [self] : []));
  const submit = useSubmit();
  const problem = !title.trim()
    ? "Give it a title."
    : checked.size < 2
      ? "A group needs at least two members."
      : undefined;

  const save = async () => {
    if (problem) return;
    let id: string | undefined;
    const ok = await submit.run(async () => {
      const result = (await commsCall("conversations:createGroup", {
        title: title.trim(),
        members: [...checked],
      })) as { conversation: { id: string } };
      id = result.conversation.id;
    });
    if (ok && id) {
      props.onOpenChange(false);
      setTitle(testMode ? TEST_GROUP_PREFIX : "");
      setChecked(new Set(self ? [self] : []));
      void navigate({ to: "/group-chats/$conversationId", params: { conversationId: id } });
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New group chat</DialogTitle>
          <DialogDescription>
            Members see every message; only the ones a post names are woken.
            {testMode ? " Test mode: titles start with tg-, members are ta- agents." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="comms-group-title">Title</Label>
              <Input
                id="comms-group-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Members</Label>
              <MemberPicker
                entries={shown}
                checked={checked}
                onToggle={(name, value) =>
                  setChecked((current) => {
                    const next = new Set(current);
                    if (value) next.add(name);
                    else next.delete(name);
                    return next;
                  })
                }
              />
            </div>
            <FormError error={submit.error} />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={Boolean(problem) || submit.busy}>
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ManageMembersDialog(props: {
  readonly conversationId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  useCloseOnCommsRetarget(props.open, props.onOpenChange);
  const config = useCommsConfig();
  const joinable = useJoinable();
  const { data: view } = useCommsQuery<ConversationView>(
    "conversations:view",
    props.open ? { conversationId: props.conversationId, limit: 1 } : "skip",
  );
  const members = useMemo(() => new Set(view?.members.map((m) => m.name) ?? []), [view]);
  const testMode = config?.testMode === true;
  const addable = joinable.filter(
    (e) => !members.has(e.participant.name) && (!testMode || isOwnTestParticipant(e, config)),
  );
  const [adding, setAdding] = useState("");
  const submit = useSubmit();

  const change = (fn: "conversations:addMember" | "conversations:removeMember", name: string) =>
    submit.run(() => commsCall(fn, { conversationId: props.conversationId, name }));

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Members of {view?.conversation.title ?? "this chat"}</DialogTitle>
          <DialogDescription>
            New members start with earlier messages counted as read. Comms can't rename a group yet.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <ul className="grid gap-1">
              {(view?.members ?? []).map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    @{member.name}
                    {member.kind === "human" ? (
                      <span className="ml-2 text-xs text-muted-foreground">person</span>
                    ) : null}
                  </span>
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={submit.busy || (view?.members.length ?? 0) <= 2}
                    onClick={() => {
                      if (window.confirm(`Remove @${member.name} from this chat?`)) {
                        void change("conversations:removeMember", member.name);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-1.5">
                <Label>Add a member</Label>
                <Select value={adding} onValueChange={(value) => setAdding(String(value ?? ""))}>
                  <SelectTrigger aria-label="Add a member">
                    <SelectValue>{adding ? `@${adding}` : "Pick a participant"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {addable.map((entry) => (
                      <SelectItem key={entry.participant.name} value={entry.participant.name}>
                        @{entry.participant.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                disabled={!adding || submit.busy}
                onClick={() =>
                  void change("conversations:addMember", adding).then((ok) => ok && setAdding(""))
                }
              >
                Add
              </Button>
            </div>
            <FormError error={submit.error} />
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

// Group delete (Lee, 2026-10-09; Mira #258): permanently deletes the group and
// all its messages for everyone. There's no undo.
export function DeleteGroupDialog(props: {
  readonly conversationId: string;
  /** The open chat's title, so the dialog never waits on its own lookup. */
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  useCloseOnCommsRetarget(props.open, props.onOpenChange);
  const config = useCommsConfig();
  const navigate = useNavigate();
  const submit = useSubmit();
  const as = config?.postAs ?? null;
  const title = props.title;

  const remove = async () => {
    const deleted = await submit.run(async () => {
      const { error } = await deleteGroupChats(as, [props.conversationId]);
      if (error !== null) throw error;
    });
    if (!deleted) return;
    props.onOpenChange(false);
    void navigate({ to: "/comms", search: { tab: "groups" } });
    toastManager.add({ type: "success", title: `Deleted ${title}` });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {title}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the group and all its messages for everyone.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <FormError
            error={as === null ? "No post-as person is configured for comms." : submit.error}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="comms-delete-group-confirm"
            disabled={as === null || submit.busy}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Deletes groups as `as`, at most DELETE_BATCH_SIZE per call; each call is all
 * or nothing. Stops at the first failed batch, and before any batch once comms
 * has moved to another T3, so the ids are never sent to a different comms
 * server (Codex, PR #28). The caller learns how many went.
 */
async function deleteGroupChats(
  as: string | null,
  ids: ReadonlyArray<string>,
): Promise<{ readonly deleted: number; readonly error: unknown }> {
  const generation = commsRouteGeneration();
  let deleted = 0;
  for (const conversationIds of deleteBatches(ids)) {
    if (commsRouteGeneration() !== generation) {
      return { deleted, error: new Error("comms moved to another T3; the rest weren't sent") };
    }
    try {
      await commsCall("conversations:deleteConversation", { as, conversationIds });
    } catch (cause) {
      return { deleted, error: cause };
    }
    deleted += conversationIds.length;
  }
  return { deleted, error: null };
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Bulk delete from Comms > Groups (Lee clears test chats in bulk; Mira #262). */
export function DeleteGroupsDialog(props: {
  readonly groups: ReadonlyArray<ConversationSummary>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: () => void;
}) {
  useCloseOnCommsRetarget(props.open, props.onOpenChange);
  const config = useCommsConfig();
  const submit = useSubmit();
  const as = config?.postAs ?? null;
  const count = props.groups.length;
  const noun = count === 1 ? "group chat" : "group chats";

  const remove = async () => {
    const ids = props.groups.map((group) => group.id);
    // A failed batch keeps the dialog open and says how many went; deleted
    // groups leave the list (and so the selection) as the list updates.
    await submit
      .run(async () => {
        const { deleted, error } = await deleteGroupChats(as, ids);
        if (error === null) return;
        if (deleted === 0) throw error;
        throw new Error(
          `Deleted ${deleted} of ${count}; the rest weren't deleted: ${errorText(error)}`,
        );
      })
      .then((ok) => {
        if (!ok) return;
        props.onOpenChange(false);
        props.onDeleted();
        toastManager.add({ type: "success", title: `Deleted ${count} ${noun}` });
      });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Delete {count} {noun}?
          </DialogTitle>
          <DialogDescription>
            This permanently deletes {count === 1 ? "the group" : "these groups"} and all{" "}
            {count === 1 ? "its" : "their"} messages for everyone.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="max-h-48 overflow-y-auto text-sm">
            {props.groups.map((group) => (
              <li key={group.id} className="truncate">
                {chatTitle(group)}
              </li>
            ))}
          </ul>
          <FormError
            error={as === null ? "No post-as person is configured for comms." : submit.error}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="comms-delete-groups-confirm"
            disabled={as === null || submit.busy || count === 0}
            onClick={() => void remove()}
          >
            Delete {count}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function EditProfileDialog(props: {
  readonly entry: RegistryEntry;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  useCloseOnCommsRetarget(props.open, props.onOpenChange);
  const [description, setDescription] = useState(props.entry.description ?? "");
  const [duties, setDuties] = useState((props.entry.duties ?? []).join("\n"));
  const submit = useSubmit();
  const save = async () => {
    const ok = await submit.run(() =>
      commsCall("registry:setProfile", {
        name: props.entry.participant.name,
        description: description.trim(),
        duties: parseDuties(duties),
      }),
    );
    if (ok) props.onOpenChange(false);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>@{props.entry.participant.name}'s profile</DialogTitle>
          <DialogDescription>What other agents see in the registry.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="comms-profile-description">Description (one line)</Label>
              <Input
                id="comms-profile-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="comms-profile-duties">Duties (one per line)</Label>
              <Textarea
                id="comms-profile-duties"
                rows={5}
                value={duties}
                onChange={(e) => setDuties(e.target.value)}
              />
            </div>
            <FormError error={submit.error} />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={submit.busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
