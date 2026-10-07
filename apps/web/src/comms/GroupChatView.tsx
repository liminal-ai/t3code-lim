// Fork-only (agent comms): group chat page pieces, based on the old Roundtable
// view. The transcript renders oldest first: the poster's own messages right-
// aligned, everyone else's as markdown under their name, each request with the
// state of every delivery it woke, and a working row per member still on one.
// The composer has one checkbox per member (who to wake), @-autocomplete, and a
// preview of who the post wakes.
import { HourglassIcon, SendIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { ConversationMessage, DeliveryView, ParticipantRef } from "./commsTypes";
import {
  applyMention,
  deliveryLabel,
  draftRecipients,
  mentionCandidates,
  mentionQueryAt,
  type MemberActivity,
  type MentionQuery,
  wakePreviewLabel,
} from "./groupChat.logic";

const WORKING_TEXT_CLASS = "text-info";
// Static on purpose: no continuously repainting animations (AGENTS.md).
const WORKING_DOT_CLASS = "bg-info";

/** Header strip: every member, with a live dot while they're working and red when their last wake failed. */
export function GroupChatMemberStrip(props: {
  readonly members: ReadonlyArray<ParticipantRef>;
  readonly activity: ReadonlyMap<string, MemberActivity>;
}) {
  return (
    <ul className="flex min-w-0 items-center gap-3 truncate" data-testid="comms-group-members">
      {props.members.map((member) => {
        const activity = props.activity.get(member.name) ?? "idle";
        return (
          <li
            key={member.id}
            className={cn(
              "flex items-center gap-1 text-xs",
              activity === "working"
                ? WORKING_TEXT_CLASS
                : activity === "failed"
                  ? "text-destructive"
                  : "text-secondary-label",
            )}
            data-activity={activity}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                activity === "working"
                  ? WORKING_DOT_CLASS
                  : activity === "failed"
                    ? "bg-destructive"
                    : member.kind === "human"
                      ? "bg-primary/60"
                      : "bg-foreground/25",
              )}
            />
            <span className="truncate">@{member.name}</span>
            <span className="sr-only">
              {activity === "working" ? " is working" : activity === "failed" ? " failed" : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DeliveryChips(props: { readonly deliveries: ReadonlyArray<DeliveryView> }) {
  if (props.deliveries.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5 text-3xs">
      {props.deliveries.map((delivery) => {
        const failed = delivery.state === "failed" || delivery.state === "uncertain";
        const open =
          delivery.state === "pending" ||
          delivery.state === "claimed" ||
          delivery.state === "delivered";
        const chip = (
          <span
            key={delivery.id}
            data-state={delivery.state}
            className={cn(
              "rounded-full border px-1.5 py-px",
              failed
                ? delivery.state === "uncertain"
                  ? "border-destructive bg-destructive text-destructive-foreground"
                  : "border-destructive text-destructive"
                : delivery.state === "ambiguous"
                  ? "border-warning text-warning"
                  : open
                    ? cn("border-info/50", WORKING_TEXT_CLASS)
                    : "border-border text-secondary-label",
            )}
          >
            @{delivery.recipient} {deliveryLabel(delivery.state)}
          </span>
        );
        // Why a delivery failed or is unclear: the comms server's detail.
        return delivery.detail ? (
          <Tooltip key={delivery.id}>
            <TooltipTrigger render={chip} />
            <TooltipPopup side="top" className="max-w-80">
              {delivery.detail}
            </TooltipPopup>
          </Tooltip>
        ) : (
          chip
        );
      })}
    </div>
  );
}

export function GroupChatTranscript(props: {
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly self: string | null;
  readonly working: ReadonlyArray<string>;
  /** Injected so tests render without the chat markdown stack. */
  readonly renderMarkdown: (text: string) => ReactNode;
}) {
  const { messages, renderMarkdown, self } = props;
  const byId = new Map(messages.map(({ message }) => [message.id, message]));
  return (
    <ol className="flex flex-col gap-3 px-3 py-4 sm:px-6" data-testid="comms-group-transcript">
      {messages.map(({ message, deliveries }) => {
        const own = message.sender.name === self;
        const request = message.inReplyTo ? byId.get(message.inReplyTo) : undefined;
        return (
          <li
            key={message.id}
            id={`comms-message-${message.id}`}
            data-seq={message.seq}
            data-sender={message.sender.name}
            className={cn("flex flex-col gap-1", own ? "items-end" : "items-start")}
          >
            <div
              className={cn(
                "flex items-baseline gap-2 text-xs text-secondary-label",
                own && "flex-row-reverse",
              )}
            >
              <span className={cn("font-medium", own ? "text-primary" : "text-foreground/80")}>
                @{message.sender.name}
              </span>
              <time dateTime={new Date(message.createdAt).toISOString()}>
                {formatRelativeTimeLabel(new Date(message.createdAt).toISOString())}
              </time>
              {!own && message.recipients.length > 0 && !request ? (
                <span>to {message.recipients.map((r) => `@${r.name}`).join(", ")}</span>
              ) : null}
            </div>
            {request ? (
              <button
                type="button"
                className="max-w-[85%] cursor-pointer truncate text-left text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  document
                    .getElementById(`comms-message-${request.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
              >
                ↩ @{request.sender.name}: {request.text.split("\n", 1)[0]}
              </button>
            ) : null}
            {own ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary/10 px-3 py-2 text-sm text-foreground sm:max-w-[70%]">
                {message.text}
              </div>
            ) : (
              <div className="max-w-full min-w-0 rounded-2xl rounded-tl-sm bg-foreground/5 px-3 py-2 text-sm sm:max-w-[85%]">
                {renderMarkdown(message.text)}
              </div>
            )}
            {own ? <DeliveryChips deliveries={deliveries} /> : null}
          </li>
        );
      })}
      {props.working.map((name) => (
        <li key={`working-${name}`} className="flex items-start" role="status">
          <div
            className={cn(
              "flex items-center gap-2 rounded-2xl rounded-tl-sm bg-foreground/5 px-3 py-2 text-sm",
              WORKING_TEXT_CLASS,
            )}
          >
            <HourglassIcon aria-hidden className="size-3.5" />
            <span>@{name} is working</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function GroupChatComposer(props: {
  /** The members a post can wake (everyone but the poster). */
  readonly candidates: ReadonlyArray<ParticipantRef>;
  readonly onSend: (text: string, to: ReadonlyArray<string>) => Promise<unknown>;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  /** Checked recipients; owned by the page so it can persist them. */
  readonly checked: ReadonlySet<string>;
  readonly onCheckedChange: (name: string, checked: boolean) => void;
}) {
  const { candidates, checked, disabled, onCheckedChange, onSend } = props;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Candidate cursor, reset whenever the typed query changes (derived, no effect).
  const [highlight, setHighlight] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Escape hides the menu for the mention being typed; typing a new one shows it again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const typed: MentionQuery | null = useMemo(() => mentionQueryAt(text, caret), [text, caret]);
  const mention = typed && typed.start !== dismissedAt ? typed : null;
  // A dismissal lasts only while that mention is being typed.
  if (dismissedAt !== null && typed?.start !== dismissedAt) setDismissedAt(null);
  const options = useMemo(
    () => (mention ? mentionCandidates(candidates, mention.query) : []),
    [mention, candidates],
  );
  const recipients = useMemo(
    () => draftRecipients(text, candidates, checked),
    [text, candidates, checked],
  );
  const preview = text.trim() ? wakePreviewLabel(recipients, candidates) : "";
  const index = highlight.query === mention?.query ? highlight.index : 0;
  const moveHighlight = (step: number) =>
    setHighlight({
      query: mention?.query,
      index: (index + step + options.length) % options.length,
    });

  const syncCaret = useCallback(() => {
    const element = inputRef.current;
    if (element) setCaret(element.selectionStart ?? element.value.length);
  }, []);

  const pick = useCallback(
    (name: string) => {
      if (!mention) return;
      const next = applyMention(text, mention, name);
      setText(next.text);
      setCaret(next.caret);
      requestAnimationFrame(() => {
        const element = inputRef.current;
        if (element) {
          element.focus();
          element.setSelectionRange(next.caret, next.caret);
        }
      });
    },
    [mention, text],
  );

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(trimmed, recipients);
      setText("");
      setCaret(0);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [disabled, onSend, recipients, sending, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length && mention) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlight(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pick(options[index] ?? options[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(mention.start);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5 border-t border-border bg-background px-3 py-2 sm:px-6"
      data-testid="comms-group-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="relative">
        {options.length && mention ? (
          <ul
            role="listbox"
            className="absolute bottom-full left-0 z-10 mb-1 min-w-40 overflow-hidden rounded-md border border-border bg-popover text-sm shadow-md"
          >
            {options.map((name, optionIndex) => (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={optionIndex === index}
                  className={cn(
                    "flex w-full items-center px-2.5 py-1.5 text-left font-medium",
                    optionIndex === index ? "bg-foreground/10" : "hover:bg-foreground/5",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(name)}
                >
                  @{name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={text}
            rows={2}
            disabled={disabled}
            placeholder={props.disabledReason ?? "Message the group (@name or @all to wake)"}
            aria-label="Message the group"
            data-testid="comms-group-input"
            className="max-h-40 min-h-10 flex-1 resize-none"
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
          />
          <Button
            type="submit"
            size="sm"
            aria-label="Send"
            disabled={disabled || sending || !text.trim()}
            data-testid="comms-group-send"
          >
            {sending ? <Spinner /> : <SendIcon className="size-4" />}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-center gap-3" data-testid="comms-group-recipients">
          {candidates.map((member) => (
            // The checkbox sits inside its label: base-ui assigns its own id, so htmlFor can't bind.
            <label
              key={member.id}
              className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary-label select-none"
            >
              <Checkbox
                checked={checked.has(member.name)}
                disabled={disabled}
                data-testid={`comms-recipient-${member.name}`}
                onCheckedChange={(value) => onCheckedChange(member.name, value === true)}
              />
              @{member.name}
            </label>
          ))}
        </div>
        <div
          className={cn(
            "min-h-4 min-w-0 flex-1 text-xs",
            sendError ? "text-destructive" : "text-secondary-label",
          )}
          data-testid="comms-group-wake-preview"
        >
          {sendError ?? preview}
        </div>
      </div>
    </form>
  );
}
