import { useMemo, useState } from "react";
import { useAmendments, type AmendmentRow } from "../vendor/scm/lib/so-amendment-queries";
import {
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
  simplifiedAmendmentPill,
  type StatusTone,
} from "../vendor/scm/lib/status-pill";
import {
  buildAmendmentQueueRows,
  type AmendmentQueueRow,
} from "../vendor/scm/lib/amendment-queue-rows";
import {
  useCancelRequests,
  viewerCanApprove,
  viewerCanReject,
  viewerCanWithdraw,
  type CancelRequestRow,
} from "../vendor/scm/lib/document-cancel-queries";
import {
  approveButtonLabel,
  approveIsFinal,
  useCancelRequestActions,
} from "../vendor/scm/lib/use-cancel-request-actions";
import { useRefreshApprovalBadges } from "../hooks/useAmendmentApprovals";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import { customerRefOf } from "../lib/customer-ref";
import { formatDate } from "../lib/utils";
import { useStaffLookup } from "../hooks/useStaffLookup";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile SO-Amendments queue — the phone twin of desktop
 * pages/scm-v2/Amendments.tsx. One inbox of every pending SO revision;
 * status chips filter it and tapping a card opens the SO in MobileSODetail,
 * which ALREADY hosts the amendment diff / supplier-confirm / approve gates
 * (from feat/mobile-so-line-edit-amendment). This screen only lists + routes.
 *
 * CANCELLATION REQUESTS ARE IN THIS LIST TOO (owner 2026-09-24: 「当有 SO
 * request cancel bill - 需要在 SO amendment 出现」), on the same rows and with
 * the same approve / reject / withdraw the desktop queue puts on them. The
 * merge, the row shape and the action flow are the SHARED layer the desktop
 * uses (vendor/scm/lib/amendment-queue-rows + use-cancel-request-actions) —
 * the two surfaces differ in presentation only.
 *
 * REAL-DATA DISCIPLINE: the list endpoint (GET /so-amendments →
 * { amendments: AmendmentRow[] }) returns id / so_doc_no / amendment_no /
 * status / lane / reason / requested_by / created_at, the bound POs and the
 * SO's reference. It carries no customer name and no per-line change kinds,
 * so the mockup's customer line and QTY/SPEC/ADD/REMOVE change-tags are
 * intentionally dropped rather than paid for with a per-row detail fetch —
 * those live on AmendmentDetail.lines, surfaced on the SO detail's diff view.
 * ------------------------------------------------------------------ */

// SIMPLIFIED status filter (owner 2026-07-24; Rejected added 2026-09-17): Requested /
// Approved / Rejected / All — same as the desktop queue. The granular backend enum
// is collapsed via amendmentBucketOf, a cancellation's own via cancelBucketOf.
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

// Simplified status TONE → mobile .b-* badge class (info=Requested,
// success=Approved, danger=Rejected). Mirrors MobileModuleList's TONE_BADGE_CLASS.
const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  neutral: "b-grey",
  info: "b-brand",
  progress: "b-amber",
  success: "b-green",
  danger: "b-red",
  pending: "b-amber",
};

/* The phone badge stays the ONE-WORD bucket. A cancellation's precise state
   ("waiting for level-2 approval (1 of 2)") is a sentence — as a badge beside
   the order number it wrapped the number onto three lines at 375px, so the
   sentence goes in the card body and the badge keeps the word. */
function StatusBadge({ row }: { row: AmendmentQueueRow }) {
  const { label, tone } = simplifiedAmendmentPill(row.bucket);
  return <span className={`badge ${TONE_BADGE_CLASS[tone]}`}>{label}</span>;
}

// Who signs it — the desktop queue's Approver badge, same word and colour.
function ApproverBadge({ row }: { row: AmendmentQueueRow }) {
  return (
    <span className="badge" style={{ background: row.approverTone.bg, color: row.approverTone.fg }} data-approver={row.approverKey}>
      {row.approverLabel}
    </span>
  );
}

const cardBtn: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, padding: "7px 12px", borderRadius: 8,
  border: "1px solid var(--line, #d9d5cd)", background: "var(--card, #fff)", color: "var(--ink, #221f20)",
};
const cardDangerBtn: React.CSSProperties = { ...cardBtn, borderColor: "var(--red, #B8331F)", color: "var(--red, #B8331F)" };

