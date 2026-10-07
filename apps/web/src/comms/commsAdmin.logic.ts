// Fork-only (agent comms): pure logic for the Comms admin page. Presence
// follows the comms web view (apps/web/src/lib/view.ts in agent-comms): a stale
// machine's presence can't be trusted, so it never reads as idle.
import type { CommsConfig, DirectoryList, RegistryEntry } from "./commsTypes";

/** agent-comms PRESENCE_STALE_MS: a machine unheard for this long is stale. */
export const PRESENCE_STALE_MS = 90_000;

/** agent-comms NAME_PATTERN. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export type PresenceStatus =
  | "person"
  | "system"
  | "stale"
  | "offline"
  | "idle"
  | "busy"
  | "paused"
  | "retired";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A span for people: "45s", "12m", "3h 5m", "2d 4h". */
export function span(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MINUTE) return `${Math.floor(t / 1000)}s`;
  if (t < HOUR) return `${Math.floor(t / MINUTE)}m`;
  if (t < DAY) {
    const m = Math.floor((t % HOUR) / MINUTE);
    return `${Math.floor(t / HOUR)}h${m ? ` ${m}m` : ""}`;
  }
  const h = Math.floor((t % DAY) / HOUR);
  return `${Math.floor(t / DAY)}d${h ? ` ${h}h` : ""}`;
}

/** Each machine's last heartbeat, by id. */
export function machineSeenMap(directory: DirectoryList | undefined): ReadonlyMap<string, number> {
  const seen = new Map<string, number>();
  for (const machine of directory?.machines ?? []) {
    if (machine.lastSeenAt !== null) seen.set(machine.machineId, machine.lastSeenAt);
  }
  return seen;
}

/** What the roster shows for one participant, re-deriving staleness on this clock. */
export function presenceView(
  entry: RegistryEntry,
  machineSeen: ReadonlyMap<string, number>,
  now: number,
): { readonly status: PresenceStatus; readonly label: string } {
  if (entry.state === "retired") return { status: "retired", label: "retired" };
  if (entry.state === "paused") return { status: "paused", label: "paused" };
  const presence = entry.presence;
  if (!presence) {
    if (entry.participant.kind === "system") return { status: "system", label: "system" };
    if (entry.participant.kind === "human") return { status: "person", label: "person" };
    return { status: "offline", label: "offline (never connected)" };
  }
  const seen = entry.home ? machineSeen.get(entry.home.machine) : undefined;
  if (presence.stale || seen === undefined || now - seen >= PRESENCE_STALE_MS) {
    return {
      status: "stale",
      label:
        seen === undefined
          ? "connector never heard from"
          : `connector last heard ${span(now - seen)} ago`,
    };
  }
  if (presence.status === "offline") return { status: "offline", label: "offline" };
  if (presence.status === "busy") return { status: "busy", label: "working" };
  return {
    status: "idle",
    label: presence.idleSince !== undefined ? `idle ${span(now - presence.idleSince)}` : "idle",
  };
}

const KIND_ORDER = { agent: 0, human: 1, system: 2 } as const;

/** Roster order: agents, then people, then system; retired last; by name. */
export function sortRoster(entries: ReadonlyArray<RegistryEntry>): ReadonlyArray<RegistryEntry> {
  return [...entries].sort(
    (a, b) =>
      Number(a.state === "retired") - Number(b.state === "retired") ||
      KIND_ORDER[a.participant.kind] - KIND_ORDER[b.participant.kind] ||
      a.participant.name.localeCompare(b.participant.name),
  );
}

export function filterRoster(
  entries: ReadonlyArray<RegistryEntry>,
  options: { readonly query: string; readonly showRetired: boolean },
): ReadonlyArray<RegistryEntry> {
  const q = options.query.trim().toLowerCase().replace(/^@/, "");
  return entries.filter(
    (entry) =>
      (options.showRetired || entry.state !== "retired") &&
      (!q ||
        entry.participant.name.includes(q) ||
        (entry.description ?? "").toLowerCase().includes(q)),
  );
}

/** The T3 thread an agent lives in, when its home is this server's machine. */
export function localThreadId(entry: RegistryEntry, homeMachine: string | null): string | null {
  const home = entry.home;
  return home && homeMachine && home.harness === "t3" && home.machine === homeMachine
    ? home.locator
    : null;
}

/** A name's problem for registering, or undefined when it's acceptable to send. */
export function nameProblem(name: string, taken: ReadonlySet<string>): string | undefined {
  if (!name) return "Give it a name.";
  if (!NAME_PATTERN.test(name)) return "Names are lowercase letters, digits, - and _ (up to 48).";
  if (taken.has(name)) return `@${name} already exists (retired names stay reserved).`;
  return undefined;
}

/** One description line; duties one per line, blank lines dropped. */
export function parseDuties(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The harnesses agent-comms knows (protocol `Harness` in packages/protocol/src/model.ts),
 * with what each one's locator is. Harnesses already in use are offered too, so a harness
 * added to comms appears here once one agent uses it.
 */
export const HARNESS_HELP: Readonly<
  Record<
    string,
    {
      readonly name: string;
      readonly label: string;
      readonly hint: string;
      readonly fromName?: true;
    }
  >
> = {
  t3: {
    name: "T3",
    label: "T3 thread id",
    hint: "The thread's id on that machine's T3 (the last part of its URL).",
  },
  "claude-code": {
    name: "Claude Code",
    label: "Terminal name",
    hint: "A Claude Code session's locator is its comms name; the session connects with that name.",
    fromName: true,
  },
  oaidot: {
    name: "ChatGPT (oaidot)",
    label: "Parent binding",
    hint: "The parent binding configured for the oaidot courier on that machine.",
  },
  muse: { name: "Muse", label: "Muse locator", hint: "The locator Muse's own connector expects." },
};

export function harnessOptions(registry: ReadonlyArray<RegistryEntry>): ReadonlyArray<string> {
  const inUse = registry.flatMap((e) => (e.home?.harness ? [e.home.harness] : []));
  return [...new Set([...Object.keys(HARNESS_HELP), ...inUse])].filter((h) => h !== "web");
}

/** The locator sent for a harness: Claude Code's is the agent's name. */
export function harnessLocator(harness: string, name: string, typed: string): string {
  return HARNESS_HELP[harness]?.fromName ? name : typed.trim();
}

/** Registered machines, most recently heard first, labelled with when. */
export function machineOptions(
  directory: DirectoryList | undefined,
  now = Date.now(),
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  return [...(directory?.machines ?? [])]
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .map((m) => ({
      id: m.machineId,
      label: m.lastSeenAt === null ? "never connected" : `heard ${span(now - m.lastSeenAt)} ago`,
    }));
}

/**
 * Test mode offers only what the server will accept: this instance's own test
 * agents (owned by the post-as person, homed on the home machine) and that person.
 */
export function isOwnTestParticipant(
  entry: RegistryEntry,
  config: CommsConfig | undefined,
): boolean {
  const name = entry.participant.name;
  if (name === config?.postAs) return true;
  return (
    name.startsWith("ta-") &&
    entry.owner?.name === config?.postAs &&
    entry.home?.machine === config?.homeMachine
  );
}
