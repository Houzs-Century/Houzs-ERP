// PurchaseReturnDetailV2 — Theme C redesign of the Purchase Return detail
// page. Procurement-side mirror of DR (Delivery Return): the biz sends goods
// BACK to the supplier and expects a credit (money-in framing). Aside hero =
// Credit expected (synced/green because it's money coming back).

import { useMemo, type ReactNode } from "react";
import { buildVariantSummary, fmtDate, fmtMoneySen, orderLineIdentity } from "@2990s/shared";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { scmListReturnTo } from "../../lib/scmListReturn";
import {
  ArrowLeft,
  History,
  Printer,
  XCircle,
  Edit3,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Send,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { DATA_TABLE_LAYOUT_FAMILIES } from "../../components/dataTableLayoutFamilies";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
import {
  usePurchaseReturnDetail,
  usePostPurchaseReturn,
  useCompletePurchaseReturn,
  useCancelPurchaseReturn,
} from "../../vendor/scm/lib/purchase-return-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { RelationshipMapButton } from "../../vendor/scm/components/RelationshipMapButton";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";

type PrStatus = "DRAFT" | "POSTED" | "COMPLETED" | "CANCELLED" | string;

type PrHeader = {
  id: string;
  return_number: string;
  status: PrStatus;
  return_date: string | null;
  reason: string | null;
  credit_note_ref?: string | null;
  refund_sen?: number;
  notes?: string | null;
  currency: string;
  supplier?: {
    id: string;
    code: string;
    name: string;
    contact_person?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
  posted_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string;
};

type PrItem = {
  id: string;
  item_code?: string | null;
  description?: string | null;
  description2?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  uom?: string;
  qty?: number;
  qty_returned?: number;
  condition?: string | null;
  unit_price_sen?: number;
  line_total_sen?: number;
  warehouse_code?: string | null;
};

const fmtMoney = (centi: number, currency = "MYR"): string => fmtMoneySen(centi, currency);

const supplierNameOf = (h: PrHeader): string => h.supplier?.name || "—";
const supplierCodeOf = (h: PrHeader): string => h.supplier?.code || "—";
const sourceOf = (h: PrHeader): string => h.grn?.grn_number || h.purchase_order?.po_number || "—";
const refundOf = (h: PrHeader): number => h.refund_sen ?? 0;

type Effective = "draft" | "posted" | "completed" | "cancelled";
const effectiveOf = (h: PrHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  if (s === "COMPLETED") return "completed";
  if (s === "POSTED") return "posted";
  return "draft";
};

const EFFECTIVE_TONE: Record<Effective, { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }> = {
  draft:     { tone: "warning", label: "Draft",     blurb: "Draft · not yet posted" },
  posted:    { tone: "warning", label: "Confirmed", blurb: "Confirmed · awaiting credit note" },
  completed: { tone: "success", label: "Completed", blurb: "Completed · credit note issued" },
  cancelled: { tone: "error",   label: "Cancelled", blurb: "Cancelled · no further action" },
};

const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  POSTED: "Posted",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const initialsOf = (name: string | null | undefined): string => {
  if (!name) return "—";
  return (
    name
      .split(/\s+/).filter(Boolean).slice(0, 2)
      .map((w) => w[0]?.toUpperCase()).join("") || "—"
  );
};

function Field({ label, value, span = 1, muted, mono }: { label: string; value: ReactNode; span?: 1 | 2 | 3 | 4; muted?: boolean; mono?: boolean }) {
  const spanCls = span === 1 ? "" : span === 2 ? "sm:col-span-2" : span === 3 ? "sm:col-span-3" : "sm:col-span-4";
  return (
    <div className={spanCls}>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={cn("mt-1 text-[14px] font-semibold leading-snug", muted ? "text-ink-muted" : "text-ink", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{title}</div>
      {children}
    </div>
  );
}

function KeyDateRow({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span className={cn("text-[13px] font-semibold", muted ? "text-ink-muted" : "text-ink")}>{v}</span>
    </div>
  );
}

function PersonRow({ initials, name, role, tone = "accent" }: { initials: string; name: string; role: string; tone?: "accent" | "neutral" }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold", tone === "accent" ? "bg-accent-soft text-accent-ink" : "bg-border-subtle text-ink-secondary")}>
        {initials}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
        <div className="truncate text-[11.5px] text-ink-muted">{role}</div>
      </div>
    </div>
  );
}

type ActivityDot = "success" | "primary" | "muted";
const DOT_CLS: Record<ActivityDot, string> = { success: "bg-synced", primary: "bg-primary", muted: "bg-border-strong" };
function ActivityRow({ title, meta, dot, isLast }: { title: string; meta: string; dot: ActivityDot; isLast?: boolean }) {
  return (
    <div className="flex gap-3 pb-3.5">
      <div className="flex flex-col items-center">
        <span className={cn("mt-1 h-2 w-2 rounded-full", DOT_CLS[dot])} />
        {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{meta}</div>
      </div>
    </div>
  );
}

function CreditHeroCard({ header }: { header: PrHeader }) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  const refund = refundOf(header);
  const isSettled = eff === "completed";
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        {isSettled ? "Credit settled" : "Credit expected"}
      </div>
      <div className="mt-1.5 font-money text-[28px] font-bold leading-none tracking-tight text-synced">
        {fmtMoney(refund, header.currency)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full", t.tone === "success" ? "bg-synced" : t.tone === "warning" ? "bg-accent-bright" : t.tone === "error" ? "bg-err" : "bg-sidebar-ink-muted")} />
        <span className="text-[12.5px] text-sidebar-ink-muted">{t.blurb}</span>
      </div>
      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <HeroLine k="Refund" v={fmtMoney(refund, header.currency)} strong />
        {header.credit_note_ref && (
          <HeroLine k="Credit note" v={header.credit_note_ref} />
        )}
      </div>
    </div>
  );
}

function HeroLine({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-[12.5px] text-sidebar-ink-muted", strong && "font-semibold text-white")}>{k}</span>
      <span className={cn("font-money text-[13px] font-semibold text-sidebar-ink", strong && "text-[16px] font-bold text-synced")}>{v}</span>
    </div>
  );
}

export function PurchaseReturnDetailV2() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = usePurchaseReturnDetail(id ?? null);
  const postPr = usePostPurchaseReturn();
  const completePr = useCompletePurchaseReturn();
  const cancelPr = useCancelPurchaseReturn();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();

  const purchaseReturn = (detail.data as { purchaseReturn?: PrHeader } | undefined)?.purchaseReturn ?? null;
  const items: PrItem[] = useMemo(
    () => ((detail.data as { items?: PrItem[] } | undefined)?.items ?? []),
    [detail.data]
  );

  useSetBreadcrumbs([
    { label: "Purchase Returns", to: "/scm/purchase-returns" },
    { label: purchaseReturn?.return_number ?? id ?? "Purchase Return" },
  ]);

  const eff = purchaseReturn ? effectiveOf(purchaseReturn) : null;
  const stageLabel = purchaseReturn
    ? STAGE_LABEL[(purchaseReturn.status || "").toUpperCase()] ?? purchaseReturn.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";
  const refund = purchaseReturn ? refundOf(purchaseReturn) : 0;

  // Back always returns to the Purchase Returns list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = () => navigate(scmListReturnTo("/scm/purchase-returns"));
  const goEdit = () => id && navigate(`/scm/purchase-returns/${id}?edit=1`);
  const goHistory = () => id && navigate(`/scm/purchase-returns/${id}?tab=history`);
  // Render + download the PR PDF via the shared jspdf generator (client-side),
  // mirroring the V1 PurchaseReturnDetail handler. The old `?print=1`
  // navigation was dead — nothing consumed that param — so the button did nothing.
  const deliverPrintPdf = (action: PdfAction) => {
    if (!purchaseReturn) return;
    return import("../../vendor/scm/lib/purchase-return-pdf")
      .then(({ generatePurchaseReturnPdf }) =>
        generatePurchaseReturnPdf(purchaseReturn as never, items as never, { action })
      )
      .catch((e) =>
        notify({
          title: "PDF generation failed",
          body: e instanceof Error ? e.message : "Something went wrong.",
          tone: "error",
        })
      );
  };
  const print = usePrintPreview(deliverPrintPdf);
  useOpenPrintPreviewFromUrl(print.openPreview, !!purchaseReturn);
  const doPost = async () => {
    if (!purchaseReturn) return;
    if (await askConfirm({
      title: "Post this purchase return?",
      body: "A credit-owed entry will be booked against the supplier.",
      confirmLabel: "Post return",
    })) {
      postPr.mutate(purchaseReturn.id);
    }
  };
  const doComplete = async () => {
    if (!purchaseReturn) return;
    /* The reference is OPTIONAL — an empty confirm still completes, so only a
       Cancel (null) aborts. This mirrors the old window.prompt contract. */
    const ref = await askPrompt({
      title: "Complete return",
      body: "Enter the supplier's credit note reference (optional):",
      confirmLabel: "Complete",
    });
    if (ref === null) return;
    completePr.mutate({ id: purchaseReturn.id, creditNoteRef: ref.trim() || undefined });
  };
  const doCancel = async () => {
    if (!purchaseReturn) return;
    if (await askConfirm({
      title: `Cancel return ${purchaseReturn.return_number}?`,
      body: "Stock will be reversed.",
      confirmLabel: "Cancel return",
      danger: true,
    })) {
      cancelPr.mutate(purchaseReturn.id);
    }
  };

  const lineColumns: Column<PrItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code || l.item_code || "",
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). Swept on SHAPE, not vocabulary. The
         WAREHOUSE pill is not a duplicate and stays — its row is kept when only
         the pill is present (the #647 DR precedent). The code still BINDS via
         getValue above. */
      render: (l) => {
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code || l.item_code,
          description: l.description,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
        return (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">
            {primary || "—"}
          </div>
          {(secondary || l.warehouse_code) && (
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
              {secondary && (
                <span className="truncate text-ink-secondary">{secondary}</span>
              )}
              {l.warehouse_code && (
                <span className="inline-flex items-center gap-0.5 rounded bg-primary-soft px-1.5 py-0 text-[10px] font-semibold text-primary-ink">{l.warehouse_code}</span>
              )}
            </div>
          )}
        </div>
        );
      },
    },
    {
      key: "condition",
      label: "Condition",
      width: "108px",
      getValue: (l) => l.condition ?? "",
      render: (l) => l.condition ? <Badge tone="warning" size="xs">{l.condition}</Badge> : <span className="text-ink-muted">—</span>,
    },
    {
      key: "qty",
      label: "Qty",
      width: "72px",
      align: "right",
      getValue: (l) => l.qty_returned ?? l.qty ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty_returned ?? l.qty ?? 0} <span className="text-[10.5px] text-ink-muted">{l.uom || ""}</span>
        </span>
      ),
    },
    {
      key: "unit",
      label: "Unit price",
      width: "108px",
      align: "right",
      getValue: (l) => l.unit_price_sen ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">{fmtMoney(l.unit_price_sen ?? 0, purchaseReturn?.currency)}</span>
      ),
    },
    {
      key: "total",
      label: "Credit",
      width: "132px",
      align: "right",
      getValue: (l) => l.line_total_sen ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] font-semibold text-synced">{fmtMoney(l.line_total_sen ?? 0, purchaseReturn?.currency)}</span>
      ),
    },
  ];

  if (!id) {
    return <div className="p-8 text-center text-ink-muted">No purchase return specified.</div>;
  }
  if (detail.isPending) {
    return <div className="animate-fade-in p-8 text-center text-ink-muted">Loading purchase return…</div>;
  }
  if (detail.error || !purchaseReturn) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">Couldn't load purchase return</div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ?? "The return was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Purchase Returns
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!purchaseReturn?.supplier?.phone) return;
    window.location.href = `tel:${purchaseReturn.supplier.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (purchaseReturn.status || "").toUpperCase();
  const canPost = rawStatus === "DRAFT";
  const canComplete = rawStatus === "POSTED";
  const canCancel = rawStatus !== "CANCELLED" && rawStatus !== "COMPLETED";
  const isCancelled = rawStatus === "CANCELLED";

  return (
    <div className="pb-24 md:pb-0">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button type="button" onClick={goBack} className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright" aria-label="Back to Purchase Returns">
            <ArrowLeft size={16} /> Returns
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">{purchaseReturn.return_number}</span>
          <button type="button" className="text-sidebar-ink-muted" aria-label="More actions">
            <MoreHorizontal size={18} />
          </button>
        </div>
        <div className="px-4 pb-4 pt-3">
          <h1 className="font-display text-[19px] font-bold leading-tight text-white">{supplierNameOf(purchaseReturn)}</h1>
          <div className="mt-2">
            <Badge tone={badgeTone} variant="solid" size="xs">{stageLabel}</Badge>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button type="button" onClick={goBack} aria-label="Back to Purchase Returns" className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary">
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">{supplierNameOf(purchaseReturn)}</h1>
                <Badge tone={badgeTone} size="sm">{stageLabel}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">{purchaseReturn.return_number}</span>
                <Divider />
                <span>Returned {fmtDate(purchaseReturn.return_date)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {sourceOf(purchaseReturn) !== "—" && (
                  <>
                    <Divider />
                    <span>From <span className="font-mono font-semibold text-ink-secondary">{sourceOf(purchaseReturn)}</span></span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* R8 — wire the Purchase Return into the /document-flow graph so its
                convert-from chain (GRN -> PO -> SO) is visible, matching the other
                purchase-side details (PO / GRN / PI). Reads the real backend graph
                (type 'pr'), not a hand-built chain. */}
            <RelationshipMapButton type="pr" id={purchaseReturn.id} style={{ height: 34 }} />
            <Button variant="ghost" icon={<History size={14} />} onClick={goHistory}>History</Button>
            <Button variant="secondary" icon={<Printer size={14} />} onClick={print.openPreview}>Print PDF</Button>
            {canCancel && <Button variant="danger" icon={<XCircle size={14} />} onClick={doCancel}>Cancel return</Button>}
            {canPost && <Button variant="secondary" icon={<Send size={14} />} onClick={doPost}>Post</Button>}
            {canComplete && <Button variant="secondary" icon={<CheckCircle2 size={14} />} onClick={doComplete}>Complete</Button>}
            <Button variant="primary" icon={<Edit3 size={14} />} onClick={goEdit}>Edit</Button>
          </div>
        </div>
      </div>

      <div className="py-5">
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            {effectiveOf(purchaseReturn) === "completed" ? "Credit settled" : "Credit expected"}
          </div>
          <div className="mt-1 font-money text-[26px] font-bold leading-none tracking-tight text-synced">
            {fmtMoney(refund, purchaseReturn.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} · {EFFECTIVE_TONE[effectiveOf(purchaseReturn)].blurb}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            {purchaseReturn.reason && (
              <div className="mb-4 rounded-lg border-l-4 border-primary bg-primary-soft px-4 py-3">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Return reason</div>
                <div className="mt-1 text-[14px] font-semibold italic text-ink">“{purchaseReturn.reason}”</div>
              </div>
            )}

            <Section title="Supplier">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field label="Supplier" value={supplierNameOf(purchaseReturn)} />
                <Field label="Supplier code" value={supplierCodeOf(purchaseReturn)} mono />
                <Field label="Contact" value={purchaseReturn.supplier?.contact_person || "—"} muted={!purchaseReturn.supplier?.contact_person} />
                <Field label="Phone" value={purchaseReturn.supplier?.phone || "Not provided"} muted={!purchaseReturn.supplier?.phone} mono={!!purchaseReturn.supplier?.phone} />
                <Field label="Email" value={purchaseReturn.supplier?.email || "Not provided"} muted={!purchaseReturn.supplier?.email} />
                <Field label="Address" value={purchaseReturn.supplier?.address || "—"} muted={!purchaseReturn.supplier?.address} />
              </div>
            </Section>

            <Section title="Return info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field label="Return date" value={fmtDate(purchaseReturn.return_date)} />
                <Field label="Source" value={sourceOf(purchaseReturn)} mono={sourceOf(purchaseReturn) !== "—"} muted={sourceOf(purchaseReturn) === "—"} />
                <Field label="Credit note ref" value={purchaseReturn.credit_note_ref || "—"} muted={!purchaseReturn.credit_note_ref} mono={!!purchaseReturn.credit_note_ref} />
                <Field label="Currency" value={purchaseReturn.currency} />
              </div>
              {purchaseReturn.notes && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">Note</div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">{purchaseReturn.notes}</p>
                </div>
              )}
            </Section>

            <Section title={`Returned items · ${items.length}`}>
              <DataTable<PrItem>
                tableId={`pr-lines-${id}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.purchaseReturnLines}
                rows={items}
                loading={false}
                columns={lineColumns}
                getRowKey={(l) => l.id}
                emptyLabel="No line items"
              />
            </Section>
          </DetailMain>

          <DetailAside>
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <CreditHeroCard header={purchaseReturn} />

              <AsideCard title="Key dates">
                <KeyDateRow k="Return" v={fmtDate(purchaseReturn.return_date)} />
                {purchaseReturn.posted_at && <KeyDateRow k="Posted" v={fmtDate(purchaseReturn.posted_at)} />}
                {purchaseReturn.completed_at && <KeyDateRow k="Completed" v={fmtDate(purchaseReturn.completed_at)} />}
                {purchaseReturn.cancelled_at && <KeyDateRow k="Cancelled" v={fmtDate(purchaseReturn.cancelled_at)} />}
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={initialsOf(supplierNameOf(purchaseReturn))}
                  name={supplierNameOf(purchaseReturn)}
                  role={`Supplier · ${supplierCodeOf(purchaseReturn)}`}
                  tone="accent"
                />
                {purchaseReturn.supplier?.contact_person && (
                  <PersonRow
                    initials={initialsOf(purchaseReturn.supplier.contact_person)}
                    name={purchaseReturn.supplier.contact_person}
                    role={purchaseReturn.supplier.phone || "Contact"}
                    tone="neutral"
                  />
                )}
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`Return ${EFFECTIVE_TONE[effectiveOf(purchaseReturn)].label.toLowerCase()}`}
                  meta={fmtDate(purchaseReturn.return_date)}
                  dot={EFFECTIVE_TONE[effectiveOf(purchaseReturn)].tone === "success" ? "success" : "primary"}
                />
                {purchaseReturn.posted_at && (
                  <ActivityRow title="Posted" meta={fmtDate(purchaseReturn.posted_at)} dot="primary" />
                )}
                <ActivityRow title="Created" meta={fmtDate(purchaseReturn.created_at)} dot="muted" isLast />
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          {canPost ? (
            <button type="button" onClick={doPost} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Send size={16} /> Post
            </button>
          ) : canComplete ? (
            <button type="button" onClick={doComplete} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <CheckCircle2 size={16} /> Complete
            </button>
          ) : (
            <button type="button" onClick={goEdit} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Edit3 size={16} /> Edit
            </button>
          )}
          <button type="button" onClick={print.openPreview} className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft" aria-label="Print PDF">
            <Printer size={17} />
          </button>
          <button type="button" onClick={goCall} disabled={!purchaseReturn.supplier?.phone} className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40" aria-label={purchaseReturn.supplier?.phone ? `Call ${purchaseReturn.supplier.phone}` : "No phone on file"}>
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Purchase Return"
        docNo={purchaseReturn.return_number}
        rows={[
          { label: "Supplier", value: supplierNameOf(purchaseReturn) },
          { label: "Against", value: sourceOf(purchaseReturn) },
          { label: "Return date", value: fmtDate(purchaseReturn.return_date) },
          { label: "Items", value: `${items.length} line${items.length === 1 ? "" : "s"}` },
          { label: "Refund", value: fmtMoney(refund, purchaseReturn.currency) },
        ]}
        {...print.handlers}
      />
    </div>
  );
}

function Divider() {
  return (
    <span className="inline-flex items-center text-border-strong">
      <CircleDot size={4} className="mx-0.5 opacity-40" />
    </span>
  );
}

export default PurchaseReturnDetailV2;
