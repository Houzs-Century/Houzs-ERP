// ----------------------------------------------------------------------------
// AmendmentQuickView — the side drawer a SINGLE click on an amendment queue row
// opens, the way a click on a Sales Order list row opens its quick view (owner
// 2026-09-14: 「SO / PO amendment需要单击打开 弹窗 像SO这样」). Double-click still
// opens the job card.
//
// Read-only on purpose: who asked, why, who signs, and what changes. The
// per-line WAS / REQUESTING cards are the job cards' own
// (so-amendment-diff-card / po-amendment-diff-card), so the drawer can never
// show a change differently from the page an approver signs on. Approve,
// reject and withdraw stay on that page — "Open full page" — where their
// permission checks and confirmations live.
// ----------------------------------------------------------------------------

import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, X as XIcon } from "lucide-react";
import { fmtDateTime } from "../../vendor/shared/format";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { AmendmentStatusPill } from "../../vendor/scm/components/StatusPill";
import { AmendmentApproverBadge } from "../../vendor/scm/components/AmendmentApproverBadge";
import {
  PO_AMENDMENT_APPROVER,
  soAmendmentApprover,
  type AmendmentApprover,
} from "../../vendor/scm/lib/amendment-approver";
import { useAmendmentDetail, type AmendmentLine } from "../../vendor/scm/lib/so-amendment-queries";
import { usePoAmendmentDetail } from "../../vendor/scm/lib/po-amendment-queries";
import { visibleAmendmentLines } from "../../vendor/scm/lib/so-amendment-line-diff";
import {
  amendmentHeaderDiffRows,
  type SoAmendmentHeaderChanges,
} from "../../vendor/scm/lib/so-amendment-header";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { formatDate } from "../../lib/utils";
import { SoAmendmentDiffCard } from "./so-amendment-diff-card";
import { PoAmendmentDiffCard, poAmendmentHeaderDiffRows } from "./po-amendment-diff-card";

/** Which amendment the drawer shows. `label` is the row's amendment number,
 *  shown at once while the detail loads. */
export type AmendmentQuickViewTarget = { kind: "so" | "po"; id: string; label: string };

/** The job card a row opens — one answer for the click-through and the drawer. */
export const amendmentJobCardPath = (t: Pick<AmendmentQuickViewTarget, "kind" | "id">): string =>
  t.kind === "so" ? `/scm/amendments/${t.id}` : `/scm/po-amendments/${t.id}`;

type HeaderRow = { key: string; label: string; from: string; to: string };

export function AmendmentQuickView({
  target,
  onClose,
}: {
  target: AmendmentQuickViewTarget | null;
  onClose: () => void;
}) {
  return (
    <ResizableDetailDrawer
      open={target != null}
      onClose={onClose}
      ariaLabel={target ? `Amendment ${target.label}` : "Amendment details"}
    >
      {target?.kind === "so" && <SoAmendmentBody key={target.id} target={target} onClose={onClose} />}
      {target?.kind === "po" && <PoAmendmentBody key={target.id} target={target} onClose={onClose} />}
    </ResizableDetailDrawer>
  );
}

function SoAmendmentBody({ target, onClose }: { target: AmendmentQuickViewTarget; onClose: () => void }) {
  const q = useAmendmentDetail(target.id);
  const a = q.data?.amendment ?? null;
  const lines = visibleAmendmentLines((q.data?.lines ?? []) as AmendmentLine[]);
  const headerRows = amendmentHeaderDiffRows(
    a?.header_changes as SoAmendmentHeaderChanges | null | undefined,
    a?.old_header_snapshot as SoAmendmentHeaderChanges | null | undefined,
    formatDate,
  );
  const boundPos = (q.data?.purchaseOrders ?? []).map((p) => p.po_number).join(", ");
  return (
    <QuickViewFrame
      target={target}
      title={String(a?.amendment_no ?? target.label)}
      subtitle="Sales Order amendment"
      onClose={onClose}
    >
      <DetailState isLoading={q.isLoading} error={q.error} ready={a != null}>
        {a && (
          <>
            <Summary
              docLabel="Sales Order"
              status={a.status}
              docNo={a.so_doc_no}
              approver={soAmendmentApprover(a.lane)}
              requestedBy={a.requested_by}
              createdAt={a.created_at}
              reason={a.reason}
              laneFlagNote={a.lane_flag_note ?? null}
              resolution={a.resolution ?? null}
              rejectionReason={a.rejection_reason ?? null}
              extra={boundPos ? { k: "Bound POs", v: boundPos } : null}
            />
            <Changes headerRows={headerRows} lineCount={lines.length}>
              {lines.map((l) => <SoAmendmentDiffCard key={l.id} line={l} />)}
            </Changes>
          </>
        )}
      </DetailState>
    </QuickViewFrame>
  );
}

