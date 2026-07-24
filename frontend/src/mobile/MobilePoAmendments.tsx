import { useMemo, useState } from "react";
import { usePoAmendments, type PoAmendmentRow } from "../vendor/scm/lib/po-amendment-queries";
import {
  simplifiedAmendmentPill,
  amendmentBucketOf,
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
  type StatusTone,
} from "../vendor/scm/lib/status-pill";
import { formatDate } from "../lib/utils";
import { useStaffLookup } from "../hooks/useStaffLookup";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile PO-Amendments queue — the phone twin of desktop
 * pages/scm-v2/PoAmendments.tsx and the PO sibling of MobileAmendments.
 * One inbox of every Purchase Order amendment; the SIMPLIFIED status chips
 * (Requested / Approved / All) filter it and tapping a card opens the PO
 * amendment job card (MobilePoAmendmentDetail) — the diff + single-approver
 * gate. This screen only lists + routes.
 *
 * REAL-DATA DISCIPLINE: the list endpoint (GET /po-amendments) returns id /
 * po_number / amendment_no / status / reason / requested_by / created_at only —
 * no supplier name, no per-line change kinds. Those live on the detail.
 * ------------------------------------------------------------------ */

const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

// Open = the REQUESTED bucket (awaiting approval) — the "N to action" count.
const IS_OPEN = (s: string) => amendmentBucketOf(s) === "REQUESTED";

const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  neutral: "b-grey",
  info: "b-brand",
  progress: "b-amber",
  success: "b-green",
  danger: "b-red",
  pending: "b-amber",
};

function AmendmentBadge({ status }: { status: string }) {
  const { label, tone } = simplifiedAmendmentPill(status);
  return <span className={`badge ${TONE_BADGE_CLASS[tone]}`}>{label}</span>;
}

export function MobilePoAmendments({
  onBack,
  onOpen,
}: {
  onBack: () => void;
  onOpen: (amendmentId: string) => void;
}) {
  const [chip, setChip] = useState<string>("all");
  const { data, isLoading, error } = usePoAmendments();
  const { actorNameOf } = useStaffLookup();

  const allRows = useMemo<PoAmendmentRow[]>(() => data?.amendments ?? [], [data]);
  const rows = useMemo<PoAmendmentRow[]>(
    () => (chip === "all" ? allRows : allRows.filter((a) => amendmentBucketOf(a.status) === chip)),
    [allRows, chip],
  );
  const openCount = useMemo(() => allRows.filter((a) => IS_OPEN(a.status)).length, [allRows]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Menu
          </button>
          <span className="eyebrow">PO Revision Inbox</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">PO Amendments</div>
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
            {rows.map((a) => {
              const amdNo = a.amendment_no != null && String(a.amendment_no).trim() !== "" ? String(a.amendment_no) : null;
              const reason = (a.reason ?? "").trim();
              return (
                <button key={a.id} className="amd" onClick={() => onOpen(a.id)}>
                  <div className="r1">
                    <span className="sono tnum">{a.po_number}</span>
                    <AmendmentBadge status={a.status} />
                  </div>
                  {(amdNo || reason) && (
                    <div className="amdno">
                      {amdNo ? <span className="tnum">{amdNo}</span> : null}
                      {amdNo && reason ? " · " : ""}
                      {reason ? `"${reason}"` : ""}
                    </div>
                  )}
                  <div className="foot">
                    <span>Requested by {actorNameOf(a.requested_by)}</span>
                    <span className="tnum">{formatDate(a.created_at)}</span>
                  </div>
                </button>
              );
            })}
            {rows.length === 0 && (
              <div className="empty">
                <div className="empty-t">
                  {chip === "all" ? "No amendments yet." : `No ${amendmentBucketLabel(chip).toLowerCase()} amendments.`}
                </div>
                <div className="empty-s">Raise one from a Purchase Order on desktop.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MobilePoAmendments;
