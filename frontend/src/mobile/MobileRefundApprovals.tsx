import { fmtSen } from "../../../shared/src/vendor/shared/format";
import { formatDate } from "../lib/utils";
import { useRefundApprovals, viewerMayApproveRefund } from "../vendor/scm/lib/payment-request-queries";
import { useRefundApprovalActions } from "../vendor/scm/lib/use-refund-approval-actions";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * MobileRefundApprovals — the phone twin of desktop RefundApprovals
 * (owner 2026-11-27: 「只要一级，但这一级的权限和cancel 的第二级一样」):
 * refund requests waiting for their one approval, on the Amendments
 * screen the same approvers already work. Shown only while one waits
 * and only to a viewer who may approve; tapping a card opens its order.
 * The approve / reject flow is the desktop's own shared hook.
 * ------------------------------------------------------------------ */

const cardBtn: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, padding: "7px 12px", borderRadius: 8,
  border: "1px solid var(--line, #d9d5cd)", background: "var(--card, var(--hz-c-surface))", color: "var(--ink, #221f20)",
};

export function MobileRefundApprovals({ onOpen, onChanged }: { onOpen: (docNo: string) => void; onChanged: (() => void) | null }) {
  const q = useRefundApprovals("open");
  const actions = useRefundApprovalActions(onChanged);
  const rows = q.data?.requests ?? [];
  if (!q.data?.mayApprove || rows.length === 0) return null;
  const me = q.data.me ?? null;

  return (
    <section aria-label="Refunds waiting approval" style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--mut2)" }}>
        Refunds waiting approval · {rows.length}
      </div>
      {rows.map((r) => (
        <div key={r.id} className="amd" style={{ textAlign: "left" }}>
          <div onClick={() => { if (r.refund_source_doc_no) onOpen(r.refund_source_doc_no); }}>
            <div className="r1">
              <span className="sono tnum">{r.refund_source_doc_no ?? r.request_no}</span>
              <span className="badge b-amber">Waiting approval</span>
            </div>
            <div className="amdno">
              <strong className="tnum">Refund {fmtSen(r.amount_sen)}</strong> to {r.payee_name}
            </div>
            <div className="amdno">"{r.purpose}"</div>
            <div className="foot">
              <span>Requested by {r.requested_by_name ?? "someone"}</span>
              <span className="tnum">{formatDate(r.created_at)}</span>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {viewerMayApproveRefund(r, me, true)
              ? (
                <>
                  <button type="button" style={cardBtn} disabled={actions.busy} onClick={() => void actions.approve(r)}>Approve</button>
                  <button type="button" style={cardBtn} disabled={actions.busy} onClick={() => void actions.reject(r)}>Reject</button>
                </>
              )
              : <span style={{ fontSize: 12, color: "var(--mut2)" }}>Your request — someone else approves it</span>}
          </div>
        </div>
      ))}
    </section>
  );
}

export default MobileRefundApprovals;
