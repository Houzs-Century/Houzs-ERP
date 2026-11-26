import { useMemo, useState } from "react";
import { usePoAmendments } from "../vendor/scm/lib/po-amendment-queries";
import { useAmendments } from "../vendor/scm/lib/so-amendment-queries";
import {
  buildPoAmendmentInbox,
  PO_AMENDMENT_INBOX_SOURCE_LABEL,
  type PoAmendmentInboxRow,
} from "../vendor/scm/lib/po-amendment-inbox";
import {
  simplifiedAmendmentPill,
  amendmentBucketOf,
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
  compareAmendmentsForList,
  type StatusTone,
} from "../vendor/scm/lib/status-pill";
import {
  AMENDMENT_APPROVER_LABEL,
  AMENDMENT_APPROVER_TONE,
  type AmendmentApprover,
} from "../vendor/scm/lib/amendment-approver";
import { formatDate } from "../lib/utils";
import { useStaffLookup } from "../hooks/useStaffLookup";
import "./mobile.css";


const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

const IS_OPEN = (s: string) => amendmentBucketOf(s) === "REQUESTED";

const OPEN_ORDER = compareAmendmentsForList<PoAmendmentInboxRow>((a) => a.status, (a) => a.createdAt);

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

function ApproverBadge({ approver }: { approver: AmendmentApprover }) {
  const { bg, fg } = AMENDMENT_APPROVER_TONE[approver];
  return <span className="badge" style={{ background: bg, color: fg }}>{AMENDMENT_APPROVER_LABEL[approver]}</span>;
}

export function MobilePoAmendments({
  onBack,
  onOpen,
  onOpenSo,
}: {
  onBack: () => void;
  onOpen: (amendmentId: string) => void;
  onOpenSo: (docNo: string) => void;
}) {
  const [chip, setChip] = useState<string>("all");
  const poQ = usePoAmendments();
  const soQ = useAmendments();
  const isLoading = poQ.isLoading || soQ.isLoading;
  const error = poQ.error ?? soQ.error;
  const { actorNameOf } = useStaffLookup();

  const allRows = useMemo<PoAmendmentInboxRow[]>(
    () => buildPoAmendmentInbox(poQ.data?.amendments ?? [], soQ.data?.amendments ?? []).sort(OPEN_ORDER),
    [poQ.data, soQ.data],
  );
  const rows = useMemo<PoAmendmentInboxRow[]>(
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

        {!isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {rows.map((a) => {
              const amdNo = a.amendmentNo.trim() !== "" ? a.amendmentNo : null;
              const reason = (a.reason ?? "").trim();
              return (
                <button key={a.key} className="amd" onClick={() => (a.kind === "so" ? onOpenSo(a.soDocNo) : onOpen(a.id))}>
                  <div className="r1">
                    <span className="sono tnum">{a.poLabel}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <ApproverBadge approver={a.approver} />
                      <AmendmentBadge status={a.status} />
                    </span>
                  </div>
                  {a.kind === "so" && (
                    <div className="amdno">
                      {PO_AMENDMENT_INBOX_SOURCE_LABEL.so} · <span className="tnum">{a.soDocNo}</span>
                    </div>
                  )}
                  {(amdNo || reason) && (
                    <div className="amdno">
                      {amdNo ? <span className="tnum">{amdNo}</span> : null}
                      {amdNo && reason ? " · " : ""}
                      {reason ? `"${reason}"` : ""}
                    </div>
                  )}
                  <div className="foot">
                    <span>Requested by {actorNameOf(a.requestedBy)}</span>
                    <span className="tnum">{formatDate(a.createdAt)}</span>
                  </div>
                </button>
              );
            })}
            {rows.length === 0 && !error && (
              <div className="empty">
                <div className="empty-t">
                  {chip === "all" ? "No amendments yet." : `No ${amendmentBucketLabel(chip).toLowerCase()} amendments.`}
                </div>
                <div className="empty-s">Raise one from a Purchase Order on desktop, or revise a Sales Order with a bound PO.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MobilePoAmendments;