function PoAmendmentBody({ target, onClose }: { target: AmendmentQuickViewTarget; onClose: () => void }) {
  const q = usePoAmendmentDetail(target.id);
  const a = q.data?.amendment ?? null;
  const lines = q.data?.lines ?? [];
  const headerRows = poAmendmentHeaderDiffRows(a?.header_changes ?? null, a?.old_header_snapshot ?? null);
  return (
    <QuickViewFrame
      target={target}
      title={String(a?.amendment_no ?? target.label)}
      subtitle="PO amendment"
      onClose={onClose}
    >
      <DetailState isLoading={q.isLoading} error={q.error} ready={a != null}>
        {a && (
          <>
            <Summary
              docLabel="Purchase Order"
              status={a.status}
              docNo={q.data?.purchaseOrder?.po_number ?? a.po_number}
              approver={PO_AMENDMENT_APPROVER}
              requestedBy={a.requested_by}
              createdAt={a.created_at}
              reason={a.reason}
              resolution={a.resolution ?? null}
              rejectionReason={a.rejection_reason ?? null}
              extra={null}
            />
            <Changes headerRows={headerRows} lineCount={lines.length}>
              {lines.map((l) => <PoAmendmentDiffCard key={l.id} line={l} />)}
            </Changes>
          </>
        )}
      </DetailState>
    </QuickViewFrame>
  );
}

function QuickViewFrame({
  target,
  title,
  subtitle,
  onClose,
  children,
}: {
  target: AmendmentQuickViewTarget;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <>
      <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
        <button
          type="button"
          onClick={onClose}
          className="text-sidebar-ink-muted hover:text-sidebar-ink"
          aria-label="Close details"
        >
          <XIcon size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14px] font-bold tracking-wide">{title}</div>
          <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={() => navigate(amendmentJobCardPath(target))}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
        >
          Open full page <ExternalLink size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </>
  );
}

function DetailState({
  isLoading,
  error,
  ready,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  ready: boolean;
  children: ReactNode;
}) {
  if (isLoading) {
    return <div className="py-10 text-center text-[12px] text-ink-muted">Loading amendment…</div>;
  }
  /* A refusal must reach the reader — an empty drawer would read as "this
     amendment changes nothing". */
  if (error || !ready) {
    return (
      <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[12.5px] text-err">
        <strong className="font-semibold">Could not load this amendment.</strong>{" "}
        {error instanceof Error ? error.message : "Open the full page to try again."}
      </div>
    );
  }
  return <>{children}</>;
}

function Summary({
  docLabel,
  status,
  docNo,
  approver,
  requestedBy,
  createdAt,
  reason,
  laneFlagNote = null,
  resolution,
  rejectionReason,
  extra,
}: {
  docLabel: string;
  status: string;
  docNo: string | null | undefined;
  approver: AmendmentApprover;
  requestedBy: string | null | undefined;
  createdAt: string | null | undefined;
  reason: string | null | undefined;
  /** Option B (2026-09-15): the requester's doubt about the approver, SO rows only. */
  laneFlagNote?: string | null;
  resolution: "REJECTED" | "WITHDRAWN" | null;
  rejectionReason: string | null;
  extra: { k: string; v: string } | null;
}) {
  const { actorNameOf } = useStaffLookup();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[19px] font-bold text-ink">{docNo || "—"}</span>
        <span className="text-[12.5px] text-ink-muted">{docLabel}</span>
        <AmendmentStatusPill status={status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
        <MetaItem k="Approver" v={<AmendmentApproverBadge approver={approver} />} />
        <MetaItem k="Requested by" v={actorNameOf(requestedBy)} />
        <MetaItem k="Created" v={createdAt ? fmtDateTime(createdAt) : "—"} />
        {extra && <MetaItem k={extra.k} v={extra.v} />}
      </dl>
      {(reason ?? "").trim() && (
        <>
          <SectionHeading>Reason</SectionHeading>
          <p className="text-[13px] leading-relaxed text-ink-secondary">{reason}</p>
        </>
      )}
      {(laneFlagNote ?? "").trim() && (
        <div className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-ink">
          <div className="font-semibold">The approver flagged this as being on the wrong desk.</div>
          <div className="mt-1">“{laneFlagNote}”</div>
        </div>
      )}
      {resolution && (
        <div className="mt-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
          <div className="font-semibold">
            {resolution === "WITHDRAWN" ? "Withdrawn by the person who raised it." : "Rejected."}
          </div>
          {rejectionReason && <div className="mt-1">“{rejectionReason}”</div>}
        </div>
      )}
    </>
  );
}

function Changes({
  headerRows,
  lineCount,
  children,
}: {
  headerRows: HeaderRow[];
  lineCount: number;
  children: ReactNode;
}) {
  return (
    <>
      {headerRows.length > 0 && (
        <>
          <SectionHeading>Order changes · {headerRows.length}</SectionHeading>
          <div className="space-y-2">
            {headerRows.map((d) => (
              <div key={d.key} className="rounded-md border border-border px-3 py-2.5 text-[12px]">
                <div className="font-medium text-ink">{d.label}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-ink-muted">
                  <span className="line-through">{d.from}</span>
                  <span aria-hidden>&rarr;</span>
                  <span className="font-medium text-ink">{d.to}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <SectionHeading>Line changes · {lineCount}</SectionHeading>
      {lineCount === 0 ? (
        <div className="text-[12px] text-ink-muted">
          {headerRows.length > 0 ? "No line changes — only the order details above." : "No line changes recorded."}
        </div>
      ) : (
        <div className="space-y-2.5">{children}</div>
      )}
    </>
  );
}

function MetaItem({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className="mt-0.5 text-[13px] font-semibold text-ink">{v}</dd>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </div>
  );
}
