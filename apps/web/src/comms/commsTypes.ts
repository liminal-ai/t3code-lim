// Fork-only (agent comms): the slices of the comms server's data the T3 UI
// reads. Mirrors @agent-comms/protocol (model.ts) without depending on it.

export type ParticipantKind = "human" | "agent" | "system";
export type ParticipantState = "active" | "paused" | "retired";

export interface ParticipantRef {
  readonly id: string;
  readonly name: string;
  readonly kind: ParticipantKind;
}

export interface Home {
  readonly machine: string;
  readonly harness: string;
  readonly locator: string;
}

export interface Presence {
  readonly status: "offline" | "idle" | "busy";
  readonly at: number;
  readonly idleSince?: number;
}

export interface DirectoryParticipant extends ParticipantRef {
  readonly state: ParticipantState;
  readonly home?: Home;
  readonly presence?: Presence;
}

export interface DirectoryList {
  readonly participants: ReadonlyArray<DirectoryParticipant>;
  readonly machines: ReadonlyArray<{
    readonly machineId: string;
    readonly lastSeenAt: number | null;
  }>;
}

export interface ConversationSummary {
  readonly id: string;
  readonly kind: "dm" | "group";
  readonly title?: string;
  readonly members: ReadonlyArray<ParticipantRef>;
  readonly lastSeq: number;
  readonly readSeq: number;
  readonly unread: number;
}

export type DeliveryState =
  | "pending"
  | "claimed"
  | "delivered"
  | "replied"
  | "ambiguous"
  | "uncertain"
  | "failed";

export interface MessageEnvelope {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly sender: ParticipantRef;
  readonly recipients: ReadonlyArray<ParticipantRef>;
  readonly kind: "request" | "answer" | "notice";
  readonly inReplyTo?: string;
  readonly text: string;
  readonly createdAt: number;
}

export interface DeliveryView {
  readonly id: string;
  readonly recipient: string;
  readonly state: DeliveryState;
  readonly at: number;
  readonly detail?: string;
}

export interface ConversationMessage {
  readonly message: MessageEnvelope;
  readonly deliveries: ReadonlyArray<DeliveryView>;
}

export interface ConversationView {
  readonly conversation: ConversationSummary;
  readonly members: ReadonlyArray<ParticipantRef>;
  readonly messages: ReadonlyArray<ConversationMessage>;
}

export type { CommsConfig } from "@t3tools/contracts";

export interface RegistryEntry {
  readonly participant: ParticipantRef;
  readonly state: ParticipantState;
  readonly presence: (Presence & { readonly stale?: boolean }) | null;
  readonly description?: string;
  readonly duties?: ReadonlyArray<string>;
  readonly owner?: ParticipantRef;
  readonly harness?: string;
  readonly home?: Home;
}
