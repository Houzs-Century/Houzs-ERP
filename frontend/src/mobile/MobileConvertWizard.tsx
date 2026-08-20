import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateConvertShared } from "./sharedInvalidate";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { buildVariantSummary } from "../vendor/shared/variant-summary";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { fmtSen } from "../lib/scm";
import { formatDate } from "../lib/utils";
import { SearchScopeHint } from "../components/SearchScopeHint";
import { transferToLabel, transferFromLabel } from "../lib/convertScope";
import { outstandingEmptyReason, type OutstandingScope } from "../lib/outstandingEmptyReason";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileConvertWizard — mobile CREATE-by-CONVERT flow for the four downstream
 * documents that the desktop only ever creates by converting a source doc:
 *
 *   target "do"  → New Delivery Order  from a Sales Order   (line + qty picker)
 *   target "si"  → New Sales Invoice   from a Delivery Order (line + qty picker)
 *   target "grn" → New Goods Receipt   from PO(s)            (line + qty picker, DRAFT)
 *   target "po"  → New Purchase Order  from a Sales Order    (line + qty picker)
 *
 * A full-height, .hz-m-scoped flow with three steps:
 *   1. pick a SOURCE document (or, for GRN, one-or-more POs of ONE supplier)
 *   2. pick the convertible LINES + qty (GRN: received qty per line)
 *   3. create — POST the confirmed convert endpoint, then onCreated(newDocNo)
 *
 * Presentation ports the owner's mobile design classes VERBATIM (mobile.css):
 * the header is .hdr + .ey eyebrow; the source picker rows reuse the SO-list
 * idiom (.so-row / .so-row-head / .so-row-name / .so-grid / .so-k / .so-v /
 * .spill); the GRN supplier filters are .chip; the line/qty step uses .card
 * rows with the − qty + stepper; the GRN Delivery-Note/Notes use the .so-card /
 * .so-bd / .fld form idiom; and the create action is a sticky .actbar / .btn.
 *
 * Convertible lines come from the SAME per-line "remaining" GETs the desktop
 * pickers use (verified against backend/src/scm/routes):
 *   SO→DO  : GET /delivery-orders-mfg/deliverable-so-lines?docNos=<docNo>  (qty − delivered)
 *   SO→PO  : GET /mfg-purchase-orders/outstanding-so-items                 (qty − po_qty_picked
 *            + sofa MRP rollup — the OUTSTANDING axis; returns all, scoped by soDocNo)
 *   DO→SI  : GET /sales-invoices/invoiceable-do-lines?doIds=<id>           (remaining pool)
 *   GRN    : GET /grns/outstanding-po-items                                (qty − received_qty;
 *            returns all outstanding PO lines, scoped to the selected poIds)
 *
 * Create responses (the new doc number we hand to onCreated):
 *   DO  POST /delivery-orders-mfg/from-sos  { asDraft:true, picks } → { id, doNumber }
 *                    (DRAFT — NOT auto-shipped; operator confirms the DO and
 *                    that transition writes stock. No movementErrors on a draft:
 *                    the OUT has not run yet.)
 *   SI  POST /sales-invoices/from-dos        → { id, invoiceNumber, ... }
 *   GRN POST /grns  { asDraft:true, items }  → { id, grnNumber } (DRAFT — NOT auto-posted;
 *                    operator posts it from the receipt, PATCH /:id/post writes stock)
 *   PO  POST /mfg-purchase-orders/from-sos   → { created:[{ poNumber, ... }], total }
 *
 * Short-stock handling (DO): authedFetch already intercepts the 409 short_stock
 * body, shows the in-app "Ship anyway?" confirm (serviceConfirm), and replays
 * with confirmShortStock:true — so we simply call it and let that run.
 * ------------------------------------------------------------------------- */

export type ConvertTarget = "do" | "si" | "grn" | "po";

type SourceKind = "so" | "do" | "po";

/* Per-target wiring: which source list to pick from, the eyebrow/title copy,
   and whether the flow has a line-level qty picker.
   • hasLinePicker  — SO→DO/PO, DO→SI pick lines + qty.
   • no line picker — GRN receives every PO line (whole-PO convert).

   The screen title is the owner-approved "Transfer to <destination>", and both
   it and the sub-line come from `transferToLabel` / `transferFromLabel` in
   `lib/convertScope` rather than from literals here — desktop and mobile
   wording each other is exactly what the shared generator exists to stop
   (mobile used the full document name while desktop used the abbreviation, for
   the same operation). `docTitle` is the plain document name reused by the create button +
   error notify, and stays as-is: "Create Goods Receipt" is the English, while
   the TRANSFER label is "Goods Received" per the approved table. */
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

