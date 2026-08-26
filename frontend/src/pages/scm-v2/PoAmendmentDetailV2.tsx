// ----------------------------------------------------------------------------
// PoAmendmentDetailV2 — the PO-amendment job card. A dedicated read-first detail
// page for one Purchase Order revision, reachable from the PO Amendments queue
// (pages/scm-v2/PoAmendments.tsx). The PO-side sibling of AmendmentDetailV2.tsx,
// built to the owner's SIMPLIFIED single-approver model:
//
//   • a revision-status hero (Requested -> Approved), tone + label from the
//     canonical resolveStatusPill('poAmendment')
//   • a main column with the before -> after diff per changed line
//     (qty / spec / cost / delivery / add / remove) and the header changes
//     (supplier / delivery / notes)
//   • an aside with Requested-by, the "Print amendment" PDF button (the shared
//     amendment-pdf template + poAmendmentToPdfInput), and the single approver
//     gate — approve / reject / withdraw, exactly what the backend allows.
//
// There is deliberately NO supplier-confirm / two-gate / send chain here (unlike
// the SO amendment): the whole point of this module is the single-approver gate.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Printer,
  Undo2,
  XCircle,
} from "lucide-react";
import { generateAmendmentPdf } from "../../vendor/scm/lib/amendment-pdf";
import { amendmentPrintedStatus, poAmendmentToPdfInput } from "../../vendor/scm/lib/amendment-pdf-map";
import { fmtDateTime, fmtMoneySen } from "@2990s/shared";
import { Button } from "../../components/Button";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
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
  usePoAmendmentDetail,
  useApprovePoAmendment,
  useRejectPoAmendment,
  useWithdrawPoAmendment,
  poLineFieldKinds,
  poHeaderFieldKind,
  type PoAmendmentLine,
} from "../../vendor/scm/lib/po-amendment-queries";
import {
  RowRoutingChips,
  AmendmentTypeBadges,
  AmendmentRoutingBlock,
} from "../../vendor/scm/components/AmendmentRouting";
import type { AmendmentFieldKind } from "../../vendor/scm/lib/amendment-routing";
import { humanApiError } from "../../vendor/scm/lib/authed-fetch";
import { useAuth as useHouzsAuth } from "../../auth/AuthContext";
/* The 2990 bridge's staff row — the vocabulary po_amendments.requested_by is
   written in (a scm.staff uuid), so this is what "did I raise this?" compares. */
import { useAuth as useScmAuth } from "../../vendor/scm/lib/auth";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { PrintPreviewModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn, formatDate } from "../../lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

/* PO amendment prices are stored in centi (1/100 MYR). */
const fmtSen = (centi: number | null | undefined): string => fmtMoneySen(centi);

const changeTypeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "PRICE" ? "Cost change" :
  t === "DELIVERY" ? "Delivery change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

const asStr = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/* Read the old_snapshot blob a PO amendment line records. */
type PoOldSnapshot = {
  item_code?: string | null;
  material_name?: string | null;
  qty?: number | null;
  unit_price_sen?: number | null;
  delivery_date?: string | null;
};
const oldOf = (l: PoAmendmentLine): PoOldSnapshot =>
  (l.old_snapshot as PoOldSnapshot | null) ?? {};

/* Every failed gate action reports through here — authedFetch hangs the raw
   status + body off the thrown error, which humanApiError turns into the house
   plain sentence. */
const plainError = (e: unknown): string => {
  const err = e as { status?: number; body?: string; message?: string };
  if (typeof err?.status === "number" && typeof err?.body === "string") {
    return humanApiError(err.status, err.body);
  }
  return err?.message ?? "Something went wrong. Please try again.";
};

/* Header change labels — the AMENDABLE_HEADER trust boundary keys. */
const HEADER_LABEL: Record<string, string> = {
  supplier_id: "Supplier",
  expected_at: "Delivery date",
  notes: "Notes",
};
const headerValueDisplay = (key: string, v: string | null): string => {
  if (v == null || v === "") return "—";
  if (key === "expected_at") return formatDate(v);
  return v;
};

// ─── Revision-status hero (2 stages: Requested -> Approved) ──────────────────

type Stage = { key: string; label: string };
const STAGES: Stage[] = [
  { key: "REQUESTED", label: "Requested" },
  { key: "APPROVED", label: "Approved" },
];

