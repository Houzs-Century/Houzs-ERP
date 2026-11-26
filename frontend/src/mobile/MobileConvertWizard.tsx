import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateConvertShared } from "./sharedInvalidate";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { buildVariantSummary } from "../../../shared/src/vendor/shared/variant-summary";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { fmtSen } from "../lib/scm";
import { formatDate } from "../lib/utils";
import { SearchScopeHint } from "../components/SearchScopeHint";
import { transferToLabel, transferFromLabel } from "../lib/convertScope";
import { outstandingEmptyReason, type OutstandingScope } from "../lib/outstandingEmptyReason";
import "./mobile.css";
import { SI_TRANSFERABLE_DO_STATES } from '../vendor/shared/do-shipped-states';
import { soCanRaiseDo } from '../vendor/shared/so-deliverable-states';
import { soOffersTransferToDo } from '../lib/so-transfer-to-do';
import { customerRefOf } from '../../../shared/src/lib/customer-ref';
import { matchesSearch } from '../lib/so-ref-search';
import { DESCRIPTION_2_LABEL } from '../vendor/scm/components/VariantDescription';
import { lineDiscountShare } from '../vendor/shared/line-discount-share';
import { FormTouchScope } from "../components/FormTouchScope";
import { useFormTouched, useGuardedBack, useLeaveGuard } from "../hooks/useLeaveGuard";


export type ConvertTarget = "do" | "si" | "grn" | "po";

type SourceKind = "so" | "do" | "po";

const META: Record<
  ConvertTarget,
  {
    transferTitle: string; fromTitle: string; docTitle: string;
    eyebrow: string; source: SourceKind; sourceNoun: string; hasLinePicker: boolean;
  }
> = {
  do: { transferTitle: transferToLabel("do"), fromTitle: transferFromLabel("so"), docTitle: "Delivery Order", eyebrow: "Logistics", source: "so", sourceNoun: "Sales Order", hasLinePicker: true },
  si: { transferTitle: transferToLabel("si"), fromTitle: transferFromLabel("do"), docTitle: "Sales Invoice", eyebrow: "Finance", source: "do", sourceNoun: "Delivery Order", hasLinePicker: true },
  grn: { transferTitle: transferToLabel("grn"), fromTitle: transferFromLabel("po"), docTitle: "Goods Receipt", eyebrow: "Procurement", source: "po", sourceNoun: "Purchase Order", hasLinePicker: false },
  po: { transferTitle: transferToLabel("po"), fromTitle: transferFromLabel("so"), docTitle: "Purchase Order", eyebrow: "Procurement", source: "so", sourceNoun: "Sales Order", hasLinePicker: true },
};

const dm = (d: string | null | undefined) => formatDate(d);
const pick = (row: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};
const str = (v: unknown): string => (v == null ? "" : String(v));
const variantLineOf = (row: unknown): string =>
  buildVariantSummary(
    str(pick(row, "itemGroup", "item_group")) || null,
    (pick(row, "variants") as Record<string, unknown> | undefined) ?? null,
  );
const clampQty = (raw: string, max: number): number => {
  const n = Math.floor(Number(String(raw).replace(/[^\d.]/g, "")));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (max > 0 && n > max) return max;
  return n;
};

type SoListRow = {
  doc_no: string; debtor_name: string | null; status: string | null; on_hold?: boolean | null;
  so_date: string | null; local_total_sen: number | null; total_revenue_sen: number | null;
  ref?: string | null; customer_so_no?: string | null;
  has_undelivered?: boolean | null;
};
type DoListRow = {
  id: string; do_number: string; debtor_name: string | null; status: string | null;
  do_date: string | null; local_total_sen: number | null;
  ref?: string | null; customer_so_no?: string | null;
};
type PoListRow = {
  id: string; po_number: string; status: string | null; po_date: string | null;
  total_sen: number | null; supplier?: { id?: string; code?: string; name?: string } | null;
};

type SoDeliverableLine = {
  soItemId: string; docNo: string; itemCode: string; description: string | null;
  itemGroup: string | null; variants: unknown;
  qty: number; remaining: number; unitPriceSen: number; debtorName: string | null;
  discountSen?: number;
  notReady: { reason: string } | null;
};
type DoInvoiceableLine = {
  doItemId: string; doNumber: string; itemCode: string; description: string | null;
  itemGroup: string | null; variants: unknown;
  remaining: number; unitPriceSen: number; debtorName: string | null;
  delivered?: number; discountSen?: number;
};
type OutstandingSoLine = {
  soItemId: string; soDocNo: string; itemCode: string; description: string | null;
  itemGroup: string | null; variants: unknown;
  qty: number; poQtyPicked: number; remainingQty: number; unitPriceSen: number;
};
type OutstandingPoLine = {
  poItemId: string; poId: string; supplierId: string; itemCode: string;
  // Owner 2026-07-27 — the supplier's own code (the PO line's snapshot); the
  // /grns/outstanding-po-items endpoint returns it (#1347). Surfaced so the
  // mobile receiver sees the code the delivery note uses, like the desktop.
  supplierSku: string | null;
  description: string | null; itemGroup: string | null; variants: unknown;
  deliveryDate: string | null; warehouseLocationId: string | null;
  qty: number; receivedQty: number; remainingQty: number; unitPriceSen: number;
};

