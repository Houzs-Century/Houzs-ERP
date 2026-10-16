// Phone side of DEV-03 R12 "What may I see"; the desktop twin is
// VisibilityPanel in pages/MailCenter/mail-sidebar.tsx.
import { useMailVisibility } from "../pages/MailCenter/mail-sidebar";
import { LEVEL_LABEL, REACH_LABEL } from "../pages/MailCenter/mail-personal";

export function MobileVisibility() {
  const vis = useMailVisibility();
  if (!vis?.mailboxes) return null;
  return (
    <details style={{ marginBottom: 9, fontSize: 12, color: "#414539" }}>
      <summary style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", cursor: "pointer" }}>What may I see</summary>
      <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 10, background: "#f4f6f3" }}>
        <div style={{ marginBottom: 6 }}>
          {LEVEL_LABEL[vis.level] ?? vis.level}
          {vis.manage ? "; you can also manage mailboxes." : "."}
        </div>
        {vis.mailboxes.length === 0 && <div style={{ color: "var(--mut)" }}>No mailbox yet. Ask an admin to assign one.</div>}
        {vis.mailboxes.map((m) => (
          <div key={m.address} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
            <span style={{ fontFamily: "monospace", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.address}</span>
            <span style={{ flex: "none", color: "var(--mut)", fontSize: 11 }}>{REACH_LABEL[m.reach]}</span>
          </div>
        ))}
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--mut)" }}>
          You can send from {vis.sendFrom.length === 0 ? "no address yet" : vis.sendFrom.length === 1 ? vis.sendFrom[0] : `these ${vis.sendFrom.length} addresses`}.
        </div>
      </div>
    </details>
  );
}
