// Phone side of Mail Center read state and acknowledgement (DEV-03 P2); the
// desktop twin is pages/MailCenter/mail-acks.tsx, which owns the API calls.
import { useState } from "react";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import {
  acknowledgeMessage,
  NEEDS_ACK_HINT,
  type AckState,
  type OwedAck,
  type ThreadReaders,
} from "../pages/MailCenter/mail-acks";

export function MobileReadBy({ readers }: { readers?: ThreadReaders | null }) {
  if (!readers || readers.members.length < 2) return null;
  const read = readers.members.filter((m) => m.readAt);
  const unread = readers.members.filter((m) => !m.readAt).map((m) => m.name);
  return (
    <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 8 }}>
      Read by {read.length} of {readers.members.length}
      {unread.length > 0 && <span> · not yet: {unread.join(", ")}</span>}
    </div>
  );
}

export function MobileMessageAcks({
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

  const ack = async () => {
    if (!ackRequestId || busy) return;
    setBusy(true);
    try {
      await acknowledgeMessage(ackRequestId);
      toast.success("Acknowledged.");
      onAcked();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't acknowledge.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 10, background: "#f4f6f3", fontSize: 11.5, color: "#414539" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, flex: 1 }}>
          {list.length > 0 ? `Acknowledged ${done} of ${list.length}` : "The sender asked you to acknowledge this email."}
        </span>
        {ackRequestId && (
          <button onClick={ack} disabled={busy} className="tinybtn" style={{ height: 26, padding: "0 10px", fontWeight: 700 }}>
            {busy ? "Saving…" : "Acknowledge"}
          </button>
        )}
      </div>
      {list.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
          {list.map((a) => (
            <span
              key={a.userId}
              style={{
                padding: "2px 7px",
                borderRadius: 6,
                fontWeight: 600,
                background: a.ackedAt ? "#e3f4e8" : a.overdue ? "#fbe9e7" : "#fdf3e1",
                color: a.ackedAt ? "#1f6b3a" : a.overdue ? "#b42318" : "#b54708",
              }}
            >
              {a.name}
              {a.ackedAt ? "" : a.overdue ? " (overdue)" : " (waiting)"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function MobileNeedsAck({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "#414539" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>
        <span style={{ fontWeight: 700 }}>Needs acknowledgement</span>
        <span style={{ display: "block", fontSize: 11, color: "var(--mut)" }}>{NEEDS_ACK_HINT}</span>
      </span>
    </label>
  );
}

/** "To acknowledge" strip above the phone's thread list. */
export function MobilePendingAcks({ onOpen }: { onOpen: (threadId: string) => void }) {
  const { data } = useQuery<OwedAck[]>("/api/mail-center/acks/pending", () => api.get("/api/mail-center/acks/pending"), []);
  const owed = data ?? [];
  if (owed.length === 0) return null;
  return (
    <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 11, background: "#fdf3e1", border: "1px solid #f1d9a8" }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#8a5a00", marginBottom: 4 }}>To acknowledge ({owed.length})</div>
      {owed.slice(0, 5).map((o) => (
        <button
          key={o.messageId}
          onClick={() => onOpen(o.threadId)}
          style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 0", background: "none", border: 0, textAlign: "left", fontSize: 12.5, color: "#11140f" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 3, flex: "none", background: o.overdue ? "#d92d20" : "#f79009" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.subject}</span>
        </button>
      ))}
    </div>
  );
}