// ── Money / helpers ────────────────────────────────────────────────────────
// Money is integer *_sen → shared fmtSen() (includes the "RM " symbol).
// Dates via the shared TZ-aware numeric DD/MM/YYYY helper.
const dm = (d: string | null | undefined) => formatDate(d);
/** First defined-and-non-empty of the candidates (pg driver camelCases result
 *  columns; snake_case is the raw shape — always dual-read). */
const pick = (row: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};
const str = (v: unknown): string => (v == null ? "" : String(v));
/** The line's live variant summary — the SAME shared buildVariantSummary the
 *  desktop pickers render through VariantDescription, so a sofa module reads
 *  identically on the phone and on the desk ("BF-01 / SEAT 24 / LEG 6\"").
 *  Dual-reads itemGroup/item_group and variants/… through `pick` like every
 *  other field here. Returns '' when the line carries no variants. */
const variantLineOf = (row: unknown): string =>
  buildVariantSummary(
    str(pick(row, "itemGroup", "item_group")) || null,
    (pick(row, "variants") as Record<string, unknown> | undefined) ?? null,
  );
/** Clamp a typed qty to 1..max integer (guards NaN / out-of-range). */
const clampQty = (raw: string, max: number): number => {
  const n = Math.floor(Number(String(raw).replace(/[^\d.]/g, "")));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (max > 0 && n > max) return max;
  return n;
};

// ── Source-list row shapes (only the fields we read) ─────────────────────────
type SoListRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  so_date: string | null; local_total_sen: number | null; total_revenue_sen: number | null;
};
type DoListRow = {
  id: string; do_number: string; debtor_name: string | null; status: string | null;
  do_date: string | null; local_total_sen: number | null;
};
type PoListRow = {
  id: string; po_number: string; status: string | null; po_date: string | null;
  total_sen: number | null; supplier?: { id?: string; code?: string; name?: string } | null;
};

// ── Convertible-line shapes (from the remaining GETs) ────────────────────────
/* itemGroup + variants ride on ALL FOUR of these reads already — they are not a
   new request. Verified against the handlers, not against a payload type:
     · deliverable-so-lines  → soDeliverableRemaining, routes/delivery-orders-mfg.ts:2258 (itemGroup) / :2266 (variants)
     · invoiceable-do-lines  → doLineRemaining,        lib/do-line-remaining.ts:292 (itemGroup) / :303 (variants)
     · outstanding-so-items  → routes/mfg-purchase-orders.ts:694 (itemGroup) / :699 (variants)
     · outstanding-po-items  → lib/outstanding-po-lines.ts:418 (variants)
   The mobile wizard simply threw them away at the map. */
type SoDeliverableLine = {
  soItemId: string; docNo: string; itemCode: string; description: string | null;
  itemGroup: string | null; variants: unknown;
  qty: number; remaining: number; unitPriceSen: number; debtorName: string | null;
};
type DoInvoiceableLine = {
  doItemId: string; doNumber: string; itemCode: string; description: string | null;
  itemGroup: string | null; variants: unknown;
  remaining: number; unitPriceSen: number; debtorName: string | null;
};
// SO→PO — the OUTSTANDING axis (qty − po_qty_picked + sofa MRP rollup), from
// /mfg-purchase-orders/outstanding-so-items (the SAME stock-aware shortage view
// the desktop PurchaseOrderFromSo picker uses). `remainingQty` is the pooled
// shortage; the endpoint returns EVERY outstanding SO line, so we scope to the
// picked SO's doc_no client-side.
type OutstandingSoLine = {
  soItemId: string; soDocNo: string; itemCode: string; description: string | null;
  itemGroup: string | null; variants: unknown;
  qty: number; poQtyPicked: number; remainingQty: number; unitPriceSen: number;
};
// GRN — outstanding PO lines (qty − received_qty > 0) from
// /grns/outstanding-po-items (the SAME source as the desktop GrnFromPo picker).
// Carries the per-line fields the New-GRN create needs to build a DRAFT receipt.
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

// A GRN pick line in the local UI — the outstanding PO line + a per-line
// received qty (mirrors the desktop GrnFromPo Pick Qty). The whole-PO
// /grns/from-pos endpoint auto-POSTs (writes stock at once) with no per-line
// qty; this drives a per-line DRAFT create instead.
type GrnPickLine = {
  poItemId: string; poId: string; supplierId: string;
  itemCode: string; supplierSku: string | null; description: string | null; itemGroup: string | null;
  variants: unknown; unitPriceSen: number;
  origQty: number;       // ordered qty
  remaining: number;     // outstanding (qty − received_qty)
  checked: boolean;
  qty: string;           // received qty to book this pass (as typed)
};

