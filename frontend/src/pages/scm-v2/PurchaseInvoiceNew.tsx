
import { transferFromLabel } from '../../lib/convertScope';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Trash2, X, ChevronDown, ArrowRightLeft } from 'lucide-react';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { activeOptions, buildVariantSummary, isServiceLine, maintPickerValues, fmtMoneySen } from '@2990s/shared';
import {
  useCreatePurchaseInvoice,
  usePostPurchaseInvoice,
  usePurchaseInvoiceDetail,
} from '../../vendor/scm/lib/purchase-invoice-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { useGrnDetail, useGrnDetails } from '../../vendor/scm/lib/grn-queries';
import { useActiveCurrencies, rateFor } from '../../vendor/scm/lib/currencies-queries';
import { LinePoRefLink } from '../../vendor/scm/components/LinePoRefLink';
import { PoPriceReference } from '../../vendor/scm/components/PoPriceReference';
import { defaultPiUnitPriceSen } from '../../vendor/scm/lib/pi-po-price-rule';
import { linePoLink, type LinePoFields } from '../../vendor/scm/lib/line-po-link';
import { piCreatedAndPostedSentence } from '../../vendor/scm/lib/pi-ledger-outcome';
import { CurrencySelect } from '../../vendor/scm/components/CurrencySelect';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { specialOrderSurface } from '../../vendor/scm/lib/special-order-surface';
import { useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons, mfgCategoryLabel } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import styles from './SalesOrderDetail.module.css';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { notifyAcNotSent } from '../../vendor/scm/lib/ac-not-sent';
import { PageHeader } from '../../components/Layout';
import { resolveFxRate } from './fx-rate';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';
import { DateField } from "../../vendor/scm/components/DateField";
import { afterCreatePath, sourceDocPath } from '../../lib/returnToSource';
import { FormTouchScope } from '../../components/FormTouchScope';
import { useFormTouched, useLeaveGuard } from '../../hooks/useLeaveGuard';
import { attachTakenFiles, takePvFiles } from '../../vendor/scm/lib/pv-file-handoff';
import { uploadFlowDocFile } from '../../vendor/scm/lib/flow-doc-files';
import type { PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';

const ICON    = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return fmtMoneySen(v, currency);
};

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
  sourcePo?:      LinePoFields;
  poUnitPriceSen?: number | null;
};