export function MobileAmendments({
  onBack,
  onOpen,
}: {
  onBack: () => void;
  onOpen: (docNo: string) => void;
}) {
  const [chip, setChip] = useState<string>("all");
  const { data, isLoading, error } = useAmendments();
  /* 'all' so the Approved / Rejected chips are true of cancellations too. A
     caller who may not read the cancellation inbox simply gets none of these
     rows — this read never fails the amendments list. */
  const cancels = useCancelRequests("all");
  // requested_by is a bare scm.staff uuid — same roster resolve as desktop.
  const { actorNameOf } = useStaffLookup();
  const { user, can } = useHouzsAuth();
  const viewer = useMemo(() => ({ userId: user?.id ?? null, can }), [user?.id, can]);
  const refreshBadges = useRefreshApprovalBadges();
  const cancelActions = useCancelRequestActions(refreshBadges);

  const referenceOf = (a: AmendmentRow) => customerRefOf({ ref: a.so_ref, customer_so_no: a.so_customer_so_no });
  const allRows = useMemo<AmendmentQueueRow[]>(
    () => buildAmendmentQueueRows(data?.amendments ?? [], cancels.data?.requests ?? [], referenceOf),
    [data, cancels.data],
  );
  const rows = useMemo<AmendmentQueueRow[]>(
    () => (chip === "all" ? allRows : allRows.filter((r) => r.bucket === chip)),
    [allRows, chip],
  );
  const openCount = useMemo(() => allRows.filter((r) => r.bucket === "REQUESTED").length, [allRows]);

  const body = (r: AmendmentQueueRow) => {
    const a = r.amendment;
    const amdNo = r.kind === "AMENDMENT" && r.numberLabel !== "—" ? r.numberLabel : null;
    const requester = r.requestedByName ?? actorNameOf(r.requestedByStaffId);
    return (
      <>
        <div className="r1">
          <span className="sono tnum">{r.soDocNo}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ApproverBadge row={r} />
            <StatusBadge row={r} />
          </span>
        </div>
        {r.reference && (
          <div className="amdno">
            Ref <span className="tnum">{r.reference}</span>
          </div>
        )}
        {(amdNo || r.reason) && (
          <div className="amdno">
            {amdNo ? <span className="tnum">Amendment #{amdNo}</span> : null}
            {r.kind === "CANCEL" ? <strong>Cancellation requested</strong> : null}
            {(amdNo || r.kind === "CANCEL") && r.reason ? " · " : ""}
            {r.reason ? `"${r.reason}"` : ""}
          </div>
        )}
        {r.kind === "CANCEL" && <div className="amdno">{r.statusLabel}</div>}
        {a && (a.lane_flag_note ?? "").trim() && (
          <div className="amdno" style={{ color: "var(--amber, #a66a00)" }}>
            Passed here by the other approver: "{a.lane_flag_note}"
          </div>
        )}
        <div className="foot">
          <span>Requested by {requester}</span>
          <span className="tnum">{formatDate(r.createdAt)}</span>
        </div>
      </>
    );
  };

  /* A cancellation card is a DIV, not the amendment card's <button>: it carries
     its own approve / reject buttons, and a button inside a button is invalid
     markup that swallows the taps. Tapping the card body still opens the SO. */
  const cancelCard = (r: AmendmentQueueRow, row: CancelRequestRow) => (
    <div key={r.key} className="amd" style={{ textAlign: "left" }}>
      <div onClick={() => onOpen(row.doc_key)}>{body(r)}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {viewerCanApprove(row, viewer) && (
          <button
            type="button"
            style={approveIsFinal(row) ? cardDangerBtn : cardBtn}
            disabled={cancelActions.busy}
            onClick={() => void cancelActions.approve(row)}
          >{approveButtonLabel(row)}</button>
        )}
        {row.status === "APPROVED" && (
          <button type="button" style={cardDangerBtn} disabled={cancelActions.busy}
            onClick={() => void cancelActions.executeNow(row)}>Cancel now</button>
        )}
        {viewerCanReject(row, viewer) && (
          <button type="button" style={cardBtn} disabled={cancelActions.busy}
            onClick={() => void cancelActions.reject(row)}>Reject</button>
        )}
        {viewerCanWithdraw(row, viewer) && (
          <button type="button" style={cardBtn} disabled={cancelActions.busy}
            onClick={() => void cancelActions.withdraw(row)}>Withdraw</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Menu
          </button>
          <span className="eyebrow">SO Revision Inbox</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">Amendments</div>
          {openCount > 0 && <span className="badge b-amber">{openCount} to action</span>}
        </div>

        <div className="chips" style={{ marginTop: 11 }}>
          {STATUS_CHIPS.map((s) => (
            <button key={s} onClick={() => setChip(s)} className={chip === s ? "chip on" : "chip"}>
              {amendmentBucketLabel(s)}
            </button>
          ))}
        </div>
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40 }}>
        {isLoading && (
          <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>
        )}
        {error && !isLoading && (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>
            Couldn't load amendments. Pull to retry.
          </div>
        )}

        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {rows.map((r) => (
              r.cancel
                ? cancelCard(r, r.cancel)
                : (
                  <button key={r.key} className="amd" onClick={() => onOpen(r.soDocNo)}>
                    {body(r)}
                  </button>
                )
            ))}
            {rows.length === 0 && (
              <div className="empty">
                <div className="empty-t">
                  {chip === "all" ? "No amendments yet." : `No ${amendmentBucketLabel(chip).toLowerCase()} amendments.`}
                </div>
                <div className="empty-s">Raise one from a processing-locked Sales Order.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MobileAmendments;
