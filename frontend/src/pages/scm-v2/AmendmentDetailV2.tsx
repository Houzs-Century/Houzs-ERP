// ----------------------------------------------------------------------------
// AmendmentDetailV2 — the SO-amendment job card. A dedicated read-first detail
// page for one revision, reachable from the Amendments queue
// (pages/scm-v2/Amendments.tsx). Until now the queue routed a row straight into
// the SO / PO inline editor and there was no amendment detail surface at all —
// so this follows the owner-approved job-card mockup (jobcard-reorg-mockup):
//
//   • a revision-status hero (Requested -> Supplier Pending -> SO/PO Approved
//     -> Sent), tone + label from the canonical resolveStatusPill('soAmendment')
//   • a main column with the before -> after diff per changed line
//     (qty / spec / price / add / remove), each line's variants shown on BOTH
//     sides via the shared buildVariantSummary
//   • an aside with Requested-by, the permission-gated supplier-confirm /
//     approve-so gate actions (the same vendored hooks the mobile flow uses),
//     a hop into the SO / bound-PO editor for the later gates, and a Recent
//     activity timeline derived from the amendment's own audit timestamps.
//
// Shell matches the desktop scm-v2 detail style: Section + DetailGrid /
// DetailMain / DetailAside (SalesOrderDetailV2), with a local AsideCard clone
// (AsideCard is not exported from that page). No hand-rolled amendment logic —
// the diff data, status pill and variant summary are all shared.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ClipboardCheck,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Printer,
  Undo2,
  XCircle,
} from "lucide-react";
import { generateAmendmentPdf } from "../../vendor/scm/lib/amendment-pdf";
import { amendmentPrintedStatus, soAmendmentToPdfInput } from "../../vendor/scm/lib/amendment-pdf-map";
import { fmtDateTime, fmtMoneySen } from "@2990s/shared";
import { Button } from "../../components/Button";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
import { ModalOverlay } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { StatusPill } from "../../vendor/scm/components/StatusPill";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import {
  resolveStatusPill,
  type StatusTone,
} from "../../vendor/scm/lib/status-pill";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import {
  useAmendmentDetail,
  useSupplierConfirm,
  useApproveSo,
  useRejectAmendment,
  useWithdrawAmendment,
  type AmendmentLine,
} from "../../vendor/scm/lib/so-amendment-queries";
import { humanApiError } from "../../vendor/scm/lib/authed-fetch";
import { useSalesOrderAuditLog } from "../../vendor/scm/lib/sales-order-queries";
import {
  buildAmendmentDecisionHistory,
  isRejectDecision,
} from "../../vendor/scm/lib/so-amendment-history";
import {
  amendmentHeaderDiffRows,
  soHeaderFieldKind,
  type SoAmendmentHeaderChanges,
} from "../../vendor/scm/lib/so-amendment-header";
import {
  amendmentLineChangedFields,
  amendmentLineFieldKinds,
  amendmentOldSnapshot,
  amendmentUnrenderedAxes,
  amendmentVariantSummaries,
  visibleAmendmentLines,
} from "../../vendor/scm/lib/so-amendment-line-diff";
import {
  RowRoutingChips,
  AmendmentTypeBadges,
  AmendmentRoutingBlock,
} from "../../vendor/scm/components/AmendmentRouting";
import type { AmendmentFieldKind } from "../../vendor/scm/lib/amendment-routing";
import { useAuth as useHouzsAuth } from "../../auth/AuthContext";
/* The 2990 bridge's staff row — the vocabulary so_amendments.requested_by is
   written in (a scm.staff uuid), so this is what "did I raise this?" compares. */
import { useAuth as useScmAuth } from "../../vendor/scm/lib/auth";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { PrintPreviewModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn, formatDate } from "../../lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

/* Amendment prices are stored in sen (1/100 MYR). The amendment detail has no
   currency of its own, so the SO's home currency (MYR) is the honest default. */
const fmtSen = (sen: number | null | undefined): string => fmtMoneySen(sen);

/* change_type -> plain label (parity with the desktop AmendmentDiffModal +
   mobile AmendmentDiffSheet). */
const changeTypeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

/* Read an unknown audit field off the amendment blob as a trimmed string. */
const asStr = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};


/* old_snapshot reader — shared with the desktop modal + mobile sheet, so the
   three surfaces can never drift on what "before" means. */
const oldOf = amendmentOldSnapshot;

/* Every failed gate action on this page reports through here. authedFetch hangs
   the raw status + body off the thrown error, which humanApiError turns into the
   house plain sentence; anything else falls back to the error's own message.
   Owner's standing ruling: a save that fails must SAY so — a user who believes
   it saved and finds out later that it did not is the unacceptable case. */
const plainError = (e: unknown): string => {
  const err = e as { status?: number; body?: string; message?: string };
  if (typeof err?.status === "number" && typeof err?.body === "string") {
    return humanApiError(err.status, err.body);
  }
  return err?.message ?? "Something went wrong. Please try again.";
};

// ─── Revision-status stepper (4 stages; SO/PO approved collapse into one) ────

type Stage = { key: string; label: string };
const STAGES: Stage[] = [
  { key: "REQUESTED", label: "Requested" },
  { key: "SUPPLIER_PENDING", label: "Supplier" },
  { key: "APPROVED", label: "Approved" },
  { key: "SENT", label: "Sent" },
];

/* Map a raw amendment status to how far along the 4-stage stepper it has
   reached (index of the furthest completed stage). REJECTED is off-path. */
const stageIndexOf = (status: string): number => {
  switch (status) {
    case "REQUESTED": return 0;
    case "SUPPLIER_PENDING": return 1;
    case "SO_APPROVED":
    case "PO_APPROVED": return 2;
    case "SENT": return 3;
    default: return -1; // REJECTED / unknown
  }
};

/* Two-lane rework (2026-07-27): a LANE amendment is ONE signature — its whole
   life is Requested → Applied (SO_APPROVED as terminal). The legacy 4-stage
   chain above stays for pre-rework (lane NULL) rows. */