type GrnPickLine = {
  poItemId: string; poId: string; supplierId: string;
  itemCode: string; supplierSku: string | null; description: string | null; itemGroup: string | null;
  variants: unknown; unitPriceSen: number;
  origQty: number;
  remaining: number;
  checked: boolean;
  qty: string;
};

type PickLine = {
  lineId: string;
  label: string;
  /* Owner rule 2026-08-19 — "只要有 variants 的，你就应该要显示 variants".
     A sofa model decomposes into modules that share a name, so `label` alone
     renders three identical-looking rows and the operator cannot tell which one
     he is converting. This is the SAME live buildVariantSummary string the
     desktop pickers render through VariantDescription — computed at map time so
     the row render stays pure. Empty ('') on a line with no variants, and the
     row then omits the line entirely (mobile convention, see
     MobileModuleDetail.tsx:491 — no "Standard" filler on a phone). */
  variantLine: string;
  notReadyReason: string | null;
  origQty: number;
  remaining: number;
  unitPriceSen: number;
  discountSen: number;
  discountBaseQty: number;
  discountMovedQty: number;
  checked: boolean;
  qty: string;
};

const pickLineValueSen = (
  l: Pick<PickLine, "unitPriceSen" | "discountSen" | "discountBaseQty" | "discountMovedQty">,
  qty: number,
): number => l.unitPriceSen * qty - lineDiscountShare(l.discountSen, l.discountBaseQty, l.discountMovedQty, qty);

