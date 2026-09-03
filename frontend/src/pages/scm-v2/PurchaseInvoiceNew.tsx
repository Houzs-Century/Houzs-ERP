// ----------------------------------------------------------------------------
// PurchaseInvoiceNew — full-page Create Purchase Invoice at
// /purchase-invoices/new (PR — Phase 3 of Purchasing rebuild,
// Commander 2026-05-26).
//
// Two ways in (Commander 2026-05-29 — PI must have its OWN create form like
// New PO / New GRN, not be forced through a GRN):
//
//   1. From a posted GRN detail page, commander clicks "Generate Invoice" and
//      lands here with ?grnId={uuid} pre-loaded. The page shows the GRN header
//      (supplier + dates as read-only context) and the GRN accepted items as
//      PI lines (editable price). This path is unchanged.
//   2. MANUAL — no grnId at all: pick a supplier, search products, add line
//      items by hand (mirrors GrnNew's manual mode, including the per-category
//      bedframe/sofa variant editor with auto-computed Total Height). Saves
//      with grnId:null + each line carrying its own item_group + variants.
//
// PR-DRAFT-removal (2026-05-27, migration 0078): POST /purchase-invoices
// now creates the PI as POSTED directly. PI does NOT touch inventory
// (already done at GRN time per AutoCount standard) — it just establishes
// the AP liability for paying the supplier.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/PurchaseInvoiceNew.tsx.
// Import boundary only: react-router → react-router-dom; PI create/post hooks →
// vendored purchase-invoice-queries; the GRN detail hook → vendored grn-queries;
// suppliers/mfg-products/category-badges/dates → ../../vendor/scm/*; nav
// repointed to /scm/purchase-invoices (and /scm/grns for the GRN backlink).
// ----------------------------------------------------------------------------

import { transferFromLabel } from '../../lib/convertScope';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Trash2, X, ChevronDown, ArrowRightLeft } from 'lucide-react';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { activeOptions, buildVariantSummary, isServiceLine, maintPickerValues } from '@2990s/shared';
import {
  useCreatePurchaseInvoice,
  usePostPurchaseInvoice,
  usePurchaseInvoiceDetail,
} from '../../vendor/scm/lib/purchase-invoice-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { useGrnDetail, useGrnDetails } from '../../vendor/scm/lib/grn-queries';
import { useActiveCurrencies, rateFor } from '../../vendor/scm/lib/currencies-queries';
import { CurrencySelect } from '../../vendor/scm/components/CurrencySelect';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import styles from './SalesOrderDetail.module.css';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { notifyAcNotSent } from '../../vendor/scm/lib/ac-not-sent';
import { PageHeader } from '../../components/Layout';
import { resolveFxRate } from './fx-rate';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON    = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* Commander 2026-05-29 — manual PI lines whose product is a bedframe/sofa get
   the SAME per-category variant editor as New GRN / New PO. Small local copy of
   GrnNew's VariantSelect (not exported there). */
const VariantSelect = ({
  label, options, value, onChange,
}: {
  label: string;
  options: Array<{ value: string; priceSen: number }>;
  value: string;
  onChange: (v: string) => void;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <span className={styles.selectWrap}>
      <select className={styles.fieldSelect} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value}{o.priceSen > 0 ? ` (+${fmtRm(o.priceSen)})` : ''}
          </option>
        ))}
      </select>
      <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
    </span>
  </label>
);

type DraftLine = {
  rid:            string;
  grnItemId:      string | null;
  materialKind:   string;
  itemCode:   string;
  materialName:   string;
  /* Commander 2026-05-29 — PI lines must show the same content as PO/GRN
     ("PO 有什么内容，Purchase Invoice 也应该随之对应"). GRN-sourced lines carry
     the GRN line's category + variants; manual lines pick them below. */
  itemGroup:      string | null;
  variants:       Record<string, unknown> | null;
  qty:            number;
  unitPriceSen: number;
  notes:          string;
};

