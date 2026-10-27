// Mail Center per-person read state and "needs acknowledgement" (DEV-03 P2).
// Shared by the desktop thread, the inbox sidebar and the phone.
import { useState } from "react";
import { CheckCheck, Eye, Loader2, MailCheck } from "lucide-react";
import { api } from "../../api/client";
import { buildQueryKey, useQuery } from "../../hooks/useQuery";
import { queryClient } from "../../lib/queryClient";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";
import { fmtDateTime } from "../../vendor/shared/format";

export type MailReader = { userId: number; name: string; readAt: string | null };
export type ThreadReaders = { members: MailReader[]; others: MailReader[] };
export type AckState = { userId: number; name: string; ackedAt: string | null; overdue: boolean };
export type OwedAck = {
  messageId: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  requestedAt: string;
  snippet: string;
  overdue: boolean;
};

export const NEEDS_ACK_HINT = "Staff on To / Cc are asked to confirm they have read it; they are reminded after 48 hours.";

const PENDING_KEY = "/api/mail-center/acks/pending";

export async function acknowledgeMessage(messageId: string): Promise<void> {
  await api.post(`/api/mail-center/messages/${encodeURIComponent(messageId)}/ack`, {});
  void queryClient.invalidateQueries({ queryKey: buildQueryKey(PENDING_KEY) });
}

/** "Read by 2 of 3" for the mailbox's people; names on hover. */
export function ReadByLine({ readers }: { readers?: ThreadReaders | null }) {
  if (!readers || readers.members.length < 2) return null;
  const read = readers.members.filter((m) => m.readAt);
  const title = [
    ...readers.members.map((m) => `${m.name}: ${m.readAt ? `read ${fmtDateTime(m.readAt)}` : "not read"}`),
    ...readers.others.map((m) => `${m.name}: read ${fmtDateTime(m.readAt ?? "")}`),
  ].join("\n");
  return (
    <span title={title} className="inline-flex items-center gap-1 text-xs text-ink-muted">
      <Eye className="h-3.5 w-3.5" />
      Read by {read.length} of {readers.members.length}
    </span>
  );
}

/** Under a message: who acknowledged, who still owes it, and the caller's own button. */
export function MessageAcks({
  acks,
  ackRequestId,
  onAcked,
}: {
  acks?: AckState[];
  ackRequestId?: string | null;
  onAcked: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const list = acks ?? [];
  if (list.length === 0 && !ackRequestId) return null;
  const done = list.filter((a) => a.ackedAt).length;

  async function handleAck() {
    if (!ackRequestId || busy) return;
    setBusy(true);
    try {
      await acknowledgeMessage(ackRequestId);
      toast.success("Acknowledged.");
      onAcked();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message.replace(/^\d+:\s*/, "") : "Could not acknowledge. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-dim/50 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {list.length > 0 ? (
          <span className="inline-flex items-center gap-1 font-semibold text-ink">
            <CheckCheck className="h-3.5 w-3.5 text-accent" />
            Acknowledged {done} of {list.length}
          </span>
        ) : (
          <span className="font-semibold text-ink">The sender asked you to acknowledge this email.</span>
        )}
        {ackRequestId && (
          <button
            type="button"
            disabled={busy}
            onClick={handleAck}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-2.5 py-1 text-[11px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MailCheck className="h-3.5 w-3.5" />}
            Acknowledge
          </button>
        )}
      </div>
      {list.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {list.map((a) => (
            <li
              key={a.userId}
              title={a.ackedAt ? `Acknowledged ${fmtDateTime(a.ackedAt)}` : a.overdue ? "Waiting more than 48 hours" : "Waiting"}
              className={cn(
                "rounded px-1.5 py-0.5 font-medium",
                a.ackedAt
                  ? "bg-green-100 text-green-800"
                  : a.overdue
                    ? "bg-red-100 text-red-700"
                    : "bg-amber-100 text-amber-800",
              )}
            >
              {a.name}
              {a.ackedAt ? "" : a.overdue ? " (overdue)" : " (waiting)"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "To acknowledge" in the inbox sidebar: what the caller still owes. */
export function PendingAcks({ onOpen }: { onOpen: (threadId: string) => void }) {
  const { data } = useQuery<OwedAck[]>(PENDING_KEY, () => api.get(PENDING_KEY), []);
  const owed = data ?? [];
  if (owed.length === 0) return null;
  return (
    <div className="space-y-0.5 rounded-md border border-amber-200 bg-amber-50 p-1.5">
      <p className="flex items-center gap-1.5 px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
        <MailCheck className="h-3 w-3" />
        To acknowledge ({owed.length})
      </p>
      {owed.slice(0, 5).map((o) => (
        <button
          key={o.messageId}
          type="button"
          onClick={() => onOpen(o.threadId)}
          title={`${o.fromName || o.fromAddress}: ${o.subject}`}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-ink hover:bg-amber-100"
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", o.overdue ? "bg-red-500" : "bg-amber-500")} />
          <span className="truncate">{o.subject}</span>
        </button>
      ))}
    </div>
  );
}