export function MobileConvertWizard({
  target,
  onBack,
  onCreated,
  initialSourceId,
}: {
  target: ConvertTarget;
  onBack: () => void;
  /* docId is set only where the next step happens ON the new document — a GRN
     draft, whose racks the storekeeper scans next (owner 2026-10-02). */
  onCreated: (docNo: string, docId?: string) => void;
  initialSourceId?: string | null;
}) {
  const { touched: formTouched, markTouched } = useFormTouched();
  const { allowLeave } = useLeaveGuard(formTouched, null);
  const guardedBack = useGuardedBack(onBack);
  const meta = META[target];
  const qc = useQueryClient();
  const notify = useNotify();
  const idemKey = useIdempotencyKey();

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    meta.source !== "po" ? (initialSourceId ?? null) : null,
  );
  const [selectedPoIds, setSelectedPoIds] = useState<string[]>([]);
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null);
  const [lines, setLines] = useState<PickLine[]>([]);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [notes, setNotes] = useState("");

  const step: 1 | 2 = meta.source === "po"
    ? (selectedPoIds.length > 0 ? 2 : 1)
    : (selectedSourceId ? 2 : 1);

  const sourceQuery = useQuery<any>({
    queryKey: ["convert-source", meta.source],
    queryFn: () => {
      if (meta.source === "so") return authedFetch<{ salesOrders?: SoListRow[] }>("/mfg-sales-orders?limit=200");
      if (meta.source === "do") return authedFetch<{ deliveryOrders?: DoListRow[] }>("/delivery-orders-mfg?limit=200");
      return authedFetch<{ purchaseOrders?: PoListRow[] }>("/mfg-purchase-orders?limit=200");
    },
    staleTime: 30_000,
  });

  const sources = useMemo(() => {
    const data = sourceQuery.data as any;
    /* ONE DECLARATION, NOT A THIRD OPINION. This was a hand-typed
       `!== DRAFT && !== CANCELLED` — a fourth spelling of the same rule, kept in
       step with the other three only by whoever remembered. The desktop, the
       server gate (siTransferRefusal) and the server's own DO picker all read
       SI_TRANSFERABLE_DO_STATES; this now does too, so the phone offers exactly
       what the create path accepts. The set includes LOADED (owner 2026-08-19,
       #2485) and excludes INVOICED, which nothing ever writes. */
    const isTransferableDo = (status: string | null) =>
      (SI_TRANSFERABLE_DO_STATES as readonly string[]).includes(str(status).toUpperCase());
    const isReceivablePo = (status: string | null) => {
      const s = str(status).toUpperCase();
      return s !== "DRAFT" && s !== "CANCELLED" && s !== "RECEIVED" && s !== "CLOSED";
    };
    const needle = q.trim().toLowerCase();
    /* A SALES ORDER source asks the Sales Order's own question. The DO set above
       was applied here too, and a Sales Order is never LOADED or DISPATCHED, so
       the phone offered only DELIVERED orders — a confirmed order waiting for its
       delivery never appeared (docs/bugs/0888). soCanRaiseDo is the rule the DO
       create gate enforces (firstUndeliverableSo), and the PO create gate's set
       is pinned equal to it. */
    if (meta.source === "so") {
      return ((data?.salesOrders ?? []) as SoListRow[])
        .filter((r) => (target === "do" ? soOffersTransferToDo(r) : soCanRaiseDo(r.status, r.on_hold ?? null)))
        .filter((r) => matchesSearch([r.debtor_name, r.doc_no, customerRefOf(r)], needle));
    }
    if (meta.source === "do") {
      return ((data?.deliveryOrders ?? []) as DoListRow[])
        .filter((r) => isTransferableDo(r.status))
        .filter((r) => matchesSearch([r.debtor_name, r.do_number, customerRefOf(r)], needle));
    }
    return ((data?.purchaseOrders ?? []) as PoListRow[])
      .filter((r) => isReceivablePo(r.status))
      .filter((r) => !supplierFilter || str(r.supplier?.id) === supplierFilter)
      .filter((r) => !needle || `${str(r.supplier?.name)} ${r.po_number}`.toLowerCase().includes(needle));
  }, [sourceQuery.data, meta.source, q, supplierFilter, target]);

  const suppliers = useMemo(() => {
    if (meta.source !== "po") return [];
    const data = sourceQuery.data as any;
    const seen = new Map<string, string>();
    for (const r of (data?.purchaseOrders ?? []) as PoListRow[]) {
      const s = str(r.status).toUpperCase();
      if (s === "DRAFT" || s === "CANCELLED" || s === "RECEIVED" || s === "CLOSED") continue;
      const id = str(r.supplier?.id);
      if (id) seen.set(id, str(r.supplier?.name) || str(r.supplier?.code) || id);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [sourceQuery.data, meta.source]);

  const linesQuery = useQuery({
    enabled: meta.hasLinePicker && !!selectedSourceId,
    queryKey: ["convert-lines", target, selectedSourceId],
    queryFn: async () => {
      if (target === "po") {
        const res = await authedFetch<{ items?: OutstandingSoLine[] }>(
          `/mfg-purchase-orders/outstanding-so-items`,
        );
        return (res.items ?? [])
          .filter((l) => str(l.soDocNo) === str(selectedSourceId))
          .map<PickLine>((l) => ({
            lineId: l.soItemId,
            label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
            variantLine: variantLineOf(l),
            notReadyReason: null,
            origQty: Number(l.qty) || 0,
            remaining: Number(l.remainingQty) || 0,
            unitPriceSen: Number(l.unitPriceSen) || 0,
            discountSen: 0,
            discountBaseQty: 0,
            discountMovedQty: 0,
            checked: true,
            qty: String(Number(l.remainingQty) || 0),
          }));
      }
      if (meta.source === "so") {
        const res = await authedFetch<{ lines?: SoDeliverableLine[] }>(
          `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(selectedSourceId!)}`,
        );
        return (res.lines ?? []).map<PickLine>((l) => ({
          lineId: l.soItemId,
          label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
          variantLine: variantLineOf(l),
          notReadyReason: l.notReady?.reason ?? null,
          origQty: Number(l.qty) || 0,
          remaining: Number(l.remaining) || 0,
          unitPriceSen: Number(l.unitPriceSen) || 0,
          discountSen: Number(l.discountSen) || 0,
          discountBaseQty: Number(l.qty) || 0,
          discountMovedQty: (Number(l.qty) || 0) - (Number(l.remaining) || 0),
          checked: !l.notReady,
          qty: String(Number(l.remaining) || 0),
        }));
      }
      const res = await authedFetch<{ lines?: DoInvoiceableLine[] }>(
        `/sales-invoices/invoiceable-do-lines?doIds=${encodeURIComponent(selectedSourceId!)}`,
      );
      return (res.lines ?? []).map<PickLine>((l) => ({
        lineId: l.doItemId,
        label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
        variantLine: variantLineOf(l),
        notReadyReason: null,
        origQty: Number(l.remaining) || 0,
        remaining: Number(l.remaining) || 0,
        unitPriceSen: Number(l.unitPriceSen) || 0,
        discountSen: Number(l.discountSen) || 0,
        discountBaseQty: Number(l.delivered) || 0,
        discountMovedQty: (Number(l.delivered) || 0) - (Number(l.remaining) || 0),
        checked: true,
        qty: String(Number(l.remaining) || 0),
      }));
    },
    staleTime: 15_000,
  });

  useEffect(() => {
    if (linesQuery.data) setLines(linesQuery.data);
  }, [linesQuery.data]);

  const setLine = (id: string, patch: Partial<PickLine>) =>
    setLines((prev) => prev.map((l) => (l.lineId === id ? { ...l, ...patch } : l)));

  const picks = useMemo(
    () => lines.filter((l) => l.checked && clampQty(l.qty, l.remaining) >= 1),
    [lines],
  );
  const pickedTotalSen = useMemo(
    () => picks.reduce((a, l) => a + pickLineValueSen(l, clampQty(l.qty, l.remaining)), 0),
    [picks],
  );

  const [grnLines, setGrnLines] = useState<GrnPickLine[]>([]);
  const grnLinesQuery = useQuery({
    enabled: target === "grn" && selectedPoIds.length > 0,
    queryKey: ["convert-grn-lines", [...selectedPoIds].sort().join(",")],
    queryFn: async () => {
      /* Scope the READ, not the result. This used to fetch the unscoped list and
         filter by `selectedPoIds` here — and that list was capped at 500 raw PO
         lines server-side, so a selected PO outside the window silently produced
         zero lines (the owner's 2026-08-17 desktop screen, same endpoint, same
         mechanism). The server now applies `?poId=` in SQL. The JS filter below
         is kept as a belt-and-braces narrowing, not as the scope. */
      const scoped = [...selectedPoIds].map((x) => str(x)).sort().join(',');
      const res = await authedFetch<{ items?: OutstandingPoLine[]; scope?: OutstandingScope }>(
        `/grns/outstanding-po-items?poId=${encodeURIComponent(scoped)}`,
      );
      const set = new Set(selectedPoIds.map((x) => str(x)));
      const serverRows = res.items ?? [];
      const lines = serverRows
        .filter((r) => set.has(str(r.poId)))
        .filter((r) => (Number(r.remainingQty) || 0) > 0)
        .map<GrnPickLine>((r) => ({
          poItemId: str(r.poItemId),
          poId: str(r.poId),
          supplierId: str(r.supplierId),
          itemCode: str(r.itemCode),
          supplierSku: (pick(r, "supplierSku") as string | undefined) ?? null,
          description: (pick(r, "description") as string | undefined) ?? null,
          itemGroup: (pick(r, "itemGroup") as string | undefined) ?? null,
          variants: r.variants ?? null,
          unitPriceSen: Number(r.unitPriceSen) || 0,
          origQty: Number(r.qty) || 0,
          remaining: Number(r.remainingQty) || 0,
          checked: true,
          qty: String(Number(r.remainingQty) || 0),
        }));
      return { lines, scope: res.scope ?? null, serverRowCount: serverRows.length };
    },
    staleTime: 15_000,
  });
  useEffect(() => {
    if (grnLinesQuery.data) setGrnLines(grnLinesQuery.data.lines);
  }, [grnLinesQuery.data]);
  const grnEmptyReason = outstandingEmptyReason({
    isError: !!grnLinesQuery.error,
    isLoading: grnLinesQuery.isLoading,
    scope: grnLinesQuery.data?.scope ?? null,
    serverRowCount: grnLinesQuery.data?.serverRowCount ?? 0,
    scopedRowCount: grnLinesQuery.data?.serverRowCount ?? 0,
    visibleRowCount: grnLines.length,
    filtersActive: false,
    poScopeActive: false,
  });
  const setGrnLine = (id: string, patch: Partial<GrnPickLine>) =>
    setGrnLines((prev) => prev.map((l) => (l.poItemId === id ? { ...l, ...patch } : l)));
  const grnPicks = useMemo(
    () => grnLines.filter((l) => l.checked && clampQty(l.qty, l.remaining) >= 1),
    [grnLines],
  );
  const grnPickedTotalSen = useMemo(
    () => grnPicks.reduce((a, l) => a + l.unitPriceSen * clampQty(l.qty, l.remaining), 0),
    [grnPicks],
  );

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      let newDocNo = "";
      let newDocId = "";

      if (target === "do") {
        const body = { asDraft: true, picks: picks.map((l) => ({ soItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        const res = await authedFetch<{ doNumber?: string }>("/delivery-orders-mfg/from-sos",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        newDocNo = str(res?.doNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else if (target === "si") {
        /* SI — create a DRAFT, never a SENT invoice (owner 2026-08-20:
           「以电脑为准 —— 手机也先出草稿」). This body carried `picks` alone, and
           the route lands `status: isDraft ? 'DRAFT' : 'SENT'` with `sent_at` +
           `confirmed_at` stamped and `invoice_date` forced to today
           (sales-invoices.ts) — so three taps on a phone ISSUED a
           customer-facing invoice with no due date, no terms and no review. The
           desktop cannot reach this endpoint at all: it goes SalesInvoiceFromDo
           -> SalesInvoiceNew with a full header form, which is the review step
           the phone had no equivalent of.
           Same shape and same reasoning as the GRN arm below — post the draft,
           let the operator confirm it from the document (PATCH /:id/status
           DRAFT -> SENT, which the mobile detail screen already offers as
           "Confirm Invoice"). Confirm is the single AR/revenue-writing
           chokepoint, exactly as /post is for stock. */
        const body = { asDraft: true, picks: picks.map((l) => ({ doItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        const res = await authedFetch<{ invoiceNumber?: string }>("/sales-invoices/from-dos",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        newDocNo = str(res?.invoiceNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else if (target === "po") {
        const body = { picks: picks.map((l) => ({ soItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        const res = await authedFetch<{ created?: Array<{ poNumber?: string }> }>("/mfg-purchase-orders/from-sos",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        const created = res?.created ?? [];
        newDocNo = created.map((p) => str(p.poNumber)).filter(Boolean).join(", ");
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else {
        const first = grnPicks[0];
        const body: Record<string, unknown> = {
          asDraft: true,
          supplierId: first?.supplierId,
          purchaseOrderId: first?.poId,
          items: grnPicks.map((l) => {
            const q = clampQty(l.qty, l.remaining);
            return {
              purchaseOrderItemId: l.poItemId,
              materialKind: "mfg_product",
              itemCode: l.itemCode,
              materialName: l.description || l.itemCode,
              qtyReceived: q,
              qtyAccepted: q,
              qtyRejected: 0,
              unitPriceSen: l.unitPriceSen,
              itemGroup: l.itemGroup,
              variants: l.variants,
            };
          }),
        };
        if (deliveryNoteRef.trim()) body.deliveryNoteRef = deliveryNoteRef.trim();
        if (notes.trim()) body.notes = notes.trim();
        const res = await authedFetch<{ id?: string; grnNumber?: string }>("/grns",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        newDocNo = str(res?.grnNumber);
        newDocId = str(res.id);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      }

      invalidateConvertShared(qc);
      allowLeave();
      onCreated(newDocNo, newDocId || undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't create the document.";
      if (!/^declined_/.test(msg)) {
        await notify({ title: `Couldn't create ${meta.docTitle}`, body: humanize(msg), tone: "error" });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const canCreate = meta.hasLinePicker ? picks.length > 0 : grnPicks.length > 0;

  const sourceLabel = useMemo(() => {
    if (meta.source === "po") {
      return selectedPoIds.length
        ? `${selectedPoIds.length} Purchase Order${selectedPoIds.length === 1 ? "" : "s"}`
        : "";
    }
    if (!selectedSourceId) return "";
    if (meta.source === "so") return selectedSourceId;
    const row = ((sourceQuery.data as any)?.deliveryOrders ?? []).find(
      (r: DoListRow) => str(r.id) === selectedSourceId,
    ) as DoListRow | undefined;
    return row ? str(row.do_number) : "";
  }, [meta.source, selectedPoIds, selectedSourceId, sourceQuery.data]);

  const stepLabel = step === 1
    ? "Select source"
    : meta.hasLinePicker ? "Select lines to convert" : "Set received quantities";

  return (
    <FormTouchScope onTouch={markTouched}>
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={guardedBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> Cancel
          </button>
          <span style={{ fontSize: 11, color: "var(--hz-c-ink-muted)" }}>Step {step} of 2 · {stepLabel}</span>
        </div>
        <div className="ey" style={{ color: "var(--hz-c-accent)", marginTop: 6 }}>{meta.eyebrow}</div>
        <div className="scr-title" style={{ marginTop: 2 }}>{meta.transferTitle}</div>
        <div className="tnum" style={{ fontSize: 11.5, color: "var(--hz-c-ink-muted)", marginTop: 3 }}>
          {/* Spec sub-line: "From {{source_doc_no}}" once a source is chosen;
              before that, the invitation to pick one. The invitation is SINGULAR
              even where the picker takes several sources — it names the source
              document TYPE, not the count (owner rule, 2026-08-17). */}
          {sourceLabel ? `From ${sourceLabel}` : meta.fromTitle}
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 11 }}>
          {[1, 2].map((s) => (
            <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: s <= step ? "var(--brand)" : "var(--line-card)" }} />
          ))}
        </div>
        {step === 1 && (
          <div style={{ marginTop: 10 }}>
            <div className="searchbar">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${meta.sourceNoun.toLowerCase()}`} />
            </div>
            <SearchScopeHint
              scope="loaded"
              loadedLimit={200}
              countPending={sourceQuery.isLoading || sourceQuery.isError}
              resultCount={sourceQuery.isSuccess ? sources.length : undefined}
              term={q}
              className="mt-1 px-1"
            />
          </div>
        )}
        {step === 1 && meta.source === "po" && suppliers.length > 0 && (
          <div className="chips" style={{ marginTop: 10, paddingBottom: 2 }}>
            <button onClick={() => setSupplierFilter(null)} className={!supplierFilter ? "chip on" : "chip"}>All suppliers</button>
            {suppliers.map((s) => (
              <button key={s.id} onClick={() => setSupplierFilter(s.id)} className={supplierFilter === s.id ? "chip on" : "chip"}>{s.name}</button>
            ))}
          </div>
        )}
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 130 }}>
        {step === 1 ? (
          <SourceStep
            kind={meta.source}
            loading={sourceQuery.isLoading}
            error={!!sourceQuery.error}
            rows={sources}
            selectedPoIds={selectedPoIds}
            supplierFilter={supplierFilter}
            onPickSingle={(id) => setSelectedSourceId(id)}
            onTogglePo={(row) => {
              const sid = str(row.supplier?.id);
              setSelectedPoIds((prev) => {
                if (prev.includes(row.id)) {
                  const next = prev.filter((x) => x !== row.id);
                  if (next.length === 0) setSupplierFilter(null);
                  return next;
                }
                if (prev.length === 0 && sid) setSupplierFilter(sid);
                return [...prev, row.id];
              });
            }}
          />
        ) : meta.hasLinePicker ? (
          <LinesStep
            loading={linesQuery.isLoading}
            error={!!linesQuery.error}
            lines={lines}
            target={target}
            onSetLine={setLine}
            onChangeSource={() => { setSelectedSourceId(null); setLines([]); }}
          />
        ) : (
          <GrnLinesStep
            loading={grnLinesQuery.isLoading}
            error={!!grnLinesQuery.error}
            lines={grnLines}
            emptyReason={grnEmptyReason}
            deliveryNoteRef={deliveryNoteRef}
            notes={notes}
            onSetLine={setGrnLine}
            onRef={setDeliveryNoteRef}
            onNotes={setNotes}
            onChangeSource={() => { setSelectedPoIds([]); setSupplierFilter(null); setGrnLines([]); }}
          />
        )}
      </div>

      {step === 2 && (
        <footer className="actbar">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
            {meta.hasLinePicker ? (
              <>
                <span style={{ fontSize: 11.5, color: "var(--hz-c-ink-muted)" }}>{picks.length} {picks.length === 1 ? "line" : "lines"}</span>
                <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--hz-c-primary-ink)" }}>{fmtSen(pickedTotalSen)}</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 11.5, color: "var(--hz-c-ink-muted)" }}>{grnPicks.length} {grnPicks.length === 1 ? "line" : "lines"}</span>
                <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--hz-c-primary-ink)" }}>{fmtSen(grnPickedTotalSen)}</span>
              </>
            )}
          </div>
          <button
            className="btn"
            disabled={!canCreate || submitting}
            onClick={submit}
            style={{ opacity: !canCreate || submitting ? 0.55 : 1 }}
          >
            {submitting ? "Creating…" : (target === "grn" || target === "do")
              ? `Create draft ${meta.docTitle}`
              : `Create ${meta.docTitle}`}
          </button>
        </footer>
      )}
    </div>
    </FormTouchScope>
  );
}

function SourceStep({
  kind, loading, error, rows, selectedPoIds, supplierFilter, onPickSingle, onTogglePo,
}: {
  kind: SourceKind;
  loading: boolean;
  error: boolean;
  rows: any[];
  selectedPoIds: string[];
  supplierFilter: string | null;
  onPickSingle: (id: string) => void;
  onTogglePo: (row: PoListRow) => void;
}) {
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <Muted danger>Couldn't load the source documents. Please try again.</Muted>;
  if (!rows.length) return <Muted>No convertible documents to show.</Muted>;

  if (kind === "po") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {supplierFilter && selectedPoIds.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--hz-c-accent)", padding: "0 2px" }}>
            One supplier per Goods Receipt — tap more of this supplier's POs to combine.
          </div>
        )}
        {(rows as PoListRow[]).map((r) => {
          const on = selectedPoIds.includes(r.id);
          return (
            <div key={r.id} onClick={() => onTogglePo(r)} className="so-row" style={{ position: "relative", borderColor: on ? "var(--teal)" : undefined }}>
              <div className="so-row-head">
                <span className="so-row-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {str(r.supplier?.name) || str(r.po_number)}
                </span>
                <span className="spill" style={{ background: on ? "var(--hz-c-primary-soft)" : "var(--hz-c-surface-2)", color: on ? "var(--hz-c-primary-ink)" : "var(--hz-c-ink-muted)", border: on ? "none" : "1px solid var(--hz-c-border-subtle)", flex: "none" }}>
                  {on ? "Selected" : str(r.status) || "—"}
                </span>
              </div>
              <div className="so-grid">
                <span className="so-k">Order</span>
                <span className="so-v money" style={{ fontWeight: 700, color: "var(--hz-c-primary-ink)" }}>{str(r.po_number) || "—"}</span>
                <span className="so-k">Date</span>
                <span className="so-v">{dm(r.po_date)}</span>
                <span className="so-k">Total</span>
                <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "var(--hz-c-ink)" }}>{fmtSen(r.total_sen)}</span>
              </div>
              {on && <Check />}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((r: any) => {
        const id = kind === "so" ? str(r.doc_no) : str(r.id);
        const docNo = kind === "so" ? str(r.doc_no) : str(r.do_number);
        const date = kind === "so" ? r.so_date : r.do_date;
        const totalC = kind === "so"
          ? (r.local_total_sen ?? r.total_revenue_sen)
          : r.local_total_sen;
        return (
          <div key={id} onClick={() => onPickSingle(id)} className="so-row">
            <div className="so-row-head">
              <span className="so-row-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {str(r.debtor_name) || docNo}
              </span>
              {r.status && (
                <span className="spill" style={{ background: "var(--hz-c-surface-2)", color: "var(--hz-c-ink-muted)", border: "1px solid var(--hz-c-border-subtle)", flex: "none" }}>{str(r.status)}</span>
              )}
            </div>
            <div className="so-grid">
              <span className="so-k">{kind === "so" ? "Order" : "Delivery"}</span>
              <span className="so-v money" style={{ fontWeight: 700, color: "var(--hz-c-primary-ink)" }}>{docNo || "—"}</span>
              <span className="so-k">Date</span>
              <span className="so-v">{dm(date)}</span>
              <span className="so-k">Total</span>
              <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "var(--hz-c-ink)" }}>{fmtSen(totalC)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LinesStep({
  loading, error, lines, target, onSetLine, onChangeSource,
}: {
  loading: boolean;
  error: boolean;
  lines: PickLine[];
  target: ConvertTarget;
  onSetLine: (id: string, patch: Partial<PickLine>) => void;
  onChangeSource: () => void;
}) {
  if (loading) return <Muted>Loading lines…</Muted>;
  if (error) return <Muted danger>Couldn't load the convertible lines. Please try again.</Muted>;

  const noun = target === "si" ? "invoice" : target === "po" ? "purchase" : "deliver";
  if (!lines.length) {
    /* The GRN arm below was given a counted, per-document reason (#2372). THIS
       arm — SI, PO and DO — was left saying "Nothing left to {noun} on this
       document", which is the same claim from the same absence: the read is
       company-scoped and scopeToCompany fails closed, so [] arrives with
       error: null whether the work is done or the company could not be
       resolved. Until this arm carries a line count of its own it has no
       standing for a verdict, so it reports the read and points at the
       document's own balance. */
    return (
      <>
        <ChangeSource onClick={onChangeSource} />
        <Muted>
          No lines are showing to {noun} on this document. That is not the same as there
          being nothing left — this list only covers the company you are working in. Open
          the document and check its balance.
        </Muted>
      </>
    );
  }

  return (
    <>
      <ChangeSource onClick={onChangeSource} />
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {lines.map((l) => {
          const qtyNum = clampQty(l.qty, l.remaining);
          const ofQty = l.origQty > 0 ? l.origQty : l.remaining;
          const dec = () => onSetLine(l.lineId, { qty: String(Math.max(1, qtyNum - 1)) });
          const inc = () => onSetLine(l.lineId, { qty: String(clampQty(String(qtyNum + 1), l.remaining)) });
          return (
            <div key={l.lineId} className="card" style={{ padding: "11px 12px", borderColor: l.checked ? "var(--teal)" : undefined }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={l.checked}
                  onChange={(e) => onSetLine(l.lineId, { checked: e.target.checked })}
                  style={{ marginTop: 2, width: 16, height: 16, flex: "none", accentColor: "#16695f" }}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "var(--hz-c-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.label}</span>
                  {/* Owner rule 2026-08-19 — the variant summary, so three sofa
                      modules under one model name are three DIFFERENT rows on
                      the phone too. Wraps (no ellipsis): a truncated
                      "BF-01 / SEAT 24 / LEG …" is the same ambiguity again. */}
                  {l.variantLine && (
                    <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--hz-c-ink-muted)" }}><span>{DESCRIPTION_2_LABEL}: </span><span>{l.variantLine}</span></span>
                  )}
                  {l.notReadyReason && (
                    <span style={{ display: "block", marginTop: 3, fontSize: 11, fontWeight: 600, color: "var(--hz-c-accent)" }}>Not ready: {l.notReadyReason}</span>
                  )}
                  <span className="tnum" style={{ display: "block", marginTop: 3, fontSize: 11, color: "var(--hz-c-ink-muted)" }}>
                    Outstanding ×{l.remaining} of {ofQty} · {fmtSen(l.unitPriceSen)} each
                  </span>
                </span>
              </label>
              {l.checked && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 9, paddingTop: 9, borderTop: "1px solid #eceee9" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--hz-c-border)", borderRadius: 8 }}>
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={dec}
                      disabled={qtyNum <= 1}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum <= 1 ? "#c2c6bd" : "var(--hz-c-primary)", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum <= 1 ? "default" : "pointer" }}
                    >
                      −
                    </button>
                    <input
                      className="tnum"
                      inputMode="numeric"
                      value={l.qty}
                      onChange={(e) => onSetLine(l.lineId, { qty: e.target.value })}
                      onBlur={() => onSetLine(l.lineId, { qty: String(clampQty(l.qty, l.remaining)) })}
                      aria-label="Quantity to convert"
                      style={{ width: 40, height: 30, textAlign: "center", border: "none", borderLeft: "1px solid #eceee9", borderRight: "1px solid #eceee9", background: "none", outline: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 700, color: "var(--hz-c-ink)" }}
                    />
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={inc}
                      disabled={qtyNum >= l.remaining}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum >= l.remaining ? "#c2c6bd" : "var(--hz-c-primary)", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum >= l.remaining ? "default" : "pointer" }}
                    >
                      +
                    </button>
                  </div>
                  <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: "var(--hz-c-primary-ink)" }}>{fmtSen(pickLineValueSen(l, qtyNum))}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function GrnLinesStep({
  loading, error, lines, emptyReason, deliveryNoteRef, notes, onSetLine, onRef, onNotes, onChangeSource,
}: {
  loading: boolean;
  error: boolean;
  lines: GrnPickLine[];
  emptyReason: string | null;
  deliveryNoteRef: string;
  notes: string;
  onSetLine: (id: string, patch: Partial<GrnPickLine>) => void;
  onRef: (v: string) => void;
  onNotes: (v: string) => void;
  onChangeSource: () => void;
}) {
  if (loading) return <><ChangeSource onClick={onChangeSource} label="Change selection" /><Muted>Loading lines…</Muted></>;
  if (error) return <><ChangeSource onClick={onChangeSource} label="Change selection" /><Muted danger>Couldn't load the receivable lines. Please try again.</Muted></>;
  if (!lines.length) {
    return (
      <>
        <ChangeSource onClick={onChangeSource} label="Change selection" />
        <Muted>{emptyReason ?? 'No receivable lines are showing for the selected order(s).'}</Muted>
      </>
    );
  }

  return (
    <>
      <ChangeSource onClick={onChangeSource} label="Change selection" />
      <div style={{ fontSize: 11, color: "var(--hz-c-accent)", padding: "0 2px 10px" }}>
        Set the quantity received per line. This creates a DRAFT Goods Receipt — review it and post it from the receipt to move stock (nothing is received yet).
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {lines.map((l) => {
          const qtyNum = clampQty(l.qty, l.remaining);
          const ofQty = l.origQty > 0 ? l.origQty : l.remaining;
          const dec = () => onSetLine(l.poItemId, { qty: String(Math.max(1, qtyNum - 1)) });
          const inc = () => onSetLine(l.poItemId, { qty: String(clampQty(String(qtyNum + 1), l.remaining)) });
          const variantLine = variantLineOf(l);
          return (
            <div key={l.poItemId} className="card" style={{ padding: "11px 12px", borderColor: l.checked ? "var(--teal)" : undefined }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={l.checked}
                  onChange={(e) => onSetLine(l.poItemId, { checked: e.target.checked })}
                  style={{ marginTop: 2, width: 16, height: 16, flex: "none", accentColor: "#16695f" }}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "var(--hz-c-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.description || l.itemCode}</span>
                  {/* Owner rule 2026-08-19 — RECEIVING is where getting the
                      module wrong costs the most: the stock lands under a code
                      whose variants nobody checked. GrnPickLine already carried
                      itemGroup + variants (they are needed to CREATE the GRN
                      line); only the render was missing them. */}
                  {variantLine && (
                    <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--hz-c-ink-muted)" }}><span>{DESCRIPTION_2_LABEL}: </span><span>{variantLine}</span></span>
                  )}
                  {l.supplierSku && (
                    <span style={{ display: "block", marginTop: 2, fontSize: 11, fontWeight: 600, color: "var(--hz-c-ink-muted)", fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      Supplier SKU: {l.supplierSku}
                    </span>
                  )}
                  <span className="tnum" style={{ display: "block", marginTop: 3, fontSize: 11, color: "var(--hz-c-ink-muted)" }}>
                    Outstanding ×{l.remaining} of {ofQty} · {fmtSen(l.unitPriceSen)} each
                  </span>
                </span>
              </label>
              {l.checked && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 9, paddingTop: 9, borderTop: "1px solid #eceee9" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--hz-c-border)", borderRadius: 8 }}>
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={dec}
                      disabled={qtyNum <= 1}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum <= 1 ? "#c2c6bd" : "var(--hz-c-primary)", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum <= 1 ? "default" : "pointer" }}
                    >
                      −
                    </button>
                    <input
                      className="tnum"
                      inputMode="numeric"
                      value={l.qty}
                      onChange={(e) => onSetLine(l.poItemId, { qty: e.target.value })}
                      onBlur={() => onSetLine(l.poItemId, { qty: String(clampQty(l.qty, l.remaining)) })}
                      aria-label="Quantity received"
                      style={{ width: 40, height: 30, textAlign: "center", border: "none", borderLeft: "1px solid #eceee9", borderRight: "1px solid #eceee9", background: "none", outline: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 700, color: "var(--hz-c-ink)" }}
                    />
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={inc}
                      disabled={qtyNum >= l.remaining}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum >= l.remaining ? "#c2c6bd" : "var(--hz-c-primary)", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum >= l.remaining ? "default" : "pointer" }}
                    >
                      +
                    </button>
                  </div>
                  <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: "var(--hz-c-primary-ink)" }}>{fmtSen(l.unitPriceSen * qtyNum)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="so-card" style={{ marginTop: 12 }}>
        <div className="so-bd">
          <label className="fld">
            <span className="fld-l">Delivery Note Ref</span>
            <input className="fld-i" value={deliveryNoteRef} onChange={(e) => onRef(e.target.value)} placeholder="Supplier DN number (optional)" />
          </label>
          <label className="fld">
            <span className="fld-l">Notes</span>
            <input className="fld-i" value={notes} onChange={(e) => onNotes(e.target.value)} placeholder="Optional" />
          </label>
        </div>
      </div>
    </>
  );
}

function Muted({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return <div style={{ textAlign: "center", color: danger ? "var(--hz-c-err)" : "var(--hz-c-ink-soft)", fontSize: 12, padding: "26px 0" }}>{children}</div>;
}
function ChangeSource({ onClick, label = "Change source" }: { onClick: () => void; label?: string }) {
  return (
    <span
      onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, marginBottom: 11, fontSize: 12.5, fontWeight: 600, color: "var(--hz-c-primary)", cursor: "pointer" }}
    >
      <span style={{ fontSize: 15, lineHeight: 1 }}>{"‹"}</span> {label}
    </span>
  );
}
function Check() {
  return (
    <span style={{ position: "absolute", top: 10, right: 10, width: 18, height: 18, borderRadius: "50%", background: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
    </span>
  );
}

function humanize(msg: string): string {
  const map: Record<string, string> = {
    picks_required: "Select at least one line to convert.",
    mixed_customers: "All picked lines must belong to the same customer.",
    mixed_suppliers: "All selected Purchase Orders must be from the same supplier.",
    missing_bindings: "One or more products have no supplier assigned yet. Bind a supplier to them (on the desktop Products screen) before raising a Purchase Order.",
    qty_exceeds_remaining: "One of the quantities is more than what's left to convert. Refresh and try again.",
    over_remaining: "One of the quantities is more than what's left to convert. Refresh and try again.",
    race_conflict: "Another operator just converted overlapping quantity. Refresh and try again.",
    nothing_to_invoice: "No billable lines came back for this Goods Receipt. Open it and check its invoiced balance before treating it as billed in full.",
    nothing_to_return: "No returnable lines came back for this Goods Receipt. Open it and check its returned balance before treating it as returned in full.",
    zero_cost_receipt: "Some lines would be received at zero cost, but those items have been bought at a real price before. Enter the unit price from the supplier's goods-received document, or open the Goods Receipt and tick \"Received free\" on the line.",
    grn_not_posted: "Only a posted Goods Receipt can be converted. Post it first.",
    grn_not_found: "That Goods Receipt no longer exists. Refresh and try again.",
    grn_id_required: "Select a Goods Receipt first.",
    warehouse_required: "These Purchase Orders don't share one receive-into warehouse. Fix the PO line warehouses, or receive them per warehouse on the desktop.",
    po_not_receivable: "One of the selected Purchase Orders is no longer open for receipt. Refresh and try again.",
    nothing_outstanding: "No outstanding lines came back for the selected Purchase Order(s). Open the order and check its received balance before treating it as received in full.",
    supplier_required: "The selected lines are missing a supplier. Refresh and try again.",
    items_required: "Select at least one line to receive.",
    do_item_not_found: "One of the lines no longer exists. Refresh and try again.",
    not_authenticated: "Your session expired. Please sign in again.",
    load_failed: "Couldn't load the source data. Please try again.",
    invalid_json: "Something went wrong preparing the request. Please try again.",
  };
  return map[msg] ?? msg;
}
