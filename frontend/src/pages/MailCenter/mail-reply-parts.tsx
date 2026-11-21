// Reply box pieces kept out of Thread.tsx (owner 2026-11-21): who else is
// writing a reply right now, a reply someone sent while you were typing, and
// editable To / Cc / Bcc. Desktop and phone share the helpers.
import { useEffect, useRef } from "react";
import { AlertTriangle, PenLine, Users } from "lucide-react";
import { api } from "../../api/client";
import { parseRecipients } from "./mail-recipients";
import { RecipientSuggestInput } from "./RecipientSuggestInput";

export type ReplyingPerson = { name: string };
export type AlreadyReplied = { by: string; at: string };

/** Everyone on the newest message except our own mailboxes and whoever is already on To. */
export function replyAllCc(
  last: { fromAddress: string; toAddresses: string[]; ccAddresses: string[] } | null,
  to: string,
  ours: string[],
): string {
  if (!last) return "";
  const skip = new Set([...ours, ...parseRecipients(to)].map((a) => a.toLowerCase()));
  const out: string[] = [];
  for (const a of [last.fromAddress, ...last.toAddresses, ...last.ccAddresses]) {
    const k = a.trim().toLowerCase();
    if (!k || skip.has(k)) continue;
    skip.add(k);
    out.push(a.trim());
  }
  return out.join(", ");
}

/** The server's 409 when a colleague replied after the newest message I had seen. */
export function alreadyRepliedFrom(e: unknown): AlreadyReplied | null {
  const err = e as { status?: number; rawBody?: string } | null;
  if (err?.status !== 409 || !err.rawBody) return null;
  try {
    const body = JSON.parse(err.rawBody) as { code?: string; by?: string; at?: string };
    return body.code === "already_replied" && body.by && body.at ? { by: body.by, at: body.at } : null;
  } catch {
    return null;
  }
}

/** "2 minutes ago" for a reply that just landed. */
export function agoLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

/** Tells the others "I am writing a reply" every 20 s while the box has text. */
export function useReplyingHeartbeat(threadId: string | null, drafting: boolean): void {
  const sent = useRef(false);
  useEffect(() => {
    if (!threadId) return;
    const beat = (on: boolean) => {
      sent.current = on;
      // Best effort: a missed beat only hides the "is writing" note for a moment.
      api.post(`/api/mail-center/threads/${threadId}/replying`, { drafting: on }).catch((e: unknown) => {
        console.warn("[mail] replying heartbeat failed", e);
      });
    };
    if (!drafting) {
      if (sent.current) beat(false);
      return;
    }
    beat(true);
    const t = setInterval(() => beat(true), 20_000);
    return () => clearInterval(t);
  }, [threadId, drafting]);
}

export function ReplyingNowBanner({ people }: { people: ReplyingPerson[] }) {
  if (people.length === 0) return null;
  const names = people.map((p) => p.name);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-text/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning-text">
      <PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <b>{who}</b> {names.length === 1 ? "is" : "are"} writing a reply to this conversation now. Check with them before you reply too.
      </span>
    </div>
  );
}

export function AlreadyRepliedBox({
  hit,
  now,
  busy,
  onSendAnyway,
  onDiscard,
}: {
  hit: AlreadyReplied;
  now: number;
  busy: boolean;
  onSendAnyway: () => void;
  onDiscard: () => void;
}) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-err/40 bg-err/5 px-3 py-2.5">
      <p className="flex items-start gap-2 text-[12.5px] text-ink">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-err" />
        <span>
          <b>{hit.by}</b> replied {agoLabel(hit.at, now)}, while you were writing. Their reply is shown above.{" "}
          <b>Yours has not been sent.</b>
        </span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
        >
          Discard mine
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSendAnyway}
          className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
        >
          Send mine too
        </button>
      </div>
    </div>
  );
}

const FIELD =
  "h-8 w-full rounded-md border bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60";

/** To (prefilled with the customer), Cc and Bcc, and "Reply all" that fills Cc. */
export function ReplyRecipients({
  to,
  cc,
  bcc,
  showCopies,
  disabled,
  replyAllOffer,
  invalid,
  onTo,
  onCc,
  onBcc,
  onShowCopies,
  onReplyAll,
}: {
  to: string;
  cc: string;
  bcc: string;
  showCopies: boolean;
  disabled: boolean;
  replyAllOffer: number;
  invalid: string | null;
  onTo: (v: string) => void;
  onCc: (v: string) => void;
  onBcc: (v: string) => void;
  onShowCopies: () => void;
  onReplyAll: () => void;
}) {
  const row = "grid grid-cols-[44px_1fr] items-center gap-2";
  const label = "text-xs font-medium text-ink-muted";
  return (
    <div className="space-y-1.5">
      <div className={row}>
        <label className={label}>To</label>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <RecipientSuggestInput value={to} onChange={onTo} placeholder="customer@example.com" disabled={disabled} invalid={!!invalid} inputClassName={`${FIELD} ${invalid ? "border-err" : "border-border focus:border-primary"}`} />
          </div>
          {replyAllOffer > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={onReplyAll}
              title="Add everyone who was on the last message to Cc"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              <Users className="h-3.5 w-3.5" />
              Reply all (+{replyAllOffer})
            </button>
          )}
          {!showCopies && (
            <button type="button" onClick={onShowCopies} className="shrink-0 text-[11px] font-medium text-primary hover:underline">
              Cc / Bcc
            </button>
          )}
        </div>
      </div>
      {showCopies && (
        <>
          <div className={row}>
            <label className={label}>Cc</label>
            <RecipientSuggestInput value={cc} onChange={onCc} placeholder="visible to everyone" disabled={disabled} invalid={false} inputClassName={`${FIELD} border-border focus:border-primary`} />
          </div>
          <div className={row}>
            <label className={label}>Bcc</label>
            <RecipientSuggestInput value={bcc} onChange={onBcc} placeholder="hidden from the others" disabled={disabled} invalid={false} inputClassName={`${FIELD} border-border focus:border-primary`} />
          </div>
        </>
      )}
      {invalid && <p className="pl-[52px] text-[11px] text-err">Not a valid email address: {invalid}</p>}
    </div>
  );
}