export const PurchaseInvoiceNew = () => {
  const navigate = useNavigate();
  const { touched: formTouched, markTouched } = useFormTouched();
  const { allowLeave } = useLeaveGuard(formTouched, null);
  const notify = useNotify();
  const [params] = useSearchParams();
  const grnId    = params.get('grnId');
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

  const isManual = !grnId;

  const idemKey = useIdempotencyKey();
  const create = useCreatePurchaseInvoice();
  const post   = usePostPurchaseInvoice();
  const saving = create.isPending || post.isPending;

  const [manualSupplierId, setManualSupplierId] = useState<string>('');
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;

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
  const [exchangeRate, setExchangeRate] = useState<string>('1');
  const [rateTouched, setRateTouched] = useState<boolean>(false);
  const [currencyOverride, setCurrencyOverride] = useState<string | null>(null);
  const [allocationMethod, setAllocationMethod] = useState<'QTY' | 'VALUE' | 'CBM'>('QTY');
  const [lines, setLines]             = useState<DraftLine[]>([]);
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string; goLabel?: string } | null>(null);

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
    let pickQtyById: Map<string, number> | null = null;
    if (fromPicks) {
      const picks = readScmHandoff<Array<{ grnItemId: string; qty: number }>>('piFromGrnPicks');
      if (picks) pickQtyById = new Map(picks.map((p) => [p.grnItemId, Number(p.qty ?? 0)]));
      removeScmHandoff('piFromGrnPicks');
    }
    const next: DraftLine[] = (sourceItems)
      .map((it: any) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.invoiced_qty ?? 0) - (it.returned_qty ?? 0) }))
      .filter((it: any) => (pickQtyById ? pickQtyById.has(it.id) : it._remaining > 0))
      .map((it: any) => ({
        rid:            `r${it.id}`,
        grnItemId:      it.id,
        materialKind:   it.material_kind,
        itemCode:   it.item_code,
        materialName:   it.material_name,
        itemGroup:      it.item_group ?? null,
        variants:       (it.variants as Record<string, unknown> | null) ?? null,
        qty:            pickQtyById ? (pickQtyById.get(it.id) ?? it._remaining) : it._remaining,
        /* Owner 2026-09-14: 「create 的时候，系统肯定会把 PO 的价钱直接带过来」 —
           the PO price when the order named one, else the receipt's. */
        unitPriceSen: defaultPiUnitPriceSen(it.po_unit_price_sen ?? null, it.unit_price_sen ?? 0),
        poUnitPriceSen: it.po_unit_price_sen ?? null,
        notes:          '',
        sourcePo:       { source_po_id: it.source_po_id ?? null, source_po_number: it.source_po_number ?? null },
      }));
    setLines(next);
  }, [sourceItems, fromPicks]);

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

  /* ── 扫 → bill (the owner, 2026-09-03: 他是扫 bill, 然后帮我录入 bill.
     几时要还是我会开 ap payment 去还) ──────────────────────────────────────
     The scan page hands the extraction over via location.state: supplier
     (when the reader matched one), the supplier's own invoice number and
     date, and one manual line per read line — RECORDING the debt only;
     paying stays an AP Payment, later, his call. */
  const location = useLocation();
  const scanApplied = useRef(false);
  const [scanFiles, setScanFiles] = useState<PvFilePayload[]>([]);
  useEffect(() => {
    const scan = (location.state as {
      scanBill?: {
        supplierId: string | null;
        extraction: { invoiceNumber: string | null; invoiceDate: string | null; lines: Array<{ description: string | null; amountSen: number | null }> };
        lines?: Array<{ description: string | null; amountSen: number | null }>;
      };
    } | null)?.scanBill;
    if (!scan || scanApplied.current || !isManual) return;
    scanApplied.current = true;
    const pages = takePvFiles();
    if (pages.length > 0) setScanFiles(pages);
    if (scan.supplierId) setManualSupplierId(scan.supplierId);
    if (scan.extraction.invoiceNumber) setSupplierInvoiceRef(scan.extraction.invoiceNumber);
    if (scan.extraction.invoiceDate) setInvoiceDate(scan.extraction.invoiceDate);
    const src = (scan.lines ?? scan.extraction.lines).filter((l) => l.amountSen != null && l.amountSen > 0);
    if (src.length > 0) {
      setLines(src.map((l, i) => ({
        rid:          `s${Date.now()}-${i}`,
        grnItemId:    null,
        materialKind: 'mfg_product',
        itemCode:     '',
        materialName: l.description ?? 'As per bill',
        itemGroup:    null,
        variants:     null,
        qty:          1,
        unitPriceSen: l.amountSen ?? 0,
        notes:        '',
      })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, isManual]);

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
      if (allocationMethod === 'CBM') return l.qty;
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

  const manualSupplierRow = isManual
    ? ((suppliersQ.data ?? []).find((s) => s.id === manualSupplierId) ?? null)
    : null;
  const supplierId   = isManual ? (manualSupplierId || null) : (grn?.supplier_id ?? null);
  const supplierName = isManual
    ? (manualSupplierRow?.name ?? null)
    : (supplier?.name ?? null);

  const supplierTermDays = useMemo(() => {
    const raw = manualSupplierRow?.payment_terms ?? null;
    const m = raw ? String(raw).match(/(\d+)/) : null;
    const n = m && m[1] ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30;
  }, [manualSupplierRow?.payment_terms]);

  useEffect(() => {
    if (dueTouched || !invoiceDate) return;
    const d = new Date(`${invoiceDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    d.setDate(d.getDate() + supplierTermDays);
    setDueDate(d.toLocaleDateString('en-CA'));
  }, [invoiceDate, supplierTermDays, dueTouched]);

  const supplierDetailQ = useSupplierDetail(supplierId);
  const bindings        = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  const supplierDetail  = supplierDetailQ.data?.supplier ?? null;

  const currency = (currencyOverride ?? supplierDetail?.currency ?? 'MYR').toUpperCase();
  const isForeign = currency !== 'MYR';
  const currenciesQ = useActiveCurrencies();
  useEffect(() => {
    if (!isForeign) { setExchangeRate('1'); setRateTouched(false); return; }
    if (rateTouched) return;
    setExchangeRate(String(rateFor(currenciesQ.data, currency)));
  }, [isForeign, currency, currenciesQ.data, rateTouched]);

  const [productQuery, setProductQuery] = useState<string>('');
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  const allSkusQ = useMfgProducts({ enabled: isManual && !!supplierId });
  const categoryForCode = (code: string): string | null => {
    const sku = (allSkusQ.data ?? []).find((p) => p.code === code);
    return sku?.category ? sku.category.toLowerCase() : null;
  };

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

  const pickBindingForLine = (rid: string, b: typeof bindings[number]) => {
    setLine(rid, {
      materialKind:   'mfg_product',
      itemCode:   b.item_code,
      materialName:   b.material_name,
      unitPriceSen: b.unit_price_sen,
      itemGroup:      categoryForCode(b.item_code),
    });
  };
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

  const onSave = async (asDraft = false) => {
    if (!supplierId) {
      setDialog({ title: 'Pick a supplier', body: isManual
        ? 'Choose a supplier for this manual invoice.'
        : 'This GRN is missing a supplier — reopen it and try again.' });
      return;
    }
    const realLines = lines.filter((l) => l.itemCode.trim());
    if (realLines.length === 0) {
      setDialog({ title: 'Add at least one item', body: 'Pick at least one SKU to invoice.' });
      return;
    }
    if (!canSave) { setDialog({ title: 'Check the quantities', body: 'Each line needs qty > 0.' }); return; }
    try {
      const createRes = await create.mutateAsync({
        idempotencyKey: idemKey,
        supplierId,
        purchaseOrderId:    isManual ? null : (grn?.purchase_order_id ?? null),
        grnId:              isManual ? null : (grn?.id ?? null),
        supplierInvoiceRef: supplierInvoiceRef || undefined,
        invoiceDate,
        dueDate:            dueDate || undefined,
        notes:              notes || undefined,
        asDraft,
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
          itemGroup:      l.itemGroup,
          variants:       l.variants,
        })),
      });
      const att = await attachTakenFiles(scanFiles, (f) => uploadFlowDocFile('purchase-invoice', createRes.id, f));
      if (scanFiles.length > 0) setScanFiles([]);
      const filesNote = [
        att.attached > 0 ? `${att.attached} scanned page(s) attached.` : null,
        att.error ? `${att.failed} scanned page(s) did not attach (${att.error}) — add them from the invoice's Files card.` : null,
      ].filter(Boolean).join(' ');
      const ledger = asDraft ? undefined : (await post.mutateAsync(createRes.id)).ledger;
      await notifyAcNotSent(notify, createRes, 'Purchase invoice');
      allowLeave();
      setDialog({
        title: `PI ${createRes.invoiceNumber} created`,
        body: [asDraft
          ? 'Saved as Draft — review, then Confirm to post the AP liability.'
          : piCreatedAndPostedSentence(ledger), filesNote].filter(Boolean).join(' '),
        goTo: afterCreatePath(`/scm/purchase-invoices/${createRes.id}`, sourceDocPath.goodsReceipt(grnId)),
        goLabel: grnId ? 'Back to GRN' : undefined,
      });
    } catch (err) {
      setDialog({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  };


  return (
    <FormTouchScope onTouch={markTouched}>
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title={`New Purchase Invoice${!isManual && grn?.grn_number ? ` · ${grn.grn_number}` : ''}`}
        actions={
          <div className={styles.actions}>
            {isManual && (
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-invoices/from-grn')}>
                <ArrowRightLeft {...ICON} /> {transferFromLabel('grn')}
              </Button>
            )}
            <Button variant="ghost" size="md" onClick={() => navigate(isManual ? '/scm/purchase-invoices' : (grn ? `/scm/grns/${grn.id}` : '/scm/grns'))}>
              <X {...ICON} /> Cancel
            </Button>
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
            <CurrencySelect
              currency={currency}
              onCurrencyChange={setCurrencyOverride}
              exchangeRate={exchangeRate}
              onRateChange={(v) => { setRateTouched(true); setExchangeRate(v); }}
              rateHint={<>≈ {fmtRm(Math.round(subtotalSen * resolveFxRate(exchangeRate)), 'MYR')} posted to GL</>}
              styles={styles}
            />
          </div>

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
                ? 'Pick a supplier in the header, then use “Add line” below to add lines by hand.'
                : 'No accepted items on this GRN.'}
            </p>
          )}
          {lines.map((l, idx) => {
            const lineTotal = l.qty * l.unitPriceSen;
            const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
            const lineIsSvc = isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode });
            const lineAllocSen = allocPreview.allocByRid.get(l.rid) ?? 0;
            const landedUnitSen = l.unitPriceSen + (l.qty > 0 ? Math.round(lineAllocSen / l.qty) : 0);
            const showVariantEditor =
              l.grnItemId === null &&
              (l.itemGroup === 'bedframe' || l.itemGroup === 'sofa') &&
              !!maint;
              /* THE SPECIAL ORDER, for the categories with no variant grid.
                 Owner 2026-09-10: 「POGR 是不是也是要能看得到这些数据？…全部都是
                 要带过去的哦」 — a custom pillow's colour and an SP mattress's
                 size reach the supplier's PDF already (description2 carries the
                 SPECIAL segment for every category) but were invisible on every
                 cost document, because each one gates its editor on bedframe or
                 sofa. One rule, shared: vendor/scm/lib/special-order-surface.ts.
                 Empty pool on purpose — this document carries no catalogue for
                 those categories, and choosing WHAT to build is the sales
                 order's job. SpecialOrders no longer calls a carried pick
                 "retired" when it has no pool to judge it against. */
            const specialSurface = specialOrderSurface({
              category: l.itemGroup ?? '',
              hasItemCode: Boolean(l.itemCode),
              pickedSpecialCount: 0,
            });
            const setVariant = (key: string, value: string) =>
              setLine(l.rid, { variants: (() => {
                const variants: Record<string, unknown> = { ...(l.variants ?? {}), [key]: value };
                if (isTotalHeightCategory(l.itemGroup) && isTotalHeightPart(key)) {
                  variants.totalHeight = computeTotalHeight(l.itemGroup, variants);
                }
                return variants;
              })() });
            const isManualLine = l.grnItemId === null;
            return (
              <div data-grid-row key={l.rid} style={{
                background: 'var(--c-paper)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-12)', fontWeight: 700, letterSpacing: '0.10em', color: 'var(--fg-muted)' }}>LINE {idx + 1}</span>
                    {l.itemGroup && <ItemGroupPill group={l.itemGroup} />}
                    {l.sourcePo && linePoLink(l.sourcePo) && (
                      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                        From PO <LinePoRefLink line={l.sourcePo} />
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      <span className={styles.previewPrice}>{fmtRm(lineTotal, currency)}</span>
                      {allocPreview.chargePool > 0 && !lineIsSvc && (
                        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--c-accent, #8a6d3b)', marginTop: 2 }}>
                          +{fmtRm(lineAllocSen, currency)} freight · landed {fmtRm(landedUnitSen, currency)}/unit
                        </span>
                      )}
                    </span>
                    <button type="button" onClick={() => dropLine(l.rid)} title="Remove line"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', padding: 4, display: 'inline-flex' }}>
                      <Trash2 {...SM_ICON} />
                    </button>
                  </div>
                </div>

                <div className={styles.formGrid2}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Item Code (Internal)</span>
                    {isManualLine ? (
                      <>
                        <input type="text" list={`pi-products-${l.rid}`} value={l.itemCode}
                          onChange={(e) => {
                            const code = e.target.value;
                            setProductQuery(code);
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
                          {supplierId && bindings.length > 0
                            ? sortByText(bindings).map((b) => (
                                <option key={b.id} value={b.item_code}>
                                  {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_sen, b.currency)}
                                </option>
                              ))
                            : sortByText(productsQ.data ?? []).map((p) => (<option key={p.id} value={p.code}>{p.name} · {mfgCategoryLabel(p.category)}</option>))}
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

                {!isManualLine && variantSummary && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
                )}

                {specialSurface.block && (
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <SpecialOrders
                      options={[]}
                      variants={(l.variants ?? {}) as Record<string, unknown>}
                      onPatch={(patch) => setLine(l.rid, { variants: { ...(l.variants ?? {}), ...patch } })}
                      showPrices={false}
                      sourceLinked={l.grnItemId !== null}
                      sourceLabel="Purchase Order"
                    />
                  </div>
                )}
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

                <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Qty</span>
                    <NumberInput value={l.qty} sign="unsigned" decimal={false}
                      onValueChange={(n) => setLine(l.rid, { qty: Math.max(0, n ?? 0) })}
                      className={styles.fieldInput} style={{ textAlign: 'right' }} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                    <MoneyInput bare valueSen={l.unitPriceSen}
                      onCommit={(sen) => setLine(l.rid, { unitPriceSen: sen ?? 0 })}
                      inputClassName={styles.fieldInput} selectOnFocus />
                    {!isManualLine && (
                      <PoPriceReference poUnitPriceSen={l.poUnitPriceSen} piUnitPriceSen={l.unitPriceSen} fmt={(sen) => fmtRm(sen, currency)} />
                    )}
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

          {isManual && (
            <AddLineButton variant="block" onClick={addEmptyManualLine} />
          )}
        </div>
      </section>

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
          primaryLabel={dialog.goTo ? (dialog.goLabel ?? 'Open PI') : undefined}
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
    </FormTouchScope>
  );
};
