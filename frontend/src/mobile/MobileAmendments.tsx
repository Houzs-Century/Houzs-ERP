import { useMemo, useState } from "react";
import { useAmendments, type AmendmentRow } from "../vendor/scm/lib/so-amendment-queries";
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
 * Mobile SO-Amendments queue — the phone twin of desktop
 * pages/scm-v2/Amendments.tsx. One inbox of every pending SO revision;
 * status chips filter it and tapping a card opens the SO in MobileSODetail,
 * which ALREADY hosts the amendment diff / supplier-confirm / approve gates
 * (from feat/mobile-so-line-edit-amendment). This screen only lists + routes.
 *
 * REAL-DATA DISCIPLINE: the list endpoint (GET /so-amendments →
 * { amendments: AmendmentRow[] }) returns id / so_doc_no / amendment_no /
 * status / reason / requested_by / created_at ONLY. It carries no customer
 * name and no per-line change kinds, so the mockup's customer line and
 * QTY/SPEC/ADD/REMOVE change-tags are intentionally dropped rather than
 * paid for with a per-row detail fetch — those live on AmendmentDetail.lines,
 * surfaced on the SO detail's diff view.
 * ------------------------------------------------------------------ */

// SIMPLIFIED status filter (owner 2026-07-24): Requested / Approved / All — same
// as the desktop queue. The granular backend enum is collapsed via
// amendmentBucketOf; the closed (REJECTED) rows are reached through "All".
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

// Amendments still awaiting an action — the REQUESTED bucket (open / in-flight);
// the header "N to action" count.
const IS_OPEN = (s: string) => amendmentBucketOf(s) === "REQUESTED";

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

function AmendmentBadge({ status }: { status: string }) {
  const { label, tone } = simplifiedAmendmentPill(status);
  return <span className={`badge ${TONE_BADGE_CLASS[tone]}`}>{label}</span>;
}

export function MobileAmendments({
  onBack,
  onOpen,
}: {
  onBack: () => void;
  onOpen: (docNo: string) => void;
}) {
  const [chip, setChip] = useState<string>("all");
  const { data, isLoading, error } = useAmendments();
  // requested_by is a bare scm.staff uuid — same roster resolve as desktop.
  const { actorNameOf } = useStaffLookup();

  const allRows = useMemo<AmendmentRow[]>(() => data?.amendments ?? [], [data]);
  const rows = useMemo<AmendmentRow[]>(
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
            {rows.map((a) => {
              const amdNo = a.amendment_no != null && String(a.amendment_no).trim() !== "" ? String(a.amendment_no) : null;
              const reason = (a.reason ?? "").trim();
              return (
                <button key={a.id} className="amd" onClick={() => onOpen(a.so_doc_no)}>
                  <div className="r1">
                    <span className="sono tnum">{a.so_doc_no}</span>
                    <AmendmentBadge status={a.status} />
                  </div>
                  {(amdNo || reason) && (
                    <div className="amdno">
                      {amdNo ? <span className="tnum">Amendment #{amdNo}</span> : null}
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