// A picker line in the local UI (unified across the two GET shapes).
type PickLine = {
  lineId: string;        // soItemId | doItemId
  label: string;         // item code / description
  /* Owner rule 2026-08-19 — "只要有 variants 的，你就应该要显示 variants".
     A sofa model decomposes into modules that share a name, so `label` alone
     renders three identical-looking rows and the operator cannot tell which one
     he is converting. This is the SAME live buildVariantSummary string the
     desktop pickers render through VariantDescription — computed at map time so
     the row render stays pure. Empty ('') on a line with no variants, and the
     row then omits the line entirely (mobile convention, see
     MobileModuleDetail.tsx:491 — no "Standard" filler on a phone). */
  variantLine: string;
  origQty: number;       // the source line's ordered qty (0 when the GET omits it)
  remaining: number;     // outstanding qty still convertible
  unitPriceSen: number;
  checked: boolean;
  qty: string;           // as typed (the qty to convert this pass)
};

export function MobileConvertWizard({
  target,
  onBack,
  onCreated,
  initialSourceId,
}: {
  target: ConvertTarget;
  onBack: () => void;
  onCreated: (docNo: string) => void;
  /* Pre-seed the source document (single-source targets only: SO→DO / SO→PO /
     DO→SI). When set, the wizard opens straight on the line/qty step for that
     document — mirrors the desktop's per-row "Issue Delivery Order" action,
     which lands on the prefilled convert screen for that specific SO. */
  initialSourceId?: string | null;
}) {
  const meta = META[target];
  const qc = useQueryClient();
  const notify = useNotify();
  /* One key for the one convert this wizard is open to run (lib/idempotency.ts).
     This is the MOBILE half of the same fix the desktop *New pages carry — a
     document protected on one side only is a new divergence, and this wizard is
     the ONLY mobile create surface for DO / SI / GRN / PO. It posts through a
     bare authedFetch rather than the vendored hooks, which is exactly why the
     desktop-side hook fix does not reach it.

     MobileApp mounts this behind `screen.t === "convert"` and both onBack and
     onCreated switch screens (MobileApp.tsx:436-444), so the MOUNT is exactly
     one convert run: minted once by useState's lazy init (stable across every
     re-render), the same on a re-press after a stalled 4G submit — the phone in
     a customer's driveway is the whole reason this exists — and gone on remount,
     so the next convert is a new key. `target` is fixed for the life of a mount,
     so one mount performs exactly one POST to one pathname.

     ALL FOUR branches share this key, INCLUDING the po branch that raises N
     POs, and that is deliberate rather than an oversight of the SoFromProducts
     rule. The rule is about N REQUESTS, not N documents: SoFromProducts loops
     `await createSo.mutateAsync(...)` per spec, so one key across that loop
     makes orders 2..N replay order 1 and silently collapse into one. Here the
     N POs are raised INSIDE ONE request — /mfg-purchase-orders/from-sos groups
     the picks server-side and answers `{ created: [...], total }` — so the
     middleware's claim covers the whole batch and a replay returns all N
     poNumbers verbatim. One request, one claim, one response: nothing to
     collapse. Same for the grn branch, where the N selected POs' lines are
     received into ONE DRAFT GRN via a single POST /grns — one request, one
     grnNumber, so a replay returns that same grnNumber verbatim. */
  const idemKey = useIdempotencyKey();

  // step 1 → source picked ; step 2 → lines/qty (or GRN supplier confirm) ; step 3 handled by submit.
  // A single-source target (SO→DO/PO, DO→SI) seeds selectedSourceId from
  // initialSourceId; only the multi-PO GRN flow (source "po") starts empty and
  // builds selectedPoIds.
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    meta.source !== "po" ? (initialSourceId ?? null) : null,
  ); // doc_no (SO) or id (DO / GRN)
  // GRN-from-POs: multi-PO of one supplier.
  const [selectedPoIds, setSelectedPoIds] = useState<string[]>([]);
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null); // supplier id, GRN-from-POs only
  const [lines, setLines] = useState<PickLine[]>([]);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deliveryNoteRef, setDeliveryNoteRef] = useState(""); // GRN optional
  const [notes, setNotes] = useState(""); // GRN optional

  const step: 1 | 2 = meta.source === "po"
    ? (selectedPoIds.length > 0 ? 2 : 1)
    : (selectedSourceId ? 2 : 1);

  // ── Source list query ──────────────────────────────────────────────────────
  const sourceQuery = useQuery<any>({
    queryKey: ["convert-source", meta.source],
    queryFn: () => {
      if (meta.source === "so") return authedFetch<{ salesOrders?: SoListRow[] }>("/mfg-sales-orders?limit=200");
      if (meta.source === "do") return authedFetch<{ deliveryOrders?: DoListRow[] }>("/delivery-orders-mfg?limit=200");
      return authedFetch<{ purchaseOrders?: PoListRow[] }>("/mfg-purchase-orders?limit=200");
    },
    staleTime: 30_000,
  });

  // Only offer processible sources (not DRAFT / CANCELLED). GRN drops fully
  // received / cancelled POs (only open / partially_received can be received).
  const sources = useMemo(() => {
    const data = sourceQuery.data as any;
    const isProcessible = (status: string | null) => {
      const s = str(status).toUpperCase();
      return s !== "DRAFT" && s !== "CANCELLED";
    };
    const isReceivablePo = (status: string | null) => {
      const s = str(status).toUpperCase();
      return s !== "DRAFT" && s !== "CANCELLED" && s !== "RECEIVED" && s !== "CLOSED";
    };
    const needle = q.trim().toLowerCase();
    if (meta.source === "so") {
      return ((data?.salesOrders ?? []) as SoListRow[])
        .filter((r) => isProcessible(r.status))
        .filter((r) => !needle || `${str(r.debtor_name)} ${r.doc_no}`.toLowerCase().includes(needle));
    }
    if (meta.source === "do") {
      return ((data?.deliveryOrders ?? []) as DoListRow[])
        .filter((r) => isProcessible(r.status))
        .filter((r) => !needle || `${str(r.debtor_name)} ${r.do_number}`.toLowerCase().includes(needle));
    }
    // PO (GRN): filter to one supplier at a time so /grns/from-pos never 400s
    // on mixed_suppliers. Once a supplier is chosen, show only that supplier.
    return ((data?.purchaseOrders ?? []) as PoListRow[])
      .filter((r) => isReceivablePo(r.status))
      .filter((r) => !supplierFilter || str(r.supplier?.id) === supplierFilter)
      .filter((r) => !needle || `${str(r.supplier?.name)} ${r.po_number}`.toLowerCase().includes(needle));
  }, [sourceQuery.data, meta.source, q, supplierFilter]);

  // Distinct suppliers for the GRN supplier chips (from receivable POs).
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

  // ── Convertible-lines query (SO→DO/PO, DO→SI). GRN-from-POs has no line
  //    picker. ──────────────────────────────────────────────────────────────
  const linesQuery = useQuery({
    enabled: meta.hasLinePicker && !!selectedSourceId,
    queryKey: ["convert-lines", target, selectedSourceId],
    queryFn: async () => {
      if (target === "po") {
        // SO→PO reads the OUTSTANDING axis (qty − po_qty_picked + sofa MRP
        // rollup), NOT the deliverable axis (qty − delivered). The deliverable
        // axis is wrong for a PO: a fully-PO'd-but-undelivered line would 409
        // dead on submit, a delivered-but-unpurchased restock PO could never be
        // raised, and sofa qty (MRP-pooled) would be off. Mirrors the desktop
        // PurchaseOrderFromSo picker (useOutstandingSoItems). The endpoint
        // returns EVERY outstanding SO line, so scope to the picked SO's doc_no.
        const res = await authedFetch<{ items?: OutstandingSoLine[] }>(
          `/mfg-purchase-orders/outstanding-so-items`,
        );
        return (res.items ?? [])
          .filter((l) => str(l.soDocNo) === str(selectedSourceId))
          .map<PickLine>((l) => ({
            lineId: l.soItemId,
            label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
            variantLine: variantLineOf(l),
            origQty: Number(l.qty) || 0,
            remaining: Number(l.remainingQty) || 0,
            unitPriceSen: Number(l.unitPriceSen) || 0,
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
          origQty: Number(l.qty) || 0,
          remaining: Number(l.remaining) || 0,
          unitPriceSen: Number(l.unitPriceSen) || 0,
          checked: true,
          qty: String(Number(l.remaining) || 0),
        }));
      }
      // DO source (id): SI invoices the remaining pool. The invoiceable-do-lines
      // GET returns only `remaining` (no original qty), so origQty falls back to
      // remaining — the "of {qty}" hint then simply shows the outstanding pool.
      const res = await authedFetch<{ lines?: DoInvoiceableLine[] }>(
        `/sales-invoices/invoiceable-do-lines?doIds=${encodeURIComponent(selectedSourceId!)}`,
      );
      return (res.lines ?? []).map<PickLine>((l) => ({
        lineId: l.doItemId,
        label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
        variantLine: variantLineOf(l),
        origQty: Number(l.remaining) || 0,
        remaining: Number(l.remaining) || 0,
        unitPriceSen: Number(l.unitPriceSen) || 0,
        checked: true,
        qty: String(Number(l.remaining) || 0),
      }));
    },
    staleTime: 15_000,
  });

  // Seed local editable lines when the query resolves (default qty = remaining).
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
    () => picks.reduce((a, l) => a + l.unitPriceSen * clampQty(l.qty, l.remaining), 0),
    [picks],
  );

  // ── GRN line picker (the from-POs flow) ─────────────────────────────────────
  // The whole-PO /grns/from-pos endpoint AUTO-POSTs (writes stock at once) with
  // no per-line qty and no pre-post review. Instead we fetch the outstanding PO
  // lines (same source as the desktop GrnFromPo picker), let the operator set a
  // per-line received qty, and create a DRAFT via POST /grns (no auto-post) so
  // it can be reviewed + posted from the receipt — and partially received.
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
      /* `scope` is carried, not discarded. It is the WHY behind an empty list, and
         mobile had the SAME defect the desktop screen was fixed for: it answered
         "Nothing left to receive on the selected order(s)" — a claim about the
         orders — from an absence of rows. One shared module now words both. */
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
  /* The sentence for an empty list, from the same module the desktop picker uses.
     There is no toolbar and no unsaved draft on this screen, and the JS narrowing
     below is the same `?poId=` set the server already applied — so `scopedRowCount`
     is the server count and `filtersActive` is false. Saying that here, rather
     than passing a convenient boolean, is what keeps the two surfaces honest. */
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

  // ── Submit (step 3) ─────────────────────────────────────────────────────────
  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      let newDocNo = "";

      if (target === "do") {
        /* asDraft:true — the DO is PARKED, not shipped. `from-sos` reads
           `status: (body.asDraft === true) ? 'DRAFT' : 'DISPATCHED'`, and the
           same flag gates the write half (deductInventoryForDo +
           syncSoDeliveredFromDo + the customer email). OMITTING the field is
           not a neutral default, it is "ship it now" — a tap in a driveway
           emptied the shelf, advanced the SO to delivered and emailed the
           customer, with no review step and no undo.

           Same reasoning as the GRN arm below, and the same shape: the phone
           creates the document, a human confirms it from the receipt. For a DO
           that confirm is the Confirm transition (PATCH /:id/status), which is
           the single stock-writing chokepoint. */
        const body = { asDraft: true, picks: picks.map((l) => ({ soItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        /* The short-stock pre-flight runs REGARDLESS of asDraft (it also
           resolves the incoming-PO commitments), so the "Ship anyway?" confirm
           below still fires on a draft — it is the binding decision, taken once,
           at the moment the operator picked the lines. */
        // authedFetch handles the short_stock 409 in-app (Ship anyway? → replay).
        /* The short_stock 409 replay authedFetch runs internally re-sends this
           SAME key with confirmShortStock:true — correct and load-bearing. The
           route explicitly marks this pre-write guard as Idempotency-Outcome:
           no-write, so middleware releases only that proven-safe claim and the
           confirmed retry runs for real. Other non-2xx outcomes stay protected. */
        const res = await authedFetch<{ doNumber?: string }>("/delivery-orders-mfg/from-sos",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        newDocNo = str(res?.doNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else if (target === "si") {
        const body = { picks: picks.map((l) => ({ doItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        const res = await authedFetch<{ invoiceNumber?: string }>("/sales-invoices/from-dos",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        newDocNo = str(res?.invoiceNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else if (target === "po") {
        const body = { picks: picks.map((l) => ({ soItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        /* N POs from ONE request — safe under one key; see the mint above. */
        const res = await authedFetch<{ created?: Array<{ poNumber?: string }> }>("/mfg-purchase-orders/from-sos",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        const created = res?.created ?? [];
        newDocNo = created.map((p) => str(p.poNumber)).filter(Boolean).join(", ");
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else {
        // GRN — create a DRAFT with per-line received qty (NO auto-post). The
        // whole-PO /grns/from-pos endpoint always lands POSTED (grns.ts:1600-1601)
        // and receives every line in full (grns.ts:1609), so partial receipt is
        // impossible and "adjust later" means reversing an already-posted GRN.
        // Instead we post the generic /grns create with asDraft:true + explicit
        // per-line items — exactly how the desktop GrnFromPo picker feeds the New
        // GRN form (GrnFromPo.tsx:376-398,464-465 → GrnNew's asDraft path). The
        // operator reviews the draft and posts it from the receipt (that PATCH
        // /:id/post is the single stock-writing chokepoint). Header supplier/PO
        // come off the first picked line (mirror GrnNew's hasPicks derivation);
        // warehouseId is omitted so the server resolves it from the PO lines —
        // identical to the old from-pos behaviour (rejects a mixed-warehouse
        // batch rather than silently defaulting into China/transit).
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
        const res = await authedFetch<{ grnNumber?: string }>("/grns",
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify(body),
          }));
        newDocNo = str(res?.grnNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      }

      // Also refresh the shared/desktop doc lists (source + target) so a desktop
      // tab doesn't read a stale picker/list after a mobile convert.
      invalidateConvertShared(qc);
      onCreated(newDocNo);
    } catch (e) {
      // A declined short-stock / drop-ship confirm surfaces as a thrown marker;
      // treat any non-success as a plain in-app error (never a naked alert).
      const msg = e instanceof Error ? e.message : "Couldn't create the document.";
      if (!/^declined_/.test(msg)) {
        await notify({ title: `Couldn't create ${meta.docTitle}`, body: humanize(msg), tone: "error" });
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Can we submit? DO/SI/PO need >=1 line pick; GRN needs >=1 line with qty >=1.
  const canCreate = meta.hasLinePicker ? picks.length > 0 : grnPicks.length > 0;

  // Spec #convert sub-line: "From {{source_doc_no}}" once a source is chosen.
  // Single-source → the picked SO doc_no / DO number; GRN → "N Purchase Orders".
  const sourceLabel = useMemo(() => {
    if (meta.source === "po") {
      return selectedPoIds.length
        ? `${selectedPoIds.length} Purchase Order${selectedPoIds.length === 1 ? "" : "s"}`
        : "";
    }
    if (!selectedSourceId) return "";
    if (meta.source === "so") return selectedSourceId; // doc_no is the id
    const row = ((sourceQuery.data as any)?.deliveryOrders ?? []).find(
      (r: DoListRow) => str(r.id) === selectedSourceId,
    ) as DoListRow | undefined;
    return row ? str(row.do_number) : "";
  }, [meta.source, selectedPoIds, selectedSourceId, sourceQuery.data]);

  // Spec step labels: 1 = pick source, 2 = pick lines (GRN sets received qty).
  const stepLabel = step === 1
    ? "Select source"
    : meta.hasLinePicker ? "Select lines to convert" : "Set received quantities";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* Spec #convert: back "Cancel" chevron, eyebrow, screen-title, source-doc
          sub-line, then the 2-segment step-progress bar + "Step N of 2" label. */}
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> Cancel
          </button>
          <span style={{ fontSize: 11, color: "#767b6e" }}>Step {step} of 2 · {stepLabel}</span>
        </div>
        <div className="ey" style={{ color: "#a16a2e", marginTop: 6 }}>{meta.eyebrow}</div>
        <div className="scr-title" style={{ marginTop: 2 }}>{meta.transferTitle}</div>
        <div className="tnum" style={{ fontSize: 11.5, color: "#767b6e", marginTop: 3 }}>
          {/* Spec sub-line: "From {{source_doc_no}}" once a source is chosen;
              before that, the invitation to pick one. The invitation is SINGULAR
              even where the picker takes several sources — it names the source
              document TYPE, not the count (owner rule, 2026-08-17). */}
          {sourceLabel ? `From ${sourceLabel}` : meta.fromTitle}
        </div>
        {/* Step-progress bar (spec markup): filled brand segments up to the current step. */}
        <div style={{ display: "flex", gap: 5, marginTop: 11 }}>
          {[1, 2].map((s) => (
            <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: s <= step ? "var(--brand)" : "var(--line-card)" }} />
          ))}
        </div>
        {/* Search (source step only) */}
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
        {/* GRN supplier chips (source step only) */}
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
              // First PO pins the supplier filter (enforces one-supplier GRN).
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

      {/* Sticky footer — only shown on step 2 (the create action). */}
      {step === 2 && (
        <footer className="actbar">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
            {meta.hasLinePicker ? (
              <>
                <span style={{ fontSize: 11.5, color: "#767b6e" }}>{picks.length} {picks.length === 1 ? "line" : "lines"}</span>
                <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "#0c3f39" }}>{fmtSen(pickedTotalSen)}</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 11.5, color: "#767b6e" }}>{grnPicks.length} {grnPicks.length === 1 ? "line" : "lines"}</span>
                <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "#0c3f39" }}>{fmtSen(grnPickedTotalSen)}</span>
              </>
            )}
          </div>
          <button
            className="btn"
            disabled={!canCreate || submitting}
            onClick={submit}
            style={{ opacity: !canCreate || submitting ? 0.55 : 1 }}
          >
            {/* The two targets that land a DRAFT say so on the button. A CTA
                that promises a Delivery Order while creating a parked one is
                the same lie in the other direction — the operator needs to know
                a confirm step is still owed before the goods are counted out. */}
            {submitting ? "Creating…" : (target === "grn" || target === "do")
              ? `Create draft ${meta.docTitle}`
              : `Create ${meta.docTitle}`}
          </button>
        </footer>
      )}
    </div>
  );
}

// ── Step 1: source picker ────────────────────────────────────────────────────
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
          <div style={{ fontSize: 11, color: "#a16a2e", padding: "0 2px" }}>
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
                <span className="spill" style={{ background: on ? "#e1efed" : "#f4f6f3", color: on ? "#0c3f39" : "#767b6e", border: on ? "none" : "1px solid #e3e6e0", flex: "none" }}>
                  {on ? "Selected" : str(r.status) || "—"}
                </span>
              </div>
              <div className="so-grid">
                <span className="so-k">Order</span>
                <span className="so-v money" style={{ fontWeight: 700, color: "#0c3f39" }}>{str(r.po_number) || "—"}</span>
                <span className="so-k">Date</span>
                <span className="so-v">{dm(r.po_date)}</span>
                <span className="so-k">Total</span>
                <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "#11140f" }}>{fmtSen(r.total_sen)}</span>
              </div>
              {on && <Check />}
            </div>
          );
        })}
      </div>
    );
  }

  // SO / DO — single-source tap.
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
                <span className="spill" style={{ background: "#f4f6f3", color: "#767b6e", border: "1px solid #e3e6e0", flex: "none" }}>{str(r.status)}</span>
              )}
            </div>
            <div className="so-grid">
              <span className="so-k">{kind === "so" ? "Order" : "Delivery"}</span>
              <span className="so-v money" style={{ fontWeight: 700, color: "#0c3f39" }}>{docNo || "—"}</span>
              <span className="so-k">Date</span>
              <span className="so-v">{dm(date)}</span>
              <span className="so-k">Total</span>
              <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "#11140f" }}>{fmtSen(totalC)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 2 (line picker): SO→DO/PO, DO→SI ────────────────────────────────────
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
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.label}</span>
                  {/* Owner rule 2026-08-19 — the variant summary, so three sofa
                      modules under one model name are three DIFFERENT rows on
                      the phone too. Wraps (no ellipsis): a truncated
                      "BF-01 / SEAT 24 / LEG …" is the same ambiguity again. */}
                  {l.variantLine && (
                    <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "#767b6e" }}>{l.variantLine}</span>
                  )}
                  {/* Spec #convert meta: "Outstanding ×{outstanding} of {qty}". */}
                  <span className="tnum" style={{ display: "block", marginTop: 3, fontSize: 11, color: "#767b6e" }}>
                    Outstanding ×{l.remaining} of {ofQty} · {fmtSen(l.unitPriceSen)} each
                  </span>
                </span>
              </label>
              {l.checked && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 9, paddingTop: 9, borderTop: "1px solid #eceee9" }}>
                  {/* Spec stepper: − {convert_qty} + , clamped 1..remaining. */}
                  <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid #d6d9d2", borderRadius: 8 }}>
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={dec}
                      disabled={qtyNum <= 1}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum <= 1 ? "#c2c6bd" : "#16695f", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum <= 1 ? "default" : "pointer" }}
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
                      style={{ width: 40, height: 30, textAlign: "center", border: "none", borderLeft: "1px solid #eceee9", borderRight: "1px solid #eceee9", background: "none", outline: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 700, color: "#11140f" }}
                    />
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={inc}
                      disabled={qtyNum >= l.remaining}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum >= l.remaining ? "#c2c6bd" : "#16695f", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum >= l.remaining ? "default" : "pointer" }}
                    >
                      +
                    </button>
                  </div>
                  <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: "#0c3f39" }}>{fmtSen(l.unitPriceSen * qtyNum)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Step 2 (GRN): per-line received-qty picker + a reviewable DRAFT ──────────
// The old flow had NO line picker and posted the whole PO to /grns/from-pos,
// which auto-POSTs (writes stock at once) and receives every line in full. This
// lets the operator set a received qty per line (default = outstanding) and
// creates a DRAFT — nothing moves stock until they post the receipt. Mirrors the
// desktop GrnFromPo Pick-Qty picker (GrnFromPo.tsx:376-398) + the New-GRN form.
function GrnLinesStep({
  loading, error, lines, emptyReason, deliveryNoteRef, notes, onSetLine, onRef, onNotes, onChangeSource,
}: {
  loading: boolean;
  error: boolean;
  lines: GrnPickLine[];
  /** Why the list is empty, from `lib/outstandingEmptyReason` — the same module
   *  the desktop picker uses. Null only when there is nothing to explain. */
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
    /* "Nothing left to receive on the selected order(s)" used to be hard-coded
       here — a completion claim made from an absence of rows, on a read that is
       company-scoped and FAILS CLOSED. The shared module only says the work is
       finished when the server counted the order's lines and found none
       outstanding; every other absence gets its own true sentence. */
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
      <div style={{ fontSize: 11, color: "#a16a2e", padding: "0 2px 10px" }}>
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
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.description || l.itemCode}</span>
                  {/* Owner rule 2026-08-19 — RECEIVING is where getting the
                      module wrong costs the most: the stock lands under a code
                      whose variants nobody checked. GrnPickLine already carried
                      itemGroup + variants (they are needed to CREATE the GRN
                      line); only the render was missing them. */}
                  {variantLine && (
                    <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "#767b6e" }}>{variantLine}</span>
                  )}
                  {l.supplierSku && (
                    <span style={{ display: "block", marginTop: 2, fontSize: 11, fontWeight: 600, color: "#767b6e", fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      Supplier SKU: {l.supplierSku}
                    </span>
                  )}
                  <span className="tnum" style={{ display: "block", marginTop: 3, fontSize: 11, color: "#767b6e" }}>
                    Outstanding ×{l.remaining} of {ofQty} · {fmtSen(l.unitPriceSen)} each
                  </span>
                </span>
              </label>
              {l.checked && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 9, paddingTop: 9, borderTop: "1px solid #eceee9" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid #d6d9d2", borderRadius: 8 }}>
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={dec}
                      disabled={qtyNum <= 1}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum <= 1 ? "#c2c6bd" : "#16695f", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum <= 1 ? "default" : "pointer" }}
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
                      style={{ width: 40, height: 30, textAlign: "center", border: "none", borderLeft: "1px solid #eceee9", borderRight: "1px solid #eceee9", background: "none", outline: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 700, color: "#11140f" }}
                    />
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={inc}
                      disabled={qtyNum >= l.remaining}
                      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: qtyNum >= l.remaining ? "#c2c6bd" : "#16695f", background: "none", border: "none", fontFamily: "inherit", fontSize: 17, cursor: qtyNum >= l.remaining ? "default" : "pointer" }}
                    >
                      +
                    </button>
                  </div>
                  <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: "#0c3f39" }}>{fmtSen(l.unitPriceSen * qtyNum)}</span>
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

