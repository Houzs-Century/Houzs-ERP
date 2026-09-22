// 复开 (owner 2026-09-22) — the mobile twin of components/assr/ReopenCaseControl.
// Shows a "Reopen" button only on a completed/voided case; a portal modal
// captures the new complaint + the re-assessment stage, POSTs /reopen, reloads.
// Self-contained (own api + notify) so MobileServiceCase.tsx, at its ceiling,
// only mounts one line.
import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";

const INK = "#11140f";
const MUTED = "#767b6e";
const LINE = "#d6d9d2";
const TEAL = "#0f6d63";

const STAGE_OPTIONS = [
  { value: "under_verification", label: "Verify (inspect the new problem)" },
  { value: "pending_solution", label: "Solution (decide the fix)" },
  { value: "pending_review", label: "Review (start from the top)" },
];
const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 11px", border: `1px solid ${LINE}`, borderRadius: 9, fontSize: 14, marginTop: 4 };

export function MobileReopenControl({
  caseId,
  stage,
  disabled,
  onReopened,
  notify,
}: {
  caseId: number;
  stage: string | null | undefined;
  disabled: boolean;
  onReopened: () => void;
  notify: (o: { title: string; body?: string; tone?: "error" }) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const [complaint, setComplaint] = useState("");
  const [reopenStage, setReopenStage] = useState("under_verification");
  const [busy, setBusy] = useState(false);

  const isClosed = stage === "completed" || stage === "voided";
  if (disabled || !isClosed) return null;

  const submit = async () => {
    const text = complaint.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/assr/${caseId}/reopen`, { complaint: text, stage: reopenStage });
      setOpen(false);
      setComplaint("");
      onReopened();
    } catch (e: unknown) {
      await notify({ title: "Couldn't reopen the case", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="tinybtn"
        style={{ width: "100%", height: 42, marginTop: 8, fontSize: 13.5, fontWeight: 700, color: TEAL, borderColor: TEAL }}
      >
        Reopen for a new complaint
      </button>
      {open
        ? createPortal(
            <div
              style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "flex-end" }}
              onClick={() => !busy && setOpen(false)}
            >
              <div
                style={{ width: "100%", background: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, boxSizing: "border-box" }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ fontSize: 15, fontWeight: 800, color: INK }}>Reopen for a new complaint</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                  The first complaint stays on the timeline; the new one below replaces the current complaint and the case reactivates.
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 12 }}>New complaint</div>
                <textarea style={{ ...inp, minHeight: 70 }} autoFocus value={complaint} placeholder="What is the customer reporting this time?" onChange={(e) => setComplaint(e.target.value)} />
                <div style={{ fontSize: 11, color: MUTED, marginTop: 10 }}>Reopen at stage</div>
                <select style={inp} value={reopenStage} onChange={(e) => setReopenStage(e.target.value)}>
                  {STAGE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button className="tinybtn" style={{ flex: 1, height: 44 }} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
                  <button
                    onClick={submit}
                    disabled={busy || !complaint.trim()}
                    style={{ flex: 2, height: 44, border: "none", borderRadius: 11, background: TEAL, color: "#fff", fontWeight: 700, fontSize: 14, opacity: busy || !complaint.trim() ? 0.55 : 1 }}
                  >
                    {busy ? "Reopening…" : "Reopen case"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
