// Phone side of DEV-03 R12 "What may I see"; the desktop twin is
// VisibilityPanel in pages/MailCenter/mail-sidebar.tsx.
import { useMailVisibility } from "../pages/MailCenter/mail-sidebar";
import { LEVEL_LABEL, REACH_LABEL } from "../pages/MailCenter/mail-personal";
import { useMailClaim } from "../pages/MailCenter/mail-claim";

const field = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 10, border: "1px solid #d9ddd5", fontSize: 13, background: "#fff" } as const;

/** HC-0157 A, phone side of ClaimMyAddress in pages/MailCenter/mail-sidebar.tsx. */
function MobileClaimAddress() {
  const claim = useMailClaim();
  const offer = claim.offer;
  if (!offer || offer.address) return null;
  return (
    <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 12, background: "#f4f6f3", fontSize: 12, color: "#414539" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", marginBottom: 4 }}>Claim my address</div>
      <div style={{ marginBottom: 8 }}>Pick your company address. You can claim it once; an admin can change it later.</div>
      <div style={{ ...field, display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
        <input
          value={claim.value}
          onChange={(e) => claim.setValue(e.target.value)}
          aria-label="Address name"
          autoCapitalize="none"
          style={{ flex: 1, minWidth: 0, border: 0, outline: "none", padding: "8px 10px", fontFamily: "monospace", fontSize: 13, background: "transparent" }}
        />
        <span style={{ paddingRight: 10, fontFamily: "monospace", fontSize: 12, color: "var(--mut)" }}>@{offer.domain}</span>
      </div>
      {offer.department ? (
        <div style={{ marginTop: 6, color: "var(--mut)" }}>Department: {offer.department.name} (from the Org Chart)</div>
      ) : (
        <select
          value={claim.departmentId ?? ""}
          onChange={(e) => claim.setDepartmentId(e.target.value ? Number(e.target.value) : null)}
          aria-label="Department"
          style={{ ...field, marginTop: 6 }}
        >
          <option value="">Which department do you work in?</option>
          {offer.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      {(claim.problem ?? claim.error) && <div style={{ marginTop: 6, color: "#b42318" }}>{claim.problem ?? claim.error}</div>}
      <button
        type="button"
        className="btn"
        disabled={!claim.ready}
        onClick={() => void claim.submit()}
        style={{ width: "100%", marginTop: 8, opacity: claim.ready ? 1 : 0.5 }}
      >
        {claim.busy ? "Claiming…" : `Claim ${claim.value.trim().toLowerCase() || "…"}@${offer.domain}`}
      </button>
      {claim.needsDepartment && <div style={{ marginTop: 6, fontSize: 11, color: "var(--mut)" }}>An admin confirms your department.</div>}
    </div>
  );
}

export function MobileVisibility() {
  const vis = useMailVisibility();
  if (!vis?.mailboxes) return null;
  return (
    <>
    {!vis.myAddress && <MobileClaimAddress />}
    <details style={{ marginBottom: 9, fontSize: 12, color: "#414539" }}>
      <summary style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", cursor: "pointer" }}>What may I see</summary>
      <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 10, background: "#f4f6f3" }}>
        <div style={{ marginBottom: 6 }}>
          {LEVEL_LABEL[vis.level] ?? vis.level}
          {vis.manage ? "; you can also manage mailboxes." : "."}
        </div>
        {vis.mailboxes.length === 0 && <div style={{ color: "var(--mut)" }}>No mailbox yet. Claim your address above.</div>}
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
    </>
  );
}