export type SoAmendmentLaneValue = "LINES" | "DELIVERY";
const LANE_STAGES: Stage[] = [
  { key: "REQUESTED", label: "Requested" },
  { key: "APPLIED", label: "Applied" },
];
const laneStageIndexOf = (status: string): number => {
  switch (status) {
    case "REQUESTED": return 0;
    case "SO_APPROVED": return 1;
    default: return -1; // REJECTED / unknown
  }
};
export const LANE_TITLE: Record<SoAmendmentLaneValue, string> = {
  LINES: "Product lines · Purchasing",
  DELIVERY: "Delivery · Logistics",
};

/* Hero accent dot per status tone — the dark hero can't use the light-surface
   tone.fg/bg, so map the canonical tone to a hero-friendly dot class. */
const HERO_DOT: Record<StatusTone, string> = {
  success: "bg-synced",
  danger: "bg-err",
  progress: "bg-accent-bright",
  pending: "bg-accent-bright",
  info: "bg-accent-bright",
  neutral: "bg-sidebar-ink-muted",
};

// ─── Aside card (local clone of SalesOrderDetailV2's private AsideCard) ──────

function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

// ─── Revision-status hero ───────────────────────────────────────────────────

function RevisionHero({
  status,
  amendmentNo,
  soRevision,
  resolution,
  rejectionReason,
  lane = null,
}: {
  status: string;
  amendmentNo: string | null;
  soRevision: number | null;
  resolution: string | null;
  rejectionReason: string | null;
  lane?: SoAmendmentLaneValue | null;
}) {
  const { label, tone } = resolveStatusPill(lane ? "soAmendmentLane" : "soAmendment", status);
  const stages = lane ? LANE_STAGES : STAGES;
  const reached = lane ? laneStageIndexOf(status) : stageIndexOf(status);
  const rejected = status === "REJECTED";

  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Revision status
      </div>
      <div className="mt-1.5 flex items-center gap-2.5">
        <span className={cn("h-2.5 w-2.5 rounded-full", HERO_DOT[tone])} />
        <span className="font-display text-[26px] font-bold leading-none tracking-tight text-white">
          {label}
        </span>
      </div>
      {amendmentNo && (
        <div className="mt-1 font-mono text-[12px] text-sidebar-ink-muted">
          {amendmentNo}
        </div>
      )}

      {rejected ? (
        <div className="mt-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
          <div className="font-semibold">
            {resolution === "WITHDRAWN"
              ? "This request was withdrawn by the person who raised it."
              : "This amendment was rejected — the Sales Order keeps its prior revision."}
          </div>
          {/* The reason is the whole point of a refusal: without it the requester
              can only guess and resubmit, which is what produced competing
              amendment documents on one order. mig 0149 persists it on the row;
              before that it survived only in the SO's audit note. */}
          {rejectionReason && (
            <div className="mt-1.5 font-normal text-err/90">"{rejectionReason}"</div>
          )}
          <div className="mt-1.5 font-normal text-sidebar-ink-muted">
            This Sales Order is free again — a corrected amendment can be raised on it.
          </div>
        </div>
      ) : (
        // Stage stepper (4 legacy / 2 lane) — reached stages fill accent, the
        // current stage rings.
        <div className="mt-5 flex items-center">
          {stages.map((s, i) => {
            const isDone = i < reached;
            const isCurrent = i === reached;
            return (
              <div key={s.key} className="flex flex-1 flex-col items-center">
                <div className="flex w-full items-center">
                  <span
                    className={cn(
                      "h-[2px] flex-1",
                      i === 0 ? "opacity-0" : isDone || isCurrent ? "bg-accent-bright" : "bg-white/15"
                    )}
                  />
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                      isDone
                        ? "bg-accent-bright text-sidebar"
                        : isCurrent
                          ? "bg-white text-sidebar ring-2 ring-accent-bright ring-offset-2 ring-offset-sidebar"
                          : "bg-white/15 text-sidebar-ink-muted"
                    )}
                  >
                    {isDone ? <CheckCircle2 size={12} /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "h-[2px] flex-1",
                      i === stages.length - 1 ? "opacity-0" : isDone ? "bg-accent-bright" : "bg-white/15"
                    )}
                  />
                </div>
                <span
                  className={cn(
                    "mt-1.5 text-[9.5px] font-semibold uppercase tracking-wider",
                    isDone || isCurrent ? "text-sidebar-ink" : "text-sidebar-ink-muted"
                  )}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {typeof soRevision === "number" && (
        <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
          <span className="text-[12.5px] text-sidebar-ink-muted">SO revision</span>
          <span className="font-money text-[13px] font-semibold text-sidebar-ink">
            r{soRevision}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Per-line before -> after diff card ─────────────────────────────────────

/* Owner 2026-07-16 — WAS / REQUESTING used to be two plain columns you had to
   diff character-by-character. The changed field is now emphasised on the
   Requesting side and struck through on the Was side: the SAME idiom the header
   diff rows above already use, so the card gains a signal, not a redesign.
   Unchanged fields stay muted on both sides — they are context, not the ask. */
const wasCls = (changed: boolean, base: string): string =>
  cn(base, changed && "line-through decoration-ink-muted/60");
/* Owner 2026-07-27 — the changed value on the Requesting side is now RED (was
   petrol) so the approver's eye lands on exactly what the customer is asking to
   change. Unchanged fields stay muted context on both sides. */
const nowCls = (changed: boolean, base: string): string =>
  cn(base, changed ? "font-semibold text-err" : "text-ink-muted");

function DiffCard({ line }: { line: AmendmentLine }) {
  const old = oldOf(line);
  const { to: newSummary, from: oldSummary } = amendmentVariantSummaries(line);
  const changed = amendmentLineChangedFields(line);
  const isAdd = line.change_type === "ADD";
  const isRemove = line.change_type === "REMOVE";
  /* An axis this line carries that the summary above cannot show. Normally
     empty. When it is not, the spec strings are INCOMPLETE, and a short spec
     string on the Requesting side is precisely what reads as "the amendment
     deleted my divan height". Say it out loud instead. */
  const unrendered = amendmentUnrenderedAxes(line);
  const unrenderedAll = [...new Set([...unrendered.from, ...unrendered.to])];

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
          {changeTypeLabel(line.change_type)}
        </span>
        <RowRoutingChips kinds={amendmentLineFieldKinds(line)} />
      </div>
      <div className="grid grid-cols-2 divide-x divide-border-subtle">
        {/* Before */}
        <div className="p-3">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Was
          </div>
          {isAdd ? (
            <div className="mt-1 text-[12px] text-ink-muted">New line — nothing before</div>
          ) : (
            <>
              <div className={wasCls(changed.itemCode, "mt-1 font-mono text-[13px] font-semibold text-ink")}>
                {old.itemCode ?? "—"}
              </div>
              <div className="mt-0.5 font-money text-[11.5px] text-ink-muted">
                <span className={wasCls(changed.qty, "")}>Qty {old.qty ?? "—"}</span>
                {typeof old.unitPriceSen === "number" ? (
                  <>
                    {" · "}
                    <span className={wasCls(changed.unitPrice, "")}>{fmtSen(old.unitPriceSen)}</span>
                  </>
                ) : ""}
              </div>
              {oldSummary && (
                <div className={wasCls(changed.variants, "mt-1.5 text-[11px] font-semibold text-ink-secondary")}>
                  {oldSummary}
                </div>
              )}
              {/* mig 0280 — the line's REMARK before the request. Shown only when
                  the request touches it, so an untouched instruction does not add
                  noise to every card. */}
              {changed.remark && (old.remark ?? "").trim() && (
                <div className={wasCls(true, "mt-1.5 text-[11px] italic text-ink-secondary")}>
                  “{old.remark}”
                </div>
              )}
              {/* mig 0317 — the discount before the request. Shown only when the
                  request touches it, same rule as the remark above. */}
              {changed.discount && (
                <div className={wasCls(true, "mt-1 font-money text-[11.5px]")}>
                  Discount {fmtSen(old.discountSen ?? 0)}
                </div>
              )}
            </>
          )}
        </div>
        {/* After */}
        <div className="p-3">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Requesting
          </div>
          {isRemove ? (
            <div className="mt-1 text-[12px] font-semibold text-err">Removed</div>
          ) : (
            <>
              <div className={nowCls(changed.itemCode, "mt-1 font-mono text-[13px]")}>
                {line.new_item_code ?? old.itemCode ?? "—"}
              </div>
              <div className="mt-0.5 font-money text-[11.5px]">
                <span className={nowCls(changed.qty, "")}>Qty {line.new_qty ?? old.qty ?? "—"}</span>
                {typeof line.new_unit_price_sen === "number" ? (
                  <>
                    <span className="text-ink-muted">{" · "}</span>
                    <span className={nowCls(changed.unitPrice, "")}>{fmtSen(line.new_unit_price_sen)}</span>
                  </>
                ) : ""}
              </div>
              {newSummary && (
                <div className={nowCls(changed.variants, "mt-1.5 text-[11px]")}>
                  {newSummary}
                </div>
              )}
              {/* mig 0280 — the REQUESTED remark. On a service line this text IS
                  the request ("Please take back Cody Bedframe (King Size) 2
                  units"), so an approver who cannot read it is approving a line
                  with no visible purpose. Empty string = a request to CLEAR the
                  remark, which must say so rather than render as nothing. */}
              {changed.remark && (
                <div className={nowCls(true, "mt-1.5 text-[11px] italic")}>
                  {(line.new_remark ?? "").trim() ? `“${line.new_remark}”` : "Remark cleared"}
                </div>
              )}
              {/* mig 0317 — the REQUESTED discount. On a delivery-fee line this
                  number IS the request (unit stays derived; the discount is the
                  sanctioned reduction), so an approver who cannot see it is
                  signing a money change blind. 0 = a request to clear it. */}
              {changed.discount && (
                <div className={nowCls(true, "mt-1 font-money text-[11.5px]")}>
                  {Math.round(line.new_discount_sen ?? 0) > 0
                    ? `Discount ${fmtSen(line.new_discount_sen ?? 0)}`
                    : "Discount cleared"}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {unrenderedAll.length > 0 && (
        <div className="border-t border-border-subtle bg-warn/10 px-3 py-2 text-[11.5px] text-ink">
          This line also carries {unrenderedAll.join(", ")}, which the summary above
          cannot display. Open the Sales Order to check the full specification before approving.
        </div>
      )}
    </div>
  );
}

// ─── Supplier-confirmation modal (REQUESTED -> SUPPLIER_PENDING) ────────────
// Captures the supplier's acknowledgement (ref required; note / attachment key
// optional) and advances the gate via the vendored useSupplierConfirm — the
// same mutation the desktop SupplierConfirmForm + mobile sheet use. The server
// 403 / 409 stays the real gate (humanised by authed-fetch).

function SupplierConfirmModal({
  amendmentId,
  onClose,
}: {
  amendmentId: string;
  onClose: () => void;
}) {
  const supplierConfirm = useSupplierConfirm();
  const notify = useNotify();
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [attachmentKey, setAttachmentKey] = useState("");

  const submit = () => {
    if (!ref.trim()) {
      notify({
        title: "Supplier reference is required",
        body: "Enter the supplier's confirmation reference.",
        tone: "error",
      });
      return;
    }
    supplierConfirm.mutate(
      {
        id: amendmentId,
        ref: ref.trim(),
        note: note.trim() || undefined,
        attachmentKey: attachmentKey.trim() || undefined,
      },
      {
        onSuccess: () => {
          notify({ title: "Supplier confirmation recorded" });
          onClose();
        },
        onError: (e) =>
          notify({
            title: "Could not record the confirmation",
            body: e instanceof Error ? e.message : "Something went wrong.",
            tone: "error",
          }),
      }
    );
  };

  const inputCls =
    "mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-primary/60";

  return (
    <ModalOverlay
      open
      onClose={onClose}
      title="Record supplier confirmation"
      icon={<ClipboardCheck size={16} />}
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={supplierConfirm.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={supplierConfirm.isPending}>
            {supplierConfirm.isPending ? "Recording…" : "Record confirmation"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Supplier confirmation ref *
          </span>
          <input
            className={inputCls}
            value={ref}
            placeholder="e.g. supplier WhatsApp / email ref"
            onChange={(e) => setRef(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Attachment key (optional)
          </span>
          <input
            className={inputCls}
            value={attachmentKey}
            placeholder="R2 object key, if any"
            onChange={(e) => setAttachmentKey(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Note (optional)
          </span>
          <input
            className={inputCls}
            value={note}
            placeholder="Anything the supplier flagged"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
    </ModalOverlay>
  );
}

// ─── Decision history (the amendment's approve / reject audit trail) ─────────
// Owner 2026-07-18 — every approve AND reject is now visible with who, when, and
// the reason. Sourced from mfg_so_audit_log (the ONLY place a rejection's actor /
// time / reason survives — the reject gate stores no column), via the shared
// buildAmendmentDecisionHistory. Desktop + mobile read it identically.

type TimelineEvent = { title: string; meta: string; note: string | null; isReject: boolean };

function ActivityTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <div className="text-[12px] text-ink-muted">No activity recorded yet.</div>;
  }
  return (
    <div>
      {events.map((e, i) => {
        const isLast = i === events.length - 1;
        return (
          <div key={`${e.title}-${i}`} className="flex gap-3 pb-3.5 last:pb-0">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 h-2 w-2 rounded-full",
                  e.isReject ? "bg-err" : i === 0 ? "bg-primary" : "bg-border-strong"
                )}
              />
              {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
            </div>
            <div className="min-w-0">
              <div className={cn("text-[12.5px] font-semibold", e.isReject ? "text-err" : "text-ink")}>
                {e.title}
              </div>
              <div className="mt-0.5 text-[11px] text-ink-muted">{e.meta}</div>
              {e.note && (
                <div className="mt-0.5 text-[11px] italic text-ink-secondary">{e.note}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function AmendmentDetailV2() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useHouzsAuth();
  const { staff: currentStaff } = useScmAuth();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const { actorNameOf } = useStaffLookup();

  // isPending, NOT isLoading — see the gate below.
  const { data, isPending, error } = useAmendmentDetail(id ?? null);
  const approveSo = useApproveSo();
  const [showSupplierModal, setShowSupplierModal] = useState(false);

  const amendment = (data?.amendment ?? null) as (Record<string, unknown> & {
    status?: string;
    amendment_no?: number | string | null;
    lane?: string | null;
    reason?: string | null;
    requested_by?: string | null;
    created_at?: string | null;
    so_doc_no?: string;
  }) | null;
  /* Two-lane rework: 'LINES' | 'DELIVERY' on post-rework rows; NULL keeps the
     legacy supplier-confirmed two-gate UI below untouched. */
  const lane: SoAmendmentLaneValue | null =
    amendment?.lane === "LINES" || amendment?.lane === "DELIVERY" ? amendment.lane : null;
  /* The follow-up PO Amendments this amendment auto-raised when its LINES lane
     applied (the purchaser's second signature). REJECTED here = "PO not
     followed up" — the SO changed but the PO deliberately did not. */
  const poFollowUps = ((data as {
    poFollowUps?: Array<{
      id: string; po_number?: string | null; amendment_no?: string | null;
      status?: string | null; resolution?: string | null;
    }>;
  } | undefined)?.poFollowUps ?? []);
  /* Owner 2026-07-16 — only lines that ACTUALLY request something. A recorded
     line whose new_* equals its own old_snapshot is not a change: it must not
     render as a card and must not count. Pre-fix rows are already in the DB, so
     the filter stays regardless of the builder fix. */
  const lines = useMemo(
    () => visibleAmendmentLines((data?.lines ?? []) as AmendmentLine[]),
    [data],
  );
  /* How many line rows were RECORDED, before the delta filter. When this is
     non-zero but `lines` is empty, every recorded line is a no-op — say so
     rather than showing nothing (a legacy pre-fix amendment reads this way). */
  const recordedLineCount = (data?.lines ?? []).length;
  const salesOrder = data?.salesOrder ?? null;
  const boundPo = data?.purchaseOrders?.[0] ?? null;

  /* The HEADER half of the request (mig 0119) — the frozen fields this amendment
     asks to change, paired with the values they replace. Shared builder so this
     job card, the desktop SO-detail diff modal and the mobile sheet all render
     it identically. Empty on a line-only amendment. */
  const headerDiffs = useMemo(
    () => amendmentHeaderDiffRows(
      amendment?.header_changes as SoAmendmentHeaderChanges | null | undefined,
      amendment?.old_header_snapshot as SoAmendmentHeaderChanges | null | undefined,
      formatDate,
    ),
    [amendment],
  );

  const changeCount = headerDiffs.length + lines.length;

  /* Every routable atom this amendment moves — lines + header — for the type
     badge(s) and the department-routing block. */
  const allFieldKinds = useMemo<AmendmentFieldKind[]>(() => {
    const fromLines = lines.flatMap((l) => amendmentLineFieldKinds(l));
    const fromHeader = headerDiffs.map((d) => soHeaderFieldKind(d.key) as AmendmentFieldKind);
    return [...fromLines, ...fromHeader];
  }, [lines, headerDiffs]);

  const status = String(amendment?.status ?? "");
  const soDocNo = String(amendment?.so_doc_no ?? "");
  const amendmentNo =
    amendment?.amendment_no != null ? String(amendment.amendment_no) : null;

  useSetBreadcrumbs([
    { label: "Amendments", to: "/scm/amendments" },
    { label: amendmentNo ?? "Amendment" },
  ]);

  /* The approve / reject decision trail (owner 2026-07-18). Read the SO audit log
     and keep only THIS amendment's AMENDMENT_* rows (created_at floor). This is
     the only source that carries a rejection's actor / time / reason. */
  const { data: auditEntries } = useSalesOrderAuditLog(soDocNo || null);
  const timeline = useMemo<TimelineEvent[]>(() => {
    const decisions = buildAmendmentDecisionHistory(
      auditEntries,
      asStr(amendment?.created_at),
    );
    return decisions.map((d) => ({
      title: d.label,
      meta: d.actor ? `${fmtDateTime(d.at)} · ${d.actor}` : fmtDateTime(d.at),
      note: d.note,
      isReject: isRejectDecision(d.action),
    }));
  }, [auditEntries, amendment]);

  /* Printable amendment document (owner-approved layout). Same client-side
     mechanism as the SO/PO PDFs — the operator downloads / prints / WhatsApps it.
     Status label is the SIMPLIFIED Requested / Approved the owner asked for
     (the multi-step backend states collapse to those two on the document). */
  const deliverPrintPdf = (action: PdfAction) => {
    if (!amendment) return;
    const input = soAmendmentToPdfInput({
      amendment: {
        amendment_no: amendmentNo,
        status,
        reason,
        created_at: asStr(amendment.created_at) || null,
        requested_by_name: actorNameOf(asStr(amendment.requested_by)),
        so_approved_by_name: amendment.so_approved_by ? actorNameOf(asStr(amendment.so_approved_by)) : null,
        so_approved_at: asStr(amendment.so_approved_at) || null,
      },
      lines: (data?.lines ?? []) as never,
      salesOrder: salesOrder as never,
      customerName: (salesOrder as { customer_name?: string | null } | null)?.customer_name ?? null,
    });
    return Promise.resolve(generateAmendmentPdf(input, { action })).catch((e: unknown) =>
      notify({ title: "PDF generation failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }),
    );
  };
  const print = usePrintPreview(deliverPrintPdf);

  /* Legacy (lane NULL) keys — untouched. */
  const canSupplierConfirm = !lane && can("scm.amendment.supplier_confirm");
  const canApproveSo = !lane && can("scm.amendment.approve_so");
  /* Two-lane rework: ONE signature per lane — LINES is purchasing's
     (approve_lines), DELIVERY is logistics' (approve_delivery). Super admin
     passes via the * wildcard. */
  const canApproveLane =
    lane != null
    && can(lane === "LINES" ? "scm.amendment.approve_lines" : "scm.amendment.approve_delivery");
  /* Reject rides the row's own approver gate: the lane key on lane rows, the
     legacy purchasing gate (approve_po) on pre-rework rows — mirroring the
     backend exactly so the button cannot appear for someone the server will
     refuse. */
  const canReject = lane ? canApproveLane : can("scm.amendment.approve_po");

  /* Withdraw is the REQUESTER's own escape hatch, which reject cannot be: reject
     is gated to approve_po, which a salesperson does not hold. Without it the
     person who raised a mistaken amendment could neither correct it nor close
     it, so their only move was to raise ANOTHER one — which is how one Sales
     Order ended up carrying two or three competing amendment documents with
     nothing to say which was authoritative (Owner 2026-07-19).

     Matched on the amendment's requested_by staff uuid against the caller's own.
     The server re-checks this; the UI check only decides whether to offer it. */
  const isRequester =
    asStr(amendment?.requested_by) != null
    && currentStaff?.id != null
    && String(amendment?.requested_by) === String(currentStaff.id);
  const canWithdraw = status === "REQUESTED" && (isRequester || canReject);

  const rejectAmendment = useRejectAmendment();
  const withdrawAmendment = useWithdrawAmendment();

  const handleReject = async () => {
    if (!id || !amendment) return;
    /* The reason is MANDATORY — the server 400s without one. A refusal that does
       not say why leaves the requester guessing and resubmitting, which is the
       competing-documents problem this whole change exists to end. */
    const reason = await askPrompt({
      title: `Reject amendment ${amendmentNo ?? ""}?`.trim(),
      body: "The Sales Order keeps its current revision and nothing is changed. "
        + "Say what is wrong so the person who raised it knows what to fix — they will see this.",
      placeholder: "e.g. supplier cannot supply PC151-01 in this fabric",
      multiline: true,
      confirmLabel: "Reject amendment",
      validate: (v) =>
        v.trim().length < 5
          ? "Give a reason the requester can act on — at least a few words."
          : null,
    });
    if (reason == null) return; // cancelled
    try {
      await rejectAmendment.mutateAsync({ id, reason: reason.trim() });
      notify({
        title: "Amendment rejected",
        body: "The person who raised it can see your reason and raise a corrected request.",
      });
    } catch (e) {
      notify({
        title: "Could not reject this amendment",
        body: `${plainError(e)} Nothing was changed — please try again.`,
        tone: "error",
      });
    }
  };

  const handleWithdraw = async () => {
    if (!id || !amendment) return;
    if (
      !(await askConfirm({
        title: `Withdraw amendment ${amendmentNo ?? ""}?`.trim(),
        body: "This closes the request without changing the Sales Order. It cannot be reopened — "
          + "but withdrawing frees the order so you can raise a corrected amendment straight away.",
        confirmLabel: "Withdraw request",
        danger: true,
      }))
    )
      return;
    const reason = await askPrompt({
      title: "Why are you withdrawing it?",
      body: "Optional — this is recorded on the Sales Order's history so the next person can follow what happened.",
      placeholder: "e.g. raised against the wrong line",
      multiline: true,
      confirmLabel: "Withdraw request",
    });
    if (reason == null) return; // cancelled at the second step
    try {
      await withdrawAmendment.mutateAsync({ id, reason: reason.trim() || undefined });
      notify({
        title: "Amendment withdrawn",
        body: "This Sales Order is free again — open it and submit a corrected amendment when you are ready.",
      });
    } catch (e) {
      notify({
        title: "Could not withdraw this amendment",
        body: `${plainError(e)} It is still open — please try again.`,
        tone: "error",
      });
    }
  };

  const handleApproveSo = async () => {
    if (!id || !amendment) return;
    if (
      !(await askConfirm({
        title: `Approve ${lane ? "amendment" : "SO revision"} for ${soDocNo}?`,
        body: lane === "LINES"
          ? "Check with the supplier BEFORE approving — your signature records that the change "
            + "is workable. The Sales Order is revised at once (the current version is snapshotted "
            + "into Revisions), and a follow-up PO Amendment is raised for you to confirm the "
            + "purchase-order side. This cannot be undone."
          : lane === "DELIVERY"
            ? "This applies the delivery changes to the Sales Order at once (the current version "
              + "is snapshotted into Revisions). The purchase order is not touched. This cannot be undone."
            : "This applies the supplier-confirmed changes: the Sales Order is re-derived and the "
              + "current version is snapshotted into Revisions. This cannot be undone.",
        confirmLabel: lane ? "Approve & apply" : "Approve revision",
      }))
    )
      return;
    approveSo.mutate(
      { id },
      {
        onSuccess: (res: unknown) => {
          const followUps = ((res as { poFollowUps?: Array<{ amendmentNo?: string; poNumber?: string }> } | undefined)?.poFollowUps ?? []);
          const warnings = ((res as { warnings?: string[] } | undefined)?.warnings ?? []);
          notify({
            title: lane ? "Amendment applied" : "SO revision approved",
            body: [
              followUps.length
                ? `Follow-up PO amendment${followUps.length === 1 ? "" : "s"} raised: ${followUps.map((f) => `${f.amendmentNo ?? ""} (${f.poNumber ?? ""})`).join("; ")} — confirm ${followUps.length === 1 ? "it" : "them"} in PO Amendments.`
                : "",
              ...warnings,
            ].filter(Boolean).join(" ") || undefined,
          });
        },
        onError: (e) =>
          notify({
            title: lane ? "Could not apply this amendment" : "Could not approve the revision",
            body: `${plainError(e)} The Sales Order was NOT changed — please try again.`,
            tone: "error",
          }),
      }
    );
  };

  const goBack = () => navigate("/scm/amendments");
  const openSalesOrder = () =>
    soDocNo && navigate(`/scm/sales-orders/${soDocNo}?edit=1`);
  /* Smart jump (owner 2026-07-27) — the two-lane flow materialises the PO leg
     as a follow-up PO Amendment: while one still awaits the purchaser's
     signature, the bound-PO jump lands on ITS job card (where the signing
     happens). Legacy rows (no follow-up) keep landing on the PO editor, whose
     Revision-ready banner hosts Approve PO; once revised, land on the
     read-only PO detail instead. */
  const pendingFollowUp =
    poFollowUps.find((f) => {
      const s = (f.status ?? "").toUpperCase();
      return s !== "APPROVED" && s !== "REJECTED";
    }) ?? null;
  const openBoundPo = () => {
    // Click-time closure — poRevised is declared just below and initialised
    // long before any click can land.
    if (!poRevised && pendingFollowUp) {
      navigate(`/scm/po-amendments/${pendingFollowUp.id}`);
      return;
    }
    if (boundPo?.id) {
      navigate(
        poRevised
          ? `/scm/purchase-orders/${boundPo.id}`
          : `/scm/purchase-orders/${boundPo.id}?edit=1`,
      );
    }
  };

  // Later gates (approve-po / send) live on the bound-PO editor surface, so
  // once the SO gate has cleared we hand off there rather than duplicating the
  // received-floor handling here.
  const pastSoGate = status === "SO_APPROVED" || status === "PO_APPROVED" || status === "SENT";
  /* Whether the bound PO has actually been re-derived yet. approve-so rewrites
     the SALES ORDER only; the PO is rewritten by the separate approve-po gate
     (reviseBoundPo). The stepper collapses both into one "Approved" stage, so
     without this the page called a PO "revised" from the moment the SO was. */
  const poRevised = status === "PO_APPROVED" || status === "SENT";

  // isPending covers pending-but-not-fetching (disabled / offline-paused), which
  // isLoading reports as false — letting those states fall through to the error
  // branch and paint "Couldn't load this amendment" before any fetch had run.
  if (isPending) {
    return (
      <div className="animate-fade-in p-8 text-center text-[13px] text-ink-muted">
        Loading amendment…
      </div>
    );
  }
  if (error || !amendment) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load this amendment
        </div>
        <p className="text-[13px] text-ink-muted">
          {(error as Error | undefined)?.message ?? "The amendment was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Amendments
          </Button>
        </div>
      </div>
    );
  }

  const reason = asStr(amendment.reason);

  return (
    <div className="pb-10">
      {/* ─── Desktop sticky header ──────────────────────────────────── */}
      {/* lg:top-[52px] = the single 2b top-chrome bar (see Layout.tsx
          PageHeader — the lg stickies move together). */}
      <div className="sticky top-12 lg:top-[52px] z-20 -mx-4 border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Amendments"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  Amendment{amendmentNo ? ` ${amendmentNo}` : ""}
                </h1>
                <StatusPill docType={lane ? "soAmendmentLane" : "soAmendment"} status={status} />
                {lane && (
                  <span className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                    {LANE_TITLE[lane]}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">{soDocNo}</span>
                <span className="text-ink-muted/50">·</span>
                {/* The honest total — header fields + genuinely-changed lines.
                    It used to count every RECORDED line, so an amendment whose
                    lines were all no-ops advertised "4 changes" and showed four
                    identical cards. */}
                <span>
                  {changeCount} change{changeCount === 1 ? "" : "s"}
                </span>
                {asStr(amendment.created_at) && (
                  <>
                    <span className="text-ink-muted/50">·</span>
                    <span>Raised {fmtDateTime(String(amendment.created_at))}</span>
                  </>
                )}
              </div>
              <AmendmentTypeBadges kinds={allFieldKinds} className="mt-2" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Owner 2026-07-27: the header jump actions read as a UNIFORM
                bordered pair (secondary) — the naked ghost next to a boxed
                secondary looked like plain text + a stray box, off-theme. */}
            <Button variant="secondary" icon={<GitBranch size={14} />} onClick={openSalesOrder}>
              Open Sales Order
            </Button>
            {pastSoGate && boundPo?.id && (
              /* Owner 2026-07-27: while the PO revision is still OWED (bound PO
                 not yet revised) this is the page's pending action — petrol
                 primary. Once revised it calms back to secondary. */
              <Button variant={poRevised ? "secondary" : "primary"} icon={<ExternalLink size={14} />} onClick={openBoundPo}>
                {/* At SO_APPROVED the PO has NOT been revised — approve-so
                    rewrites the Sales Order and nothing else. Calling it "the
                    revised PO" here told the approver a job was done that still
                    needs doing (Owner 2026-07-19, Q5). Owner 2026-07-27: with a
                    pending follow-up the jump goes to the PO Amendment job card,
                    and the label says so. */}
                {poRevised
                  ? "Open Revised bound PO"
                  : pendingFollowUp
                    ? "Open PO Amendment"
                    : "Open bound PO"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ─── Body ───────────────────────────────────────────────────── */}
      <div className="py-5">
        <DetailGrid>
          <DetailMain>
            {/* Owner 2026-07-16 — an amendment can now also request HEADER
                changes (Delivery Date / Processing Date / State / Postcode: the
                columns the processing lock freezes, mig 0119). Render them
                FIRST: a header-only amendment would otherwise show "no changes
                recorded" and the approver would be approving something invisible. */}
            {headerDiffs.length > 0 && (
              <Section title={`Requested order changes · ${headerDiffs.length}`}>
                <div className="space-y-2.5">
                  {headerDiffs.map((d) => (
                    <div
                      key={d.key}
                      className="rounded-md border border-line px-3 py-2.5 text-[12px]"
                    >
                      <div className="font-medium text-ink">{d.label}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-ink-muted">
                        <span className="line-through">{d.from}</span>
                        <span aria-hidden>&rarr;</span>
                        <span className="font-medium text-ink">{d.to}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title={`Requested changes · ${lines.length}`}>
              {lines.length === 0 ? (
                <div className="text-[12px] text-ink-muted">
                  {headerDiffs.length > 0
                    ? "No line changes — this amendment only changes the order details above."
                    : recordedLineCount > 0
                      /* Every recorded line matches the order exactly, and there
                         is no header delta either — a legacy amendment raised
                         before the header half existed (mig 0119), whose real
                         request was a header field that had nowhere to go. Say
                         so and point at the Reason, which is the only place the
                         ask survives. */
                      ? "No line changes recorded — every line matches the order exactly. This request predates order-detail tracking, so what was asked for is in the Reason below."
                      : "This amendment has no line changes recorded."}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {lines.map((l) => (
                    <DiffCard key={l.id} line={l} />
                  ))}
                </div>
              )}
            </Section>

            {reason && (
              <Section title="Reason">
                <p className="text-[13px] leading-relaxed text-ink-secondary">{reason}</p>
              </Section>
            )}
          </DetailMain>

          <DetailAside>
            <RevisionHero
              status={status}
              amendmentNo={amendmentNo}
              soRevision={typeof salesOrder?.revision === "number" ? salesOrder.revision : null}
              resolution={asStr(amendment.resolution)}
              rejectionReason={asStr(amendment.rejection_reason)}
              lane={lane}
            />

            <AsideCard title="Requested by">
              <div className="space-y-2 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Requested by</span>
                  <span className="font-semibold text-ink">
                    {actorNameOf(asStr(amendment.requested_by))}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Created</span>
                  <span className="font-semibold text-ink">
                    {asStr(amendment.created_at) ? fmtDateTime(String(amendment.created_at)) : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Sales Order</span>
                  <button
                    type="button"
                    onClick={openSalesOrder}
                    className="font-mono font-semibold text-primary-ink hover:underline"
                  >
                    {soDocNo || "—"}
                  </button>
                </div>
                {salesOrder?.status && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-muted">SO status</span>
                    <StatusPill docType="so" status={salesOrder.status} />
                  </div>
                )}
              </div>
            </AsideCard>

            {allFieldKinds.length > 0 && (
              <AsideCard title="Department routing">
                <AmendmentRoutingBlock kinds={allFieldKinds} />
                <p className="mt-3 border-t border-border-subtle pt-2 text-[11px] leading-relaxed text-ink-muted">
                  {lane
                    ? "This request was auto-routed at submission: product-line changes go to Purchasing, delivery changes to Logistics. One signature from this lane's approver applies it; who approved and when is recorded on the Sales Order history."
                    : "Advisory routing — it shows who is responsible for what. Any authorized approver applies the whole amendment in one signature; who approved and when is recorded on the Sales Order history."}
                </p>
              </AsideCard>
            )}

            <AsideCard title="Document">
              <Button
                variant="secondary"
                className="w-full"
                icon={<Printer size={14} />}
                onClick={print.openPreview}
              >
                Print amendment
              </Button>
            </AsideCard>

            {/* Two-lane rework — a lane row has ONE signature and, on the LINES
                lane, the follow-up PO Amendment chips after it applies. */}
            {lane && (status === "REQUESTED" || status === "SO_APPROVED") && (
              <AsideCard title={lane === "LINES" ? "Purchasing approval" : "Logistics approval"}>
                <div className="space-y-2">
                  {status === "REQUESTED" && canApproveLane && (
                    <Button
                      variant="primary"
                      className="w-full"
                      icon={<CheckCircle2 size={14} />}
                      onClick={() => void handleApproveSo()}
                      disabled={approveSo.isPending}
                    >
                      {approveSo.isPending
                        ? "Applying…"
                        : lane === "LINES" ? "Approve product changes" : "Approve delivery changes"}
                    </Button>
                  )}
                  {status === "REQUESTED" && !canApproveLane && (
                    <p className="text-[12px] text-ink-muted">
                      Awaiting {lane === "LINES" ? "Purchasing" : "Logistics"} approval — one
                      signature applies the change to the Sales Order.
                    </p>
                  )}
                  {status === "SO_APPROVED" && lane === "DELIVERY" && (
                    <p className="text-[12px] text-ink-muted">
                      Applied — the delivery details are updated on the Sales Order. The
                      purchase order was not touched.
                    </p>
                  )}
                  {status === "SO_APPROVED" && lane === "LINES" && (
                    <div className="space-y-2">
                      {poFollowUps.length === 0 && (
                        <p className="text-[12px] text-ink-muted">
                          Applied. No purchase order needed revising for this change.
                        </p>
                      )}
                      {poFollowUps.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => navigate(`/scm/po-amendments/${f.id}`)}
                          className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-left hover:border-primary/50"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[12px] font-semibold text-primary-ink">
                              {f.amendment_no ?? f.po_number ?? "PO amendment"}
                            </span>
                            <span className="block text-[11px] text-ink-muted">
                              {f.status === "REQUESTED"
                                ? "Awaiting your PO confirmation"
                                : f.status === "APPROVED"
                                  ? "PO revision confirmed"
                                  : f.resolution === "WITHDRAWN" ? "Withdrawn" : "Rejected — PO unchanged"}
                            </span>
                          </span>
                          <StatusPill docType="poAmendment" status={String(f.status ?? "")} />
                        </button>
                      ))}
                      {poFollowUps.some((f) => f.status === "REJECTED" && f.resolution !== "WITHDRAWN") && (
                        <p className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-[12px] text-ink">
                          The Sales Order is revised but its PO follow-up was rejected — the
                          supplier is still working to the old version. Raise a corrective
                          amendment or revise the PO by hand.
                        </p>
                      )}
                    </div>
                  )}
                  {/* Reject — the lane approver's refusal; REQUESTED only (after
                      apply there is nothing left to refuse). Reason mandatory. */}
                  {status === "REQUESTED" && canReject && (
                    <Button
                      variant="secondary"
                      className="w-full"
                      icon={<XCircle size={14} />}
                      onClick={() => void handleReject()}
                      disabled={rejectAmendment.isPending}
                    >
                      {rejectAmendment.isPending ? "Rejecting…" : "Reject amendment"}
                    </Button>
                  )}
                  {canWithdraw && (
                    <Button
                      variant="ghost"
                      className="w-full"
                      icon={<Undo2 size={14} />}
                      onClick={() => void handleWithdraw()}
                      disabled={withdrawAmendment.isPending}
                    >
                      {withdrawAmendment.isPending ? "Withdrawing…" : "Withdraw this request"}
                    </Button>
                  )}
                </div>
              </AsideCard>
            )}

            {/* Gate actions — supplier-confirm / approve-so are wired directly
                (the same vendored hooks the mobile flow uses); the later gates
                (approve-po / send) hand off to the bound-PO editor. LEGACY
                (lane NULL) rows only — lane rows use the card above. */}
            {!lane && (status === "REQUESTED" || status === "SUPPLIER_PENDING" || pastSoGate) && (
              <AsideCard title="Gate actions">
                <div className="space-y-2">
                  {status === "REQUESTED" && canSupplierConfirm && (
                    <Button
                      variant="primary"
                      className="w-full"
                      icon={<ClipboardCheck size={14} />}
                      onClick={() => setShowSupplierModal(true)}
                    >
                      Record supplier confirmation
                    </Button>
                  )}
                  {status === "SUPPLIER_PENDING" && canApproveSo && (
                    <Button
                      variant="primary"
                      className="w-full"
                      icon={<CheckCircle2 size={14} />}
                      onClick={() => void handleApproveSo()}
                      disabled={approveSo.isPending}
                    >
                      {approveSo.isPending ? "Approving…" : "Approve SO revision"}
                    </Button>
                  )}
                  {pastSoGate && boundPo?.id && (
                    <>
                      {/* Approving the SO revision does NOT touch the purchase
                          order. reviseBoundPo runs on the SEPARATE approve-po
                          gate, and if nobody runs it the SO says one thing and
                          the supplier is still building another — with no
                          notification to anyone. Say so where the decision is
                          made. */}
                      {!poRevised && (
                        <p className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-[12px] text-ink">
                          The Sales Order is revised. <strong>{boundPo.po_number}</strong> is
                          NOT — the supplier is still working to the old version until the PO
                          revision is approved too. Continue on the PO to finish this.
                        </p>
                      )}
                      <Button
                        variant="secondary"
                        className="w-full"
                        icon={<ExternalLink size={14} />}
                        onClick={openBoundPo}
                      >
                        {poRevised
                          ? "Continue on revised PO"
                          : pendingFollowUp
                            ? "Confirm the PO Amendment"
                            : "Revise the bound PO"}
                      </Button>
                    </>
                  )}
                  {pastSoGate && !boundPo?.id && (
                    <p className="text-[12px] text-ink-muted">
                      The SO revision is approved. Later gates run on the bound PO once it exists.
                    </p>
                  )}
                  {status === "REQUESTED" && !canSupplierConfirm && !canWithdraw && (
                    <p className="text-[12px] text-ink-muted">
                      Awaiting supplier confirmation.
                    </p>
                  )}
                  {status === "SUPPLIER_PENDING" && !canApproveSo && (
                    <p className="text-[12px] text-ink-muted">
                      Supplier confirmed — awaiting SO revision approval.
                    </p>
                  )}
                  {/* Reject — available at every pre-approved gate, exactly as the
                      backend state machine allows. The reason is mandatory. */}
                  {!pastSoGate && canReject && (
                    <Button
                      variant="secondary"
                      className="w-full"
                      icon={<XCircle size={14} />}
                      onClick={() => void handleReject()}
                      disabled={rejectAmendment.isPending}
                    >
                      {rejectAmendment.isPending ? "Rejecting…" : "Reject amendment"}
                    </Button>
                  )}
                  {/* Withdraw — the requester's own way out, so a mistaken request
                      can be closed instead of buried under a second one. */}
                  {canWithdraw && (
                    <Button
                      variant="ghost"
                      className="w-full"
                      icon={<Undo2 size={14} />}
                      onClick={() => void handleWithdraw()}
                      disabled={withdrawAmendment.isPending}
                    >
                      {withdrawAmendment.isPending ? "Withdrawing…" : "Withdraw this request"}
                    </Button>
                  )}
                </div>
              </AsideCard>
            )}

            <AsideCard title="Approval history">
              <ActivityTimeline events={timeline} />
            </AsideCard>
          </DetailAside>
        </DetailGrid>
      </div>

      {showSupplierModal && id && (
        <SupplierConfirmModal
          amendmentId={id}
          onClose={() => setShowSupplierModal(false)}
        />
      )}
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Sales Order Amendment"
        docNo={amendmentNo ?? "Amendment"}
        rows={[
          { label: "Against SO", value: soDocNo || "—" },
          { label: "Status", value: amendmentPrintedStatus(status) },
          { label: "Reason", value: reason || "—" },
          {
            label: "Changes",
            value: `${lines.length + headerDiffs.length} change${
              lines.length + headerDiffs.length === 1 ? "" : "s"
            }`,
          },
        ]}
        {...print.handlers}
      />
    </div>
  );
}

export default AmendmentDetailV2;