export const PurchaseInvoiceNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [params] = useSearchParams();
  const grnId    = params.get('grnId');
  // fromPicks = arrived from the GRN→PI review picker: build ONLY the ticked
  // lines (with the ticked qty), not every accepted line on the GRN.
  const fromPicks = params.get('fromPicks') === '1';
  const grnQ     = useGrnDetail(grnId);
  /* Multi-note invoice (owner 2026-08-06) — the picker passes every note the
     picks span in ?grnIds=; grnId stays the PRIMARY (header context: supplier,
     currency, PO ref). Load the EXTRA notes too, or their picked lines would be
     silently dropped when the draft is built below. Empty on the single-note
     path, so nothing extra is fetched. */
  const extraGrnIds = useMemo(() => {
    const raw = params.get('grnIds');
    if (!raw) return [] as string[];
    return raw.split(',').map((s) => s.trim()).filter((s) => s && s !== grnId);
  }, [params, grnId]);
  const extraGrnQs = useGrnDetails(extraGrnIds);

  // Manual mode = no ?grnId= in the URL (Commander 2026-05-29 — blank PI).
  const isManual = !grnId;

  /* One key for the one PI this page is open to raise (lib/idempotency.ts).
     Same create-then-post-then-dialog shape as GrnNew (which carries the full
     reasoning): the submit is TWO calls and a POST failure reports "Save failed"
     while the PI already exists, so the re-press that copy invites must REPLAY
     rather than book the supplier's bill a second time. */
  const idemKey = useIdempotencyKey();
  const create = useCreatePurchaseInvoice();
  const post   = usePostPurchaseInvoice();
  const saving = create.isPending || post.isPending;

  // Manual-mode supplier (mirrors GrnNew).
  const [manualSupplierId, setManualSupplierId] = useState<string>('');
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  // Maintenance config drives the per-category variant editor on MANUAL
  // bedframe/sofa lines (same dropdown pools as New GRN / New PO).
  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;

  // Special Orders pool from special_addons (Backend↔POS parity, Loo
  // 2026-06-08), filtered by category — replaces legacy maint.specials /
  // maint.sofaSpecials. `code` shares the old value namespace.
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    // FULL rows feed the shared SpecialOrders block (owner 2026-07-20 unify).
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  const [supplierInvoiceRef, setSupplierInvoiceRef] = useState<string>('');
  const [invoiceDate, setInvoiceDate] = useState<string>(() => todayMyt());
  const [dueDate, setDueDate]         = useState<string>('');
  /* Commander 2026-05-29 — "Bill date 都是 standard 的，放 30 天之内，根据这个
     supplier 的设定": Due Date auto-defaults to Invoice Date + the supplier's
     payment-term days. Track whether the operator has hand-edited Due Date so
     the auto-default stops overwriting their value. */
  const [dueTouched, setDueTouched]   = useState<boolean>(false);
  const [notes, setNotes]             = useState<string>('');
  /* Multi-currency AP (Phase 1-A) — MYR per 1 unit of the PI currency, kept as a
     string. Shown only for a foreign-currency PI; MYR posts 1:1 (no-op). */
  const [exchangeRate, setExchangeRate] = useState<string>('1');
  /* Track a manual rate edit so the currency-master auto-fill stops overwriting it. */
  const [rateTouched, setRateTouched] = useState<boolean>(false);
  /* Multi-currency AP (Phase 1-A) — the operator-chosen currency; defaults to the
     resolved supplier's currency (below). A foreign currency reveals the rate. */
  const [currencyOverride, setCurrencyOverride] = useState<string | null>(null);
  /* PI-level freight allocation (Phase 1-A) — how a freight SERVICE line's charge
     is spread across the goods lines into their landed cost: QTY | VALUE | CBM.
     Mirrors GrnNew's "Charge allocation"; the server does the authoritative split. */
  const [allocationMethod, setAllocationMethod] = useState<'QTY' | 'VALUE' | 'CBM'>('QTY');
  const [lines, setLines]             = useState<DraftLine[]>([]);
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  // ── GRN-sourced lines (only when ?grnId= present). ──────────────────────
  /* Every loaded note's lines, primary first (multi-note invoices). Waits for
     the extra notes so a partially-loaded set never builds a short draft. */
  const extraReady = extraGrnQs.every((q) => q.data || q.isError);
  const sourceItems = useMemo(() => {
    if (!grnQ.data) return null;
    if (!extraReady) return null;
    return [
      ...(grnQ.data.items ?? []),
      ...extraGrnQs.flatMap((q) => (q.data?.items ?? [])),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grnQ.data, extraReady, extraGrnQs.map((q) => q.data).join('|')]);

  useEffect(() => {
    if (!sourceItems) return;
    // In picker mode, only the ticked GRN lines come through — keyed by GRN
    // line id → ticked qty. Outside picker mode, prefill every accepted line.
    let pickQtyById: Map<string, number> | null = null;
    if (fromPicks) {
      const picks = readScmHandoff<Array<{ grnItemId: string; qty: number }>>('piFromGrnPicks');
      if (picks) pickQtyById = new Map(picks.map((p) => [p.grnItemId, Number(p.qty ?? 0)]));
      removeScmHandoff('piFromGrnPicks');
    }
    const next: DraftLine[] = (sourceItems)
      // Remaining-to-bill = accepted − already-invoiced − returned-to-supplier.
      // Outside picker mode, prefill only lines that still have something left
      // to bill (so a part-billed note doesn't re-show settled lines).
      .map((it: any) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.invoiced_qty ?? 0) - (it.returned_qty ?? 0) }))
      .filter((it: any) => (pickQtyById ? pickQtyById.has(it.id) : it._remaining > 0))
      .map((it: any) => ({
        rid:            `r${it.id}`,
        grnItemId:      it.id,
        materialKind:   it.material_kind,
        itemCode:   it.item_code,
        materialName:   it.material_name,
        // Carried from the GRN line (grns.ts ITEM select returns these) so the
        // PI shows the same variant summary as the GRN it descends from.
        itemGroup:      it.item_group ?? null,
        variants:       (it.variants as Record<string, unknown> | null) ?? null,
        qty:            pickQtyById ? (pickQtyById.get(it.id) ?? it._remaining) : it._remaining,
        unitPriceSen: it.unit_price_sen ?? 0,
        notes:          '',
      }));
    setLines(next);
  }, [sourceItems, fromPicks]);

  // Manual mode — seed ONE blank starter line so a LINE 1 card shows
  // immediately (matches New PO). Only when empty (never clobbers).
  useEffect(() => {
    if (!isManual) return;
    setLines((prev) => prev.length > 0 ? prev : [{
      rid:            `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      grnItemId:      null,
      materialKind:   'mfg_product',
      itemCode:   '',
      materialName:   '',
      itemGroup:      null,
      variants:       null,
      qty:            1,
      unitPriceSen: 0,
      notes:          '',
    }]);
  }, [isManual]);

  /* ── Copy as new (the owner, 2026-09-03, AutoCount in hand) ─────────────
     ?copyFrom=<piId> pre-fills CONTENT from an existing bill — supplier,
     lines (category + variants riding along), notes, currency+rate — and
     NOTHING with an identity: fresh number, today's date, no supplier
     invoice ref (that belongs to the SOURCE bill's paper), no GRN links
     (the copy is an independent manual bill). */
  const copyFrom = params.get('copyFrom');
  const copyQ = usePurchaseInvoiceDetail(copyFrom);
  const copyApplied = useRef(false);
  useEffect(() => {
    if (!copyFrom || copyApplied.current || !copyQ.data) return;
    copyApplied.current = true;
    const v = copyQ.data.purchaseInvoice as Record<string, unknown>;
    if (v.supplier_id) setManualSupplierId(String(v.supplier_id));
    if (v.notes) setNotes(String(v.notes));
    const cur = typeof v.currency === 'string' ? v.currency : null;
    if (cur && cur !== 'MYR') {
      setCurrencyOverride(cur);
      const rate = v.exchange_rate == null ? '' : String(v.exchange_rate);
      if (rate) { setExchangeRate(rate); setRateTouched(true); }
    }
    const items = copyQ.data.items as Array<Record<string, unknown>>;
    if (items.length > 0) {
      setLines(items.map((it, i) => ({
        rid:          `c${Date.now()}-${i}`,
        grnItemId:    null,
        materialKind: String(it.material_kind ?? 'mfg_product'),
        itemCode:     String(it.item_code ?? ''),
        materialName: String(it.material_name ?? ''),
        itemGroup:    (it.item_group as string | null) ?? null,
        variants:     (it.variants as Record<string, unknown> | null) ?? null,
        qty:          Number(it.qty ?? 1),
        unitPriceSen: Number(it.unit_price_sen ?? 0),
        notes:        String(it.notes ?? ''),
      })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyFrom, copyQ.data]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const subtotalSen = useMemo(
    () => lines.reduce((s, l) => s + l.qty * l.unitPriceSen, 0),
    [lines],
  );

  /* PI-level freight allocation preview (Phase 1-A) — mirror GrnNew's allocPreview
     so the operator SEES the freight ("平摊") split across goods lines before
     saving. Charge pool = Σ SERVICE-line values; per-line freight uses the chosen
     basis (QTY / VALUE / CBM) with last-line-remainder. The server's
     reallocatePiCharges is authoritative; this is just the live preview. */
  const allocPreview = useMemo(() => {
    const isSvc = (l: DraftLine) => isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode });
    const goods = lines.filter((l) => l.itemCode.trim() && !isSvc(l));
    const chargePool = lines
      .filter((l) => l.itemCode.trim() && isSvc(l))
      .reduce((s, l) => s + l.qty * l.unitPriceSen, 0);
    const basisOf = (l: DraftLine): number => {
      if (allocationMethod === 'VALUE') return l.qty * l.unitPriceSen;
      if (allocationMethod === 'CBM') return l.qty; // volume unknown client-side → qty proxy
      return l.qty;
    };
    let sumBasis = goods.reduce((s, l) => s + basisOf(l), 0);
    if (sumBasis <= 0) sumBasis = goods.reduce((s, l) => s + l.qty, 0);
    const allocByRid = new Map<string, number>();
    let used = 0;
    goods.forEach((l, i) => {
      const isLast = i === goods.length - 1;
      let alloc = 0;
      if (chargePool > 0 && sumBasis > 0) {
        alloc = isLast ? chargePool - used : Math.round((chargePool * basisOf(l)) / sumBasis);
        if (!isLast) used += alloc;
      }
      allocByRid.set(l.rid, alloc);
    });
    return { chargePool, allocByRid, goodsCount: goods.length };
  }, [lines, allocationMethod]);

  // flow-queries.ts types this as `any`; narrow locally to the fields we
  // actually touch here. Keeps the rest of the page honest without forcing
  // a global refactor of the shared queries file.
  type GrnDetail = {
    id: string;
    grn_number: string;
    supplier_id: string;
    purchase_order_id: string | null;
    supplier?: { id?: string; name?: string; code?: string } | null;
    purchase_order?: { id?: string; po_number?: string } | null;
  };
  const grn      = grnQ.data?.grn as GrnDetail | undefined;
  const supplier = grn?.supplier;
  const po       = grn?.purchase_order;

  // Effective supplier id + display name (from GRN, or the manual <select>).
  const manualSupplierRow = isManual
    ? ((suppliersQ.data ?? []).find((s) => s.id === manualSupplierId) ?? null)
    : null;
  const supplierId   = isManual ? (manualSupplierId || null) : (grn?.supplier_id ?? null);
  const supplierName = isManual
    ? (manualSupplierRow?.name ?? null)
    : (supplier?.name ?? null);

  /* Commander 2026-05-29 — payment-term days for the resolved supplier. Parse
     the first integer out of `payment_terms` (e.g. "30 DAYS" / "30" → 30);
     default 30 when absent/unparseable. The manual supplier carries it on its
     row; the ?grnId GRN's supplier object omits payment_terms, so it defaults. */
  const supplierTermDays = useMemo(() => {
    const raw = manualSupplierRow?.payment_terms ?? null;
    const m = raw ? String(raw).match(/(\d+)/) : null;
    const n = m && m[1] ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30;
  }, [manualSupplierRow?.payment_terms]);

  /* Auto-default Due Date = Invoice Date + supplierTermDays whenever the
     invoice date or the supplier changes — UNLESS the operator has manually
     edited Due Date (dueTouched). */
  useEffect(() => {
    if (dueTouched || !invoiceDate) return;
    const d = new Date(`${invoiceDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    d.setDate(d.getDate() + supplierTermDays);
    // d is LOCAL midnight + terms — format in local time; toISOString (UTC)
    // would land on the previous calendar day for any UTC+ timezone.
    setDueDate(d.toLocaleDateString('en-CA'));
  }, [invoiceDate, supplierTermDays, dueTouched]);

  // Commander 2026-05-29 — make the MANUAL item picker supplier-binding-aware,
  // exactly like New PO / New GRN. Once a supplier is chosen the per-line Item
  // Code datalist lists THAT supplier's bound SKUs; picking one fills name +
  // unit price + itemGroup from the binding. Falls back to useMfgProducts when
  // no supplier is set yet.
  const supplierDetailQ = useSupplierDetail(supplierId);
  const bindings        = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  /* Commander 2026-05-29 — the resolved supplier object (same source New PO uses)
     so the PI header can auto-fill Name + Address + the Contact · Phone · Email ·
     Terms · Currency info bar, mirroring New PO. No warehouse (PI is AP only). */
  const supplierDetail  = supplierDetailQ.data?.supplier ?? null;

  /* Multi-currency AP (Phase 1-A) — the PI's currency defaults to the resolved
     supplier's currency (e.g. a China supplier billing RMB); MYR when unset. The
     operator may override it (the invoice stays in that currency; the exchange
     rate only converts the AP posting to MYR at GL-post time server-side). MYR is
     a strict no-op — no rate field. */
  const currency = (currencyOverride ?? supplierDetail?.currency ?? 'MYR').toUpperCase();
  const isForeign = currency !== 'MYR';
  /* Auto-fill the rate from the currencies MASTER when the PI settles on a foreign
     currency (still editable). MYR resets to 1. A manual edit wins. */
  const currenciesQ = useActiveCurrencies();
  useEffect(() => {
    if (!isForeign) { setExchangeRate('1'); setRateTouched(false); return; }
    if (rateTouched) return;
    setExchangeRate(String(rateFor(currenciesQ.data, currency)));
  }, [isForeign, currency, currenciesQ.data, rateTouched]);

  // ── Manual product search (gated by min query length, mirrors GrnNew). ───
  const [productQuery, setProductQuery] = useState<string>('');
  /* Perf — debounce the datalist search so a fast typist fires one
     /mfg-products request per pause, not per keystroke. Native <datalist>
     renders <option>s directly, so no render cap is needed — only the refetch. */
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  // Supplier-bound picks carry no category on the binding row, so (mirroring
  // New PO's `allSkus`/`categoryForCode`) we pull the full catalogue to resolve
  // a bound SKU's itemGroup. Gated to manual + supplier so a GRN-sourced /
  // no-supplier PI never fires the lookup.
  const allSkusQ = useMfgProducts({ enabled: isManual && !!supplierId });
  const categoryForCode = (code: string): string | null => {
    const sku = (allSkusQ.data ?? []).find((p) => p.code === code);
    return sku?.category ? sku.category.toLowerCase() : null;
  };

  /* Fill an existing manual line from a picked SKU code (inline per-line
     picker, mirrors GrnNew.pickItemForLine). */
  const pickItemForLine = (rid: string, code: string) => {
    const p = (productsQ.data ?? []).find((x) => x.code === code);
    if (!p) { setLine(rid, { itemCode: code }); return; }
    setLine(rid, {
      materialKind: 'mfg_product',
      itemCode: p.code,
      materialName: p.name,
      itemGroup:    p.category ? p.category.toLowerCase() : null,
    });
    setProductQuery('');
  };

  /* Commander 2026-05-29 — supplier-bound pick (New PO/GRN parity): when a
     supplier is chosen and the typed/picked code matches one of THAT
     supplier's bindings, fill name + UNIT PRICE (from the binding) + itemGroup.
     PI's DraftLine has no supplierSku field, so we skip it. */
  const pickBindingForLine = (rid: string, b: typeof bindings[number]) => {
    setLine(rid, {
      materialKind:   'mfg_product',
      itemCode:   b.item_code,
      materialName:   b.material_name,
      unitPriceSen: b.unit_price_sen,
      itemGroup:      categoryForCode(b.item_code),
    });
  };
  /* Append a blank manual line — PO-style "Add another item". */
  const addEmptyManualLine = () =>
    setLines((prev) => [...prev, {
      rid:            `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      grnItemId:      null,
      materialKind:   'mfg_product',
      itemCode:   '',
      materialName:   '',
      itemGroup:      null,
      variants:       null,
      qty:            1,
      unitPriceSen: 0,
      notes:          '',
    }]);

  const canSave = !!supplierId && lines.length > 0 && lines.every((l) => l.qty > 0);

  /* asDraft = "Save as Draft": create the PI as DRAFT (no AP/GL post, no GRN
     consume) so the operator can review/correct first, then Confirm on the detail
     page. Default (asDraft=false) keeps the existing create-then-auto-post flow so
     PI lands POSTED, exactly like the SO template's CONFIRMED default. */
  const onSave = async (asDraft = false) => {
    if (!supplierId) {
      setDialog({ title: 'Pick a supplier', body: isManual
        ? 'Choose a supplier for this manual invoice.'
        : 'This GRN is missing a supplier — reopen it and try again.' });
      return;
    }
    // Drop the blank starter line(s) — only real items (with a code) are saved.
    const realLines = lines.filter((l) => l.itemCode.trim());
    if (realLines.length === 0) {
      setDialog({ title: 'Add at least one item', body: 'Pick at least one SKU to invoice.' });
      return;
    }
    if (!canSave) { setDialog({ title: 'Check the quantities', body: 'Each line needs qty > 0.' }); return; }
    try {
      const createRes = await create.mutateAsync({
        idempotencyKey: idemKey,
        // Manual: no GRN / PO behind it. GRN-sourced: carry both FKs through.
        supplierId,
        purchaseOrderId:    isManual ? null : (grn?.purchase_order_id ?? null),
        grnId:              isManual ? null : (grn?.id ?? null),
        supplierInvoiceRef: supplierInvoiceRef || undefined,
        invoiceDate,
        dueDate:            dueDate || undefined,
        notes:              notes || undefined,
        // DRAFT lifecycle — opt-in. The server skips the GRN consume + GL post
        // for a DRAFT; both run on Confirm (PATCH /:id/post).
        asDraft,
        // Multi-currency AP (Phase 1-A) — send the resolved currency + rate. MYR
        // forces 1 (server enforces too); a blank/invalid foreign rate → 1.
        currency,
        exchangeRate:       isForeign
          ? resolveFxRate(exchangeRate)
          : 1,
        // PI-level freight allocation (Phase 1-A) — the freight "平摊" basis.
        allocationMethod,
        items: realLines.map((l) => ({
          grnItemId:      l.grnItemId,
          materialKind:   l.materialKind,
          itemCode:   l.itemCode,
          materialName:   l.materialName,
          qty:            l.qty,
          unitPriceSen: l.unitPriceSen,
          notes:          l.notes || undefined,
          // Commander 2026-05-29 — persist the line's category + variant
          // selections (columns exist on purchase_invoice_items, migration 0057)
          // so the PI reflects WHAT was billed, same as the GRN/PO upstream.
          itemGroup:      l.itemGroup,
          variants:       l.variants,
        })),
      });
      if (!asDraft) {
        // Auto-post (Confirm) so PI lands in POSTED state (matches PO + GRN).
        await post.mutateAsync(createRes.id);
      }
      /* THE ACCOUNTS MAY HAVE IT WITHOUT ALL OF IT — and on a purchase
         invoice the field most likely to be missing is the SUPPLIER'S OWN
         invoice number, which is the one accounts will ask about. Same shared
         frame as every other surface. Never blocks; the liability is booked. */
      await notifyAcNotSent(notify, createRes, 'Purchase invoice');
      setDialog({
        title: `PI ${createRes.invoiceNumber} created`,
        body: asDraft
          ? 'Saved as Draft — review, then Confirm to post the AP liability.'
          : 'Created + posted — AP liability recorded.',
        goTo: `/scm/purchase-invoices/${createRes.id}`,
      });
    } catch (err) {
      setDialog({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  };


  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title={`New Purchase Invoice${!isManual && grn?.grn_number ? ` · ${grn.grn_number}` : ''}`}
        actions={
          <div className={styles.actions}>
            {/* Keep the GRN→Invoice path: jump to the multi-GRN-line picker. */}
            {isManual && (
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-invoices/from-grn')}>
                <ArrowRightLeft {...ICON} /> {transferFromLabel('grn')}
              </Button>
            )}
            <Button variant="ghost" size="md" onClick={() => navigate(isManual ? '/scm/purchase-invoices' : (grn ? `/scm/grns/${grn.id}` : '/scm/grns'))}>
              <X {...ICON} /> Cancel
            </Button>
            {/* Save as Draft — creates the PI as DRAFT (no AP post / GRN consume);
                Confirm later on the detail page. Mirrors the SO Draft flow. */}
            <Button variant="ghost" size="md" onClick={() => onSave(true)} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Save as Draft'}
            </Button>
            <Button variant="primary" size="md" onClick={() => onSave(false)} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Create Purchase Invoice'}
            </Button>
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            {/* GRN # / PO # context only when sourced from a GRN. In manual mode
                we show the supplier picker in their place. */}
            {!isManual ? (
              <>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>GRN #</span>
                  <input type="text" readOnly value={grn?.grn_number ?? ''} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>PI #</span>
                  <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                </label>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>PO #</span>
                  <input type="text" readOnly value={po?.po_number ?? '—'} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Supplier</span>
                  <input type="text" readOnly value={supplierName ?? ''} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                </label>
              </>
            ) : (
              <>
                <label className={styles.field}>
                  <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Supplier <span className={styles.req}>*</span></span>
                  <select
                    value={manualSupplierId}
                    onChange={(e) => setManualSupplierId(e.target.value)}
                    className={styles.fieldInput}
                    disabled={suppliersQ.isLoading}
                  >
                    <option value="">{suppliersQ.isLoading ? 'Loading suppliers…' : '— Pick a supplier —'}</option>
                    {sortByText(suppliersQ.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>PI #</span>
                  <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                </label>
              </>
            )}

            {/* Commander 2026-05-29 — Name + Address auto-fill once a supplier is
                resolved (manual / from GRN), mirroring New PO. No warehouse (PI
                is AP only — it doesn't touch inventory). */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                type="text"
                readOnly
                value={supplierDetail?.name ?? supplierName ?? ''}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Address</span>
              <textarea
                readOnly
                value={[supplierDetail?.address, supplierDetail?.area, supplierDetail?.postcode, supplierDetail?.state, supplierDetail?.country]
                  .filter(Boolean).join(', ')}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)', minHeight: 52, resize: 'vertical' }}
                rows={3}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier Invoice #</span>
              <input type="text" value={supplierInvoiceRef} onChange={(e) => setSupplierInvoiceRef(e.target.value)} placeholder="From the supplier's printed invoice" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Invoice Date</span>
              <DateField fullWidth value={invoiceDate} onChange={(iso) => setInvoiceDate(iso)} className={styles.fieldInput}/>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Due Date</span>
              {/* Commander 2026-05-29 — auto = Invoice Date + supplier term days
                  (default 30) until the operator edits it (dueTouched). */}
              <DateField fullWidth value={dueDate} onChange={(iso) => { setDueTouched(true); setDueDate(iso); }} className={styles.fieldInput}/>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes for AP" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
            </label>
            {/* PI-level freight allocation (Phase 1-A) — choose how a freight
                SERVICE line's charge ("平摊") is spread across the goods lines. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Charge allocation</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={allocationMethod}
                  onChange={(e) => setAllocationMethod(e.target.value as 'QTY' | 'VALUE' | 'CBM')}
                >
                  <option value="QTY">By quantity (default)</option>
                  <option value="VALUE">By value</option>
                  <option value="CBM">By volume (CBM)</option>
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
              {allocPreview.chargePool > 0 && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>
                  {fmtRm(allocPreview.chargePool, currency)} freight spread across {allocPreview.goodsCount} goods line(s)
                </span>
              )}
            </label>
            {/* Multi-currency AP (Phase 1-A). Currency defaults to the supplier's
                currency (MYR = strict no-op, rate field hidden); a foreign
                currency reveals the auto-filled, editable exchange rate. */}
            <CurrencySelect
              currency={currency}
              onCurrencyChange={setCurrencyOverride}
              exchangeRate={exchangeRate}
              onRateChange={(v) => { setRateTouched(true); setExchangeRate(v); }}
              rateHint={<>≈ {fmtRm(Math.round(subtotalSen * resolveFxRate(exchangeRate)), 'MYR')} posted to GL</>}
              styles={styles}
            />
          </div>

          {/* Read-only supplier-info bar — same markup/classes as New PO. */}
          {supplierDetail && (
            <div style={{
              marginTop: 'var(--space-3)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)',
              fontSize: 'var(--fs-12)',
              color: 'var(--fg-muted)',
              display: 'flex',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}>
              {supplierDetail.contact_person && <span>Contact: <strong>{supplierDetail.contact_person}</strong></span>}
              {supplierDetail.phone          && <span>Phone: <strong>{formatPhone(supplierDetail.phone)}</strong></span>}
              {supplierDetail.email          && <span>Email: <strong>{supplierDetail.email}</strong></span>}
              {supplierDetail.payment_terms  && <span>Terms: <strong>{supplierDetail.payment_terms}</strong></span>}
              <span>Currency: <strong>{supplierDetail.currency ?? currency}</strong></span>
            </div>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {!isManual && grnQ.isLoading
              ? 'Loading GRN items…'
              : lines.length === 0
                ? (isManual ? 'Manual invoice — pick a supplier above, then add items below' : 'No accepted items on this GRN')
                : `${lines.length} line${lines.length === 1 ? '' : 's'} · subtotal ${fmtRm(subtotalSen, currency)}`}
            {/* Commander 2026-05-29 — same supplier-binding hint New PO / New GRN
                show: once a supplier is chosen the manual picker filters to that
                supplier's bound SKUs (or the full catalogue when it has none). */}
            {isManual && supplierId && (
              <span style={{ display: 'block', marginTop: 2, color: 'var(--c-burnt)' }}>
                {bindings.length > 0
                  ? `${bindings.length} item${bindings.length === 1 ? '' : 's'} bound to this supplier — picker filters to these`
                  : 'No SKUs bound to this supplier yet — picker shows all SKUs (one-off invoice)'}
              </span>
            )}
          </span>
        </div>
        {/* Card-per-line layout — Commander 2026-05-29: "PO / GRN / Purchase
            Invoice 三个界面要一样". Mirrors New PO / New GRN. */}
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.length === 0 && (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3) 0' }}>
              {isManual
                ? 'Pick a supplier in the header, then use “Add another item” below to add lines by hand.'
                : 'No accepted items on this GRN.'}
            </p>
          )}
          {lines.map((l, idx) => {
            const lineTotal = l.qty * l.unitPriceSen;
            // Commander 2026-05-29 — same muted variant sub-line GrnNew shows,
            // so the PI mirrors what the GRN (and PO upstream) describe.
            const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
            /* PI-level freight allocation (Phase 1-A) — this goods line's share of
               the freight pool + landed unit cost, shown only when there's a
               charge to spread. Service (freight) lines get 0. */
            const lineIsSvc = isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode });
            const lineAllocSen = allocPreview.allocByRid.get(l.rid) ?? 0;
            const landedUnitSen = l.unitPriceSen + (l.qty > 0 ? Math.round(lineAllocSen / l.qty) : 0);
            // Editable variant section only for MANUAL lines (grnItemId === null)
            // that are bedframe/sofa, once the maintenance pools are loaded.
            // GRN-sourced lines keep their read-only summary.
            const showVariantEditor =
              l.grnItemId === null &&
              (l.itemGroup === 'bedframe' || l.itemGroup === 'sofa') &&
              !!maint;
            const setVariant = (key: string, value: string) =>
              setLine(l.rid, { variants: (() => {
                const variants: Record<string, unknown> = { ...(l.variants ?? {}), [key]: value };
                // Auto-compute bedframe Total Height = Divan + Leg + Gap.
                if (isTotalHeightCategory(l.itemGroup) && isTotalHeightPart(key)) {
                  variants.totalHeight = computeTotalHeight(l.itemGroup, variants);
                }
                return variants;
              })() });
            const isManualLine = l.grnItemId === null;
            return (
              <div key={l.rid} style={{
                background: 'var(--c-paper)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
              }}>
                {/* Card header — LINE N · category pill · line total · remove */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-12)', fontWeight: 700, letterSpacing: '0.10em', color: 'var(--fg-muted)' }}>LINE {idx + 1}</span>
                    {l.itemGroup && <ItemGroupPill group={l.itemGroup} />}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      <span className={styles.previewPrice}>{fmtRm(lineTotal, currency)}</span>
                      {/* PI-level freight allocation — +freight & landed unit cost,
                          on goods lines only when there's a charge pool. */}
                      {allocPreview.chargePool > 0 && !lineIsSvc && (
                        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--c-accent, #8a6d3b)', marginTop: 2 }}>
                          +{fmtRm(lineAllocSen, currency)} freight · landed {fmtRm(landedUnitSen, currency)}/unit
                        </span>
                      )}
                    </span>
                    <button type="button" onClick={() => dropLine(l.rid)} title="Remove line"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-festive-b, #B8331F)', padding: 4, display: 'inline-flex' }}>
                      <Trash2 {...SM_ICON} />
                    </button>
                  </div>
                </div>

                {/* Identity row — Item Code (Internal) + Description */}
                <div className={styles.formGrid2}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Item Code (Internal)</span>
                    {isManualLine ? (
                      <>
                        <input type="text" list={`pi-products-${l.rid}`} value={l.itemCode}
                          onChange={(e) => {
                            const code = e.target.value;
                            setProductQuery(code);
                            // Commander 2026-05-29 — supplier-binding-aware pick
                            // (New PO/GRN parity). When a supplier is chosen and
                            // the code matches one of its bindings, fill name +
                            // unit price + itemGroup from the binding.
                            const bound = supplierId
                              ? bindings.find((b) => b.item_code === code)
                              : undefined;
                            if (bound) { pickBindingForLine(l.rid, bound); return; }
                            const match = (productsQ.data ?? []).find((p) => p.code === code);
                            if (match) { pickItemForLine(l.rid, code); return; }
                            setLine(l.rid, { itemCode: code });
                          }}
                          placeholder={supplierId && bindings.length > 0
                            ? 'Pick one of this supplier’s bound SKUs…'
                            : 'Type ≥2 chars to search SKUs by code or name…'}
                          className={styles.fieldInput} style={{ fontFamily: 'var(--font-mono)' }} />
                        <datalist id={`pi-products-${l.rid}`}>
                          {/* Supplier chosen + has bindings → list THAT supplier's
                              bound SKUs (New PO parity). Else fall back to the
                              gated full-catalogue search. */}
                          {supplierId && bindings.length > 0
                            ? sortByText(bindings).map((b) => (
                                <option key={b.id} value={b.item_code}>
                                  {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_sen, b.currency)}
                                </option>
                              ))
                            : sortByText(productsQ.data ?? []).map((p) => (<option key={p.id} value={p.code}>{p.name} · {p.category}</option>))}
                        </datalist>
                      </>
                    ) : (
                      <input type="text" readOnly value={l.itemCode} className={styles.fieldInput}
                        style={{ fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                    )}
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Description</span>
                    <input type="text" value={l.materialName} onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                      readOnly={!isManualLine}
                      placeholder={isManualLine ? '(auto-filled when an item is picked — editable)' : ''}
                      className={styles.fieldInput}
                      style={!isManualLine ? { background: 'var(--c-cream)', color: 'var(--fg-muted)' } : undefined} />
                  </label>
                </div>

                {/* PO/GRN-sourced lines: read-only variant summary. */}
                {!isManualLine && variantSummary && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
                )}

                {/* Per-category VARIANT EDITOR for MANUAL bedframe/sofa lines. */}
                {showVariantEditor && (
                  <div style={{ background: 'var(--c-cream)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
                    <div style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 'var(--space-2)' }}>{l.itemGroup} Variants</div>
                    {l.itemGroup === 'bedframe' ? (
                      <div className={styles.formGrid4}>
                        <VariantSelect label="Divan Height" options={sortByNumeric(activeOptions(maint!.divanHeights, String(l.variants?.divanHeight ?? '')))}
                          value={String(l.variants?.divanHeight ?? '')} onChange={(v) => setVariant('divanHeight', v)} />
                        <VariantSelect label="Gap" options={sortByNumeric(maintPickerValues(maint!.gaps, String(l.variants?.gap ?? '')).map((g) => ({ value: g, priceSen: 0 })))}
                          value={String(l.variants?.gap ?? '')} onChange={(v) => setVariant('gap', v)} />
                        <VariantSelect label="Leg Height" options={sortByNumeric(activeOptions(maint!.legHeights, String(l.variants?.legHeight ?? '')))}
                          value={String(l.variants?.legHeight ?? '')} onChange={(v) => setVariant('legHeight', v)} />
                        {/* Total Heights auto-computed (see setVariant). Special
                            Orders moved to the shared block below. */}
                      </div>
                    ) : (
                      <div className={styles.formGrid4}>
                        <VariantSelect label="Seat Size" options={sortByNumeric(maintPickerValues(maint!.sofaSizes, String(l.variants?.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 })))}
                          value={String(l.variants?.seatHeight ?? '')} onChange={(v) => setVariant('seatHeight', v)} />
                        <VariantSelect label="Leg Height" options={sortByNumeric(activeOptions(maint!.sofaLegHeights, String(l.variants?.legHeight ?? '')))}
                          value={String(l.variants?.legHeight ?? '')} onChange={(v) => setVariant('legHeight', v)} />
                        <label className={styles.field}>
                          <span className={styles.fieldLabel}>Fabrics (free text)</span>
                          <input className={styles.fieldInput} value={String(l.variants?.fabricColor ?? '')}
                            onChange={(e) => setVariant('fabricColor', e.target.value)} />
                        </label>
                      </div>
                    )}
                    {/* Special Orders — shared editor (owner 2026-07-20). A manual
                        PI line is not parent-linked, so it is directly editable
                        and writes variants.specials (array). */}
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <SpecialOrders
                        options={l.itemGroup === 'bedframe' ? specialsPools.bedframe : specialsPools.sofa}
                        variants={(l.variants ?? {}) as Record<string, unknown>}
                        onPatch={(patch) => setLine(l.rid, { variants: { ...(l.variants ?? {}), ...patch } })}
                        showPrices={false}
                      />
                    </div>
                  </div>
                )}

                {/* Fields row — Qty · Unit Price · Line Total */}
                <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Qty</span>
                    <input type="number" min={0} value={l.qty}
                      onChange={(e) => setLine(l.rid, { qty: Math.max(0, Number(e.target.value) || 0) })}
                      className={styles.fieldInput} style={{ textAlign: 'right' }} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                    <MoneyInput bare valueSen={l.unitPriceSen}
                      onCommit={(sen) => setLine(l.rid, { unitPriceSen: sen ?? 0 })}
                      inputClassName={styles.fieldInput} selectOnFocus />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Line Total</span>
                    <input type="text" readOnly value={fmtRm(lineTotal, currency)} className={styles.fieldInput}
                      style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
                  </label>
                </div>
              </div>
            );
          })}

          {/* "Add another item" — manual mode (mirrors New PO, always shown). */}
          {isManual && (
            <button type="button" onClick={addEmptyManualLine}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '12px 14px', border: '1px dashed var(--c-orange)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--c-orange)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer' }}>
              + Add another item
            </button>
          )}
        </div>
      </section>

      {/* Totals card aligned right — identical to New PO / New GRN.
          lg:pr-32 pulls it clear of the fixed bottom-right FAB cluster
          ("+" + Assistant disc + Back-to-top park out to ~144px), which
          otherwise covers the amounts when scrolled to the bottom. */}
      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalSen, currency)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-16)', fontWeight: 700, borderTop: '1px solid var(--line)', paddingTop: 'var(--space-2)' }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalSen, currency)}</span>
            </div>
          </div>
        </section>
      </div>

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? 'Open PI' : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          /* Owner 2026-07-23: "Need a button to new purchase invoice" — the
             billing loop keys one PI per GRN back-to-back, so success offers a
             straight jump to the from-GRN picker for the next note. */
          secondaryLabel={dialog.goTo ? 'New Purchase Invoice' : undefined}
          onSecondary={dialog.goTo ? () => { setDialog(null); navigate('/scm/purchase-invoices/from-grn'); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
