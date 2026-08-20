/* Defect-file action timeline — the phone half of the defect review loop.
 *
 * Lifted out of MobilePMS.tsx so the save path can be rendered and driven by
 * a test on its own; that file is one of the largest in the repo and importing
 * it into a test drags in the whole PMS surface.
 */
import { createContext, useContext, useState } from "react";
import { api } from "../api/client";
import { useNotify } from "../vendor/scm/components/NotifyDialog";

// ── Defect-file ACTION TIMELINE (owner 2026-07-29) ──────────────
// Append-only Ongoing / Done log the purchaser (Sim) + BD stamp on each
// defect-list upload — every save ADDS an entry (status · name · time +
// optional remark); history is never overwritten. Mirrors the desktop
// TaskAttachmentRow timeline; provided by ProjectDetailView.
export type AttachmentAction = {
  id: number;
  attachment_id: number;
  status: string;
  remark: string | null;
  user_name?: string | null;
  created_at: string;
};
export const DefectActionsCtx = createContext<{
  actions: AttachmentAction[];
  canReview: boolean;
  canPurchase: boolean;
  reload: () => void;
} | null>(null);

export function DefectFileActions({ att }: { att: { id: number } }) {
  const ctx = useContext(DefectActionsCtx);
  const [draft, setDraft] = useState<null | "done" | "replace">(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const notify = useNotify();
  if (!ctx) return null;
  const list = ctx.actions.filter((x) => x.attachment_id === att.id);
  // Latest timeline entry drives the state machine: fresh (no action / legacy
  // 'ongoing') awaits the reviewer; 'replace' awaits the purchaser; 'done' is
  // resolved. Mirrors desktop TaskAttachmentRow.
  const latest = list.length ? list.reduce((m, a) => (a.id > m.id ? a : m)) : null;
  const isFresh = !latest || (latest.status !== "done" && latest.status !== "replace");
  const isEscalated = latest?.status === "replace";
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.post(`/api/projects/checklist/attachments/${att.id}/actions`, { status: draft, remark });
      setDraft(null);
      setRemark("");
      ctx.reload();
    } catch (e) {
      // The draft is still kept for the retry — but the operator is TOLD.
      // Swallowing this meant someone could stamp a defect photo "Done", have
      // the server refuse it, watch the spinner stop, and walk away believing
      // the defect was closed. The buttons that reach here are gated on a
      // client-side regex over position_name / role_name with no backend
      // capability behind it, so a refusal is a REACHABLE state here, not a
      // theoretical one.
      await notify({
        title: "Not saved",
        body: e instanceof Error ? e.message : "Please try again.",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };
  const ts = (v: string) => String(v || "").slice(0, 16).replace("T", " ");
  return (
    <div style={{ paddingLeft: 2 }}>
      {isFresh && ctx.canReview && (
        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <button className="tinybtn" disabled={saving} style={{ background: draft === "done" ? "#e2f0e9" : "#fff", borderColor: "#bcdcd7", color: "#2f8a5b", fontWeight: draft === "done" ? 800 : 700 }} onClick={() => setDraft("done")}>Done</button>
          <button className="tinybtn" disabled={saving} style={{ background: draft === "replace" ? "#f7e3e3" : "#fff", borderColor: "#e6bcbc", color: "#b4362f", fontWeight: draft === "replace" ? 800 : 700 }} onClick={() => setDraft("replace")}>Replace</button>
        </div>
      )}
      {isEscalated && ctx.canPurchase && (
        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <button className="tinybtn" disabled={saving} style={{ background: draft === "done" ? "#e2f0e9" : "#fff", borderColor: "#bcdcd7", color: "#2f8a5b", fontWeight: draft === "done" ? 800 : 700 }} onClick={() => setDraft("done")}>Done</button>
        </div>
      )}
      {draft && (
        <div style={{ marginTop: 6 }}>
          <textarea className="fld-i" value={remark} disabled={saving} rows={2} onChange={(e) => setRemark(e.target.value)} placeholder="Add a remark (optional)…" style={{ fontSize: 12, padding: "5px 8px", resize: "vertical" }} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
            <button className="tinybtn" disabled={saving} onClick={() => { setDraft(null); setRemark(""); }}>Cancel</button>
            <button className="tinybtn" disabled={saving} style={{ background: "#11140f", borderColor: "#11140f", color: "#fff" }} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      )}
      {list.length > 0 && (
        <div style={{ marginTop: 6, borderTop: "1px solid #eceee9", paddingTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          {[...list].reverse().map((a) => (
            <div key={a.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: a.status === "done" ? "#2f8a5b" : a.status === "replace" ? "#b4362f" : "#c9971f", flex: "none" }} />
                <span className="rbadge" style={{ background: a.status === "done" ? "#e2f0e9" : a.status === "replace" ? "#f7e3e3" : "#f6efd9", color: a.status === "done" ? "#2f8a5b" : a.status === "replace" ? "#b4362f" : "#6e4d12" }}>{a.status === "done" ? "Done" : a.status === "replace" ? "Replace" : "Ongoing"}</span>
                <span style={{ fontSize: 10.5, color: "#9aa093" }}>{a.user_name || "—"} · {ts(a.created_at)}</span>
              </div>
              {a.remark && <div style={{ fontSize: 11.5, color: "#6b6f63", marginLeft: 12, marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{a.remark}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