const stageIndexOf = (status: string): number => {
  switch (status) {
    case "REQUESTED": return 0;
    case "APPROVED": return 1;
    default: return -1; // REJECTED / unknown
  }
};

const HERO_DOT: Record<StatusTone, string> = {
  success: "bg-synced",
  danger: "bg-err",
  progress: "bg-accent-bright",
  pending: "bg-accent-bright",
  info: "bg-accent-bright",
  neutral: "bg-sidebar-ink-muted",
};

function AsideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function RevisionHero({
  status,
  amendmentNo,
  poRevision,
  resolution,
  rejectionReason,
}: {
  status: string;
  amendmentNo: string | null;
  poRevision: number | null;
  resolution: string | null;
  rejectionReason: string | null;
}) {
  const { label, tone } = resolveStatusPill("poAmendment", status);
  const reached = stageIndexOf(status);
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
              : "This amendment was rejected — the Purchase Order keeps its prior revision."}
          </div>
          {rejectionReason && (
            <div className="mt-1.5 font-normal text-err/90">"{rejectionReason}"</div>
          )}
          <div className="mt-1.5 font-normal text-sidebar-ink-muted">
            This Purchase Order is free again — a corrected amendment can be raised on it.
          </div>
        </div>
      ) : (
        <div className="mt-5 flex items-center">
          {STAGES.map((s, i) => {
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
                      i === STAGES.length - 1 ? "opacity-0" : isDone ? "bg-accent-bright" : "bg-white/15"
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

      {typeof poRevision === "number" && (
        <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
          <span className="text-[12.5px] text-sidebar-ink-muted">PO revision</span>
          <span className="font-money text-[13px] font-semibold text-sidebar-ink">
            r{poRevision}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Per-line before -> after diff card ─────────────────────────────────────

function DiffCard({ line }: { line: PoAmendmentLine }) {
  const old = oldOf(line);
  const isAdd = line.change_type === "ADD";
  const isRemove = line.change_type === "REMOVE";

  const oldCode = old.item_code ?? null;
  const oldName = old.material_name ?? null;
  const newCode = line.new_item_code ?? oldCode;
  const newName = line.new_material_name ?? oldName;

  const codeChanged = !isAdd && !isRemove && line.new_item_code != null && line.new_item_code !== oldCode;
  const qtyChanged = !isAdd && !isRemove && line.new_qty != null && line.new_qty !== (old.qty ?? null);
  const priceChanged = !isAdd && !isRemove && line.new_unit_price_sen != null && line.new_unit_price_sen !== (old.unit_price_sen ?? null);
  const deliveryChanged = !isAdd && !isRemove && line.new_delivery_date != null && line.new_delivery_date !== (old.delivery_date ?? null);

  const wasCls = (changed: boolean, base: string): string =>
    cn(base, changed && "line-through decoration-ink-muted/60");
  const nowCls = (changed: boolean, base: string): string =>
    cn(base, changed ? "font-semibold text-primary-ink" : "text-ink-muted");

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
          {changeTypeLabel(line.change_type)}
        </span>
        <RowRoutingChips kinds={poLineFieldKinds(line)} />
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
              <div className={wasCls(codeChanged, "mt-1 font-mono text-[13px] font-semibold text-ink")}>
                {oldCode ?? "—"}
              </div>
              {oldName && (
                <div className={wasCls(codeChanged, "mt-0.5 text-[11px] text-ink-secondary")}>{oldName}</div>
              )}
              <div className="mt-0.5 font-money text-[11.5px] text-ink-muted">
                <span className={wasCls(qtyChanged, "")}>Qty {old.qty ?? "—"}</span>
                {typeof old.unit_price_sen === "number" ? (
                  <>
                    {" · "}
                    <span className={wasCls(priceChanged, "")}>{fmtSen(old.unit_price_sen)}</span>
                  </>
                ) : ""}
              </div>
              {old.delivery_date && (
                <div className={wasCls(deliveryChanged, "mt-1 text-[11px] text-ink-secondary")}>
                  Delivery {formatDate(old.delivery_date)}
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
              <div className={nowCls(codeChanged, "mt-1 font-mono text-[13px]")}>
                {newCode ?? "—"}
              </div>
              {newName && (
                <div className={nowCls(codeChanged, "mt-0.5 text-[11px]")}>{newName}</div>
              )}
              <div className="mt-0.5 font-money text-[11.5px]">
                <span className={nowCls(qtyChanged, "")}>Qty {line.new_qty ?? old.qty ?? "—"}</span>
                {typeof line.new_unit_price_sen === "number" ? (
                  <>
                    <span className="text-ink-muted">{" · "}</span>
                    <span className={nowCls(priceChanged, "")}>{fmtSen(line.new_unit_price_sen)}</span>
                  </>
                ) : ""}
              </div>
              {line.new_delivery_date && (
                <div className={nowCls(deliveryChanged, "mt-1 text-[11px]")}>
                  Delivery {formatDate(line.new_delivery_date)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function PoAmendmentDetailV2() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useHouzsAuth();
  const { staff: currentStaff } = useScmAuth();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const { actorNameOf } = useStaffLookup();

  const { data, isPending, error } = usePoAmendmentDetail(id ?? null);

  const amendment = (data?.amendment ?? null) as (Record<string, unknown> & {
    status?: string;
    amendment_no?: number | string | null;
    reason?: string | null;
    requested_by?: string | null;
    created_at?: string | null;
    po_number?: string;
    po_id?: string;
    source_so_amendment_id?: string | null;
    source_so_amendment_no?: string | null;
  }) | null;
  /* Two-lane rework: a FOLLOW-UP row was auto-raised by an SO amendment's
     product-lane apply. Its lines are a PREVIEW — confirming re-derives this PO
     from the Sales Order's CURRENT truth (reviseBoundPo), so the wording below
     says "confirm", and the source amendment is one click away. */
  const sourceSoAmendmentId = asStr(amendment?.source_so_amendment_id);
  const sourceSoAmendmentNo = asStr(amendment?.source_so_amendment_no);
  const isFollowUp = sourceSoAmendmentId != null;

  const lines = useMemo(() => (data?.lines ?? []) as PoAmendmentLine[], [data]);
  const purchaseOrder = data?.purchaseOrder ?? null;

  /* Header change rows — the AMENDABLE_HEADER keys (supplier / delivery / notes)
     paired against the old snapshot. */
  const headerDiffs = useMemo(() => {
    const changes = (amendment?.header_changes ?? null) as Record<string, string | null> | null;
    const oldSnap = (amendment?.old_header_snapshot ?? null) as Record<string, string | null> | null;
    if (!changes) return [] as Array<{ key: string; label: string; from: string; to: string }>;
    return Object.keys(changes).map((k) => ({
      key: k,
      label: HEADER_LABEL[k] ?? k,
      from: headerValueDisplay(k, oldSnap?.[k] ?? null),
      to: headerValueDisplay(k, changes[k] ?? null),
    }));
  }, [amendment]);

  const changeCount = headerDiffs.length + lines.length;

  /* Every routable atom this amendment moves — lines + header — for the type
     badge(s) and the department-routing block. */
  const allFieldKinds = useMemo<AmendmentFieldKind[]>(() => {
    const fromLines = lines.flatMap((l) => poLineFieldKinds(l));
    const fromHeader = headerDiffs
      .map((d) => poHeaderFieldKind(d.key))
      .filter((k): k is AmendmentFieldKind => k != null);
    return [...fromLines, ...fromHeader];
  }, [lines, headerDiffs]);

  const status = String(amendment?.status ?? "");
  const poNumber = String(amendment?.po_number ?? "");
  const poId = String(amendment?.po_id ?? purchaseOrder?.id ?? "");
  const amendmentNo =
    amendment?.amendment_no != null ? String(amendment.amendment_no) : null;

  useSetBreadcrumbs([
    { label: "PO Amendments", to: "/scm/po-amendments" },
    { label: amendmentNo ?? "Amendment" },
  ]);

  const reason = asStr(amendment?.reason);

  /* Printable amendment document — the shared client-side jsPDF template already
     handles PO via poAmendmentToPdfInput. Status label is the SIMPLIFIED
     Requested / Approved the owner asked for. */
  const deliverPrintPdf = (action: PdfAction) => {
    if (!amendment) return;
    const input = poAmendmentToPdfInput({
      amendment: {
        amendment_no: amendmentNo,
        status,
        reason,
        created_at: asStr(amendment.created_at) || null,
        requested_by_name: actorNameOf(asStr(amendment.requested_by)),
        approved_by_name: amendment.approved_by ? actorNameOf(asStr(amendment.approved_by)) : null,
        approved_at: asStr(amendment.approved_at) || null,
      },
      lines: lines as never,
      purchaseOrder: purchaseOrder as never,
      supplierName: null,
    });
    return Promise.resolve(generateAmendmentPdf(input, { action })).catch((e: unknown) =>
      notify({ title: "PDF generation failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }),
    );
  };
  const print = usePrintPreview(deliverPrintPdf);

  const canApprove = can("scm.po_amendment.approve");
  const canReject = canApprove;
  /* Withdraw — the requester's own escape hatch. Matched on the amendment's
     requested_by staff uuid against the caller's own; the server re-checks. */
  const isRequester =
    asStr(amendment?.requested_by) != null
    && currentStaff?.id != null
    && String(amendment?.requested_by) === String(currentStaff.id);
  const canWithdraw = status === "REQUESTED" && (isRequester || canApprove);

  const approve = useApprovePoAmendment();
  const rejectAmendment = useRejectPoAmendment();
  const withdrawAmendment = useWithdrawPoAmendment();

  const handleApprove = async () => {
    if (!id || !amendment) return;
    if (
      !(await askConfirm({
        title: isFollowUp
          ? `Confirm the PO revision for ${poNumber}?`
          : `Approve amendment for ${poNumber}?`,
        body: isFollowUp
          ? `The Sales Order was already revised by ${sourceSoAmendmentNo ?? "its amendment"}. `
            + "Confirming re-derives this Purchase Order from the Sales Order as it stands now "
            + "(quantities, specs, supplier costs), snapshots the current version into Revisions "
            + "and bumps the PO revision — the printed number gains a _R suffix. This cannot be undone."
          : "This applies the requested changes: the Purchase Order is re-derived and the " +
            "current version is snapshotted into Revisions. This cannot be undone.",
        confirmLabel: isFollowUp ? "Confirm PO revision" : "Approve amendment",
      }))
    )
      return;
    approve.mutate(
      { id, poId },
      {
        onSuccess: (res) => {
          const warnings = (res?.warnings ?? []) as string[];
          notify({
            title: isFollowUp ? "PO revision confirmed" : "PO amendment approved",
            body: warnings.length > 0 ? warnings.join(" ") : undefined,
          });
        },
        onError: (e) =>
          notify({
            title: "Could not approve the amendment",
            body: `${plainError(e)} The Purchase Order was NOT changed — please try again.`,
            tone: "error",
          }),
      }
    );
  };

  const handleReject = async () => {
    if (!id || !amendment) return;
    const rejectReason = await askPrompt({
      title: `Reject amendment ${amendmentNo ?? ""}?`.trim(),
      body: "The Purchase Order keeps its current revision and nothing is changed. "
        + "Say what is wrong so the person who raised it knows what to fix — they will see this.",
      placeholder: "e.g. supplier cannot meet this cost",
      multiline: true,
      confirmLabel: "Reject amendment",
      validate: (v) =>
        v.trim().length < 5
          ? "Give a reason the requester can act on — at least a few words."
          : null,
    });
    if (rejectReason == null) return;
    try {
      const res = await rejectAmendment.mutateAsync({ id, reason: rejectReason.trim(), poId });
      const released = res.releasedToStock ?? [];
      notify({
        title: "Amendment rejected",
        body: released.length > 0
          ? `Supplier keeps the original spec — released to STOCK: ${released.map((x) => `${x.itemCode} ×${x.qty}`).join(", ")}. MRP will re-show the corrected spec as shortage.`
          : "The person who raised it can see your reason and raise a corrected request.",
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
        body: "This closes the request without changing the Purchase Order. It cannot be reopened — "
          + "but withdrawing frees the order so you can raise a corrected amendment straight away.",
        confirmLabel: "Withdraw request",
        danger: true,
      }))
    )
      return;
    const wReason = await askPrompt({
      title: "Why are you withdrawing it?",
      body: "Optional — this is recorded on the Purchase Order's history so the next person can follow what happened.",
      placeholder: "e.g. raised against the wrong line",
      multiline: true,
      confirmLabel: "Withdraw request",
    });
    if (wReason == null) return;
    try {
      await withdrawAmendment.mutateAsync({ id, reason: wReason.trim() || undefined, poId });
      notify({
        title: "Amendment withdrawn",
        body: "This Purchase Order is free again — open it and submit a corrected amendment when you are ready.",
      });
    } catch (e) {
      notify({
        title: "Could not withdraw this amendment",
        body: `${plainError(e)} It is still open — please try again.`,
        tone: "error",
      });
    }
  };

  const goBack = () => navigate("/scm/po-amendments");
  const openPo = () => poId && navigate(`/scm/purchase-orders/${poId}`);

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
            Back to PO Amendments
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-10">
      {/* ─── Desktop sticky header ──────────────────────────────────── */}
      <div className="sticky top-12 lg:top-[52px] z-20 -mx-4 border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to PO Amendments"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  Amendment{amendmentNo ? ` ${amendmentNo}` : ""}
                </h1>
                <StatusPill docType="poAmendment" status={status} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">{poNumber}</span>
                <span className="text-ink-muted/50">·</span>
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
            {/* Owner 2026-07-27: bordered secondary, matching the SO amendment
                job card's header pair — the naked ghost read as plain text. */}
            <Button variant="secondary" icon={<ExternalLink size={14} />} onClick={openPo}>
              Open Purchase Order
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Body ───────────────────────────────────────────────────── */}
      <div className="py-5">
        <DetailGrid>
          <DetailMain>
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
              poRevision={typeof purchaseOrder?.revision === "number" ? purchaseOrder.revision : null}
              resolution={asStr(amendment.resolution)}
              rejectionReason={asStr(amendment.rejection_reason)}
            />

            {/* Two-lane rework — where this follow-up came from, one click back
                to the SO amendment that already applied. */}
            {isFollowUp && (
              <div className="rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-3 text-[12px] leading-relaxed text-ink">
                Auto-raised from SO amendment{" "}
                <button
                  type="button"
                  onClick={() => sourceSoAmendmentId && navigate(`/scm/amendments/${sourceSoAmendmentId}`)}
                  className="font-mono font-semibold text-primary-ink hover:underline"
                >
                  {sourceSoAmendmentNo ?? "view"}
                </button>
                {" "}— the Sales Order is already revised. Confirming here re-derives this
                PO from the Sales Order as it stands now; the lines below are a preview.
              </div>
            )}

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
                  <span className="text-ink-muted">Purchase Order</span>
                  <button
                    type="button"
                    onClick={openPo}
                    className="font-mono font-semibold text-primary-ink hover:underline"
                  >
                    {poNumber || "—"}
                  </button>
                </div>
                {purchaseOrder?.status && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-muted">PO status</span>
                    <StatusPill docType="po" status={purchaseOrder.status} />
                  </div>
                )}
                {amendment.approved_by != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-muted">Approved by</span>
                    <span className="font-semibold text-ink">
                      {actorNameOf(asStr(amendment.approved_by))}
                    </span>
                  </div>
                )}
              </div>
            </AsideCard>

            {allFieldKinds.length > 0 && (
              <AsideCard title="Department routing">
                <AmendmentRoutingBlock kinds={allFieldKinds} />
                <p className="mt-3 border-t border-border-subtle pt-2 text-[11px] leading-relaxed text-ink-muted">
                  Advisory routing — it shows who is responsible for what. Any authorized
                  approver applies the whole amendment in one signature; who approved and when
                  is recorded on the Purchase Order history.
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

            {/* Single approver gate — approve / reject / withdraw, exactly what
                the backend state machine allows. */}
            {status === "REQUESTED" && (
              <AsideCard title="Gate actions">
                <div className="space-y-2">
                  {canApprove && (
                    <Button
                      variant="primary"
                      className="w-full"
                      icon={<CheckCircle2 size={14} />}
                      onClick={() => void handleApprove()}
                      disabled={approve.isPending}
                    >
                      {approve.isPending
                        ? isFollowUp ? "Confirming…" : "Approving…"
                        : isFollowUp ? "Confirm PO revision" : "Approve amendment"}
                    </Button>
                  )}
                  {canReject && (
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
                  {!canApprove && !canWithdraw && (
                    <p className="text-[12px] text-ink-muted">
                      Awaiting approval.
                    </p>
                  )}
                </div>
              </AsideCard>
            )}
          </DetailAside>
        </DetailGrid>
      </div>
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Purchase Order Amendment"
        docNo={amendmentNo ?? "Amendment"}
        rows={[
          { label: "Against PO", value: poNumber || "—" },
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

export default PoAmendmentDetailV2;
