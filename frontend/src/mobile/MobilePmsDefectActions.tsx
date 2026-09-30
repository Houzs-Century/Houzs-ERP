/* Defect-file action timeline — the phone half of the defect review loop.
 *
 * Lifted out of MobilePMS.tsx so the save path can be rendered and driven by
 * a test on its own; that file is one of the largest in the repo and importing
 * it into a test drags in the whole PMS surface.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api/client";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { parseDefectCaption } from "../pages/projects/defectRemark";

// A small image preview so people can tell what a defect photo is WITHOUT
// opening it (owner 2026-09-28: "make it can see a bit picture inside without
// click in"). Blob-URL'd through the same auth'd fetch the full-size viewer
// uses; revoked on unmount. Non-images render nothing. Kept local (not the
// MobilePMS R2Thumb, which is unexported and in a file at its size ceiling).
function DefectThumb({ r2Key, contentType }: { r2Key?: string | null; contentType?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = /^image\//i.test(contentType ?? "");
  useEffect(() => {
    if (!r2Key || !isImage) return;
    let live = true;
    let made: string | null = null;
    api
      .fetchBlobUrl(`/api/projects/attachments/${r2Key}`)
      .then((u) => { if (live) { made = u; setUrl(u); } else URL.revokeObjectURL(u); })
      // Preview only — a failed fetch leaves the hatched placeholder; the
      // full-size viewer surfaces the real error when the photo is opened.
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [r2Key, isImage]);
  if (!r2Key || !isImage) return null;
  const box: CSSProperties = { width: 72, height: 58, borderRadius: 7, border: "1px solid #e3e6e0", overflow: "hidden", flex: "none" };
  return url
    ? <img src={url} alt="" style={{ ...box, objectFit: "cover", display: "block" }} />
    : <div className="ph" style={box} />;
}

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

export function DefectFileActions({
  att,
  wide = false,
}: {
  att: { id: number; r2_key?: string; content_type?: string | null; caption?: string | null };
  /** B2 big-preview layout (owner 2026-09-30): the card already shows the
   *  photo full-width, so skip the small thumb; the Model/Reason strip and
   *  the Done/Replace pair render full-width under the preview instead. */
  wide?: boolean;
}) {
  const ctx = useContext(DefectActionsCtx);
  const [draft, setDraft] = useState<null | "done" | "replace">(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const notify = useNotify();
  if (!ctx) return null;
  // The photo's own Model + Reason, shown to EVERY viewer (owner 2026-09-28:
  // "make it these remark appear on mobilepms for all user can see this defect"
  // — previously the caption rendered only in the hidden tasklist, so nobody on
  // the card view, Shukor included, could read it). Above the action timeline
  // and never gated on review/purchase rights.
  const { model, reason } = parseDefectCaption(att.caption);
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
  // Wide (B2) button styling — big half-width outline buttons under the
  // full-width photo, per the owner's picked mockup.
  const wideBtn: CSSProperties | undefined = wide
    ? { flex: 1, padding: "9px 0", fontSize: 12.5, borderRadius: 9, textAlign: "center" }
    : undefined;
  return (
    <div style={{ paddingLeft: wide ? 0 : 2 }}>
      {wide ? (
        (model || reason) && (
          <div style={{ background: "#faf9f5", borderLeft: "3px solid #d8a85a", borderRadius: 7, padding: "7px 10px", fontSize: 11.5, lineHeight: 1.45, color: "#414539", marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {model && <div><b style={{ color: "#a16a2e" }}>Model:</b> {model}</div>}
            {reason && <div><b style={{ color: "#a16a2e" }}>Reason:</b> {reason}</div>}
          </div>
        )
      ) : (
        (att.r2_key || model || reason) && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 4 }}>
            <DefectThumb r2Key={att.r2_key} contentType={att.content_type} />
            {(model || reason) && (
              <div style={{ fontSize: 11.5, color: "#6b6f63", minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {model && <div><b style={{ color: "#8c968a" }}>Model:</b> {model}</div>}
                {reason && <div><b style={{ color: "#8c968a" }}>Reason:</b> {reason}</div>}
              </div>
            )}
          </div>
        )
      )}
      {isFresh && ctx.canReview && (
        <div style={{ display: "flex", gap: 6, marginTop: wide ? 8 : 2 }}>
          <button className="tinybtn" disabled={saving} style={{ ...wideBtn, background: draft === "done" ? "#e2f0e9" : "#fff", borderColor: "#bcdcd7", color: "#2f8a5b", fontWeight: draft === "done" ? 800 : 700 }} onClick={() => setDraft("done")}>Done</button>
          <button className="tinybtn" disabled={saving} style={{ ...wideBtn, background: draft === "replace" ? "#f7e3e3" : "#fff", borderColor: "#e6bcbc", color: "#b4362f", fontWeight: draft === "replace" ? 800 : 700 }} onClick={() => setDraft("replace")}>Replace</button>
        </div>
      )}
      {isEscalated && ctx.canPurchase && (
        <div style={{ display: "flex", gap: 6, marginTop: wide ? 8 : 2 }}>
          <button className="tinybtn" disabled={saving} style={{ ...wideBtn, background: draft === "done" ? "#e2f0e9" : "#fff", borderColor: "#bcdcd7", color: "#2f8a5b", fontWeight: draft === "done" ? 800 : 700 }} onClick={() => setDraft("done")}>Done</button>
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