// ── Small shared UI ──────────────────────────────────────────────────────────
function Muted({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return <div style={{ textAlign: "center", color: danger ? "#b23a3a" : "#9aa093", fontSize: 12, padding: "26px 0" }}>{children}</div>;
}
function ChangeSource({ onClick, label = "Change source" }: { onClick: () => void; label?: string }) {
  return (
    <span
      onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, marginBottom: 11, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}
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

/** Turn a raw error code / server reason into plain English for the notify. */
function humanize(msg: string): string {
  const map: Record<string, string> = {
    picks_required: "Select at least one line to convert.",
    mixed_customers: "All picked lines must belong to the same customer.",
    mixed_suppliers: "All selected Purchase Orders must be from the same supplier.",
    missing_bindings: "One or more products have no supplier assigned yet. Bind a supplier to them (on the desktop Products screen) before raising a Purchase Order.",
    qty_exceeds_remaining: "One of the quantities is more than what's left to convert. Refresh and try again.",
    over_remaining: "One of the quantities is more than what's left to convert. Refresh and try again.",
    race_conflict: "Another operator just converted overlapping quantity. Refresh and try again.",
    /* These three mirror the server's refusal messages, and they carried the
       same claim it did: a 400 raised because a READ came back empty is not
       evidence that the document is finished. Kept in step with grns.ts /
       purchase-invoices.ts / purchase-returns.ts — if they drift, the same
       document says two different things on two screens. */
    nothing_to_invoice: "No billable lines came back for this Goods Receipt. Open it and check its invoiced balance before treating it as billed in full.",
    nothing_to_return: "No returnable lines came back for this Goods Receipt. Open it and check its returned balance before treating it as returned in full.",
    /* migration 0280 — the zero-cost receipt gate. The per-line "Received free"
       tick lives on the desktop receipt screen, so this says where to go rather
       than leaving the operator at a code they cannot act on. */
    zero_cost_receipt: "Some lines would be received at zero cost, but those items have been bought at a real price before. Enter the unit price from the supplier's goods-received document, or open the receipt on desktop and tick \"Received free\" on the line.",
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
