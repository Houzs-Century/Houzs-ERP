
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Trash2, X, ArrowRightLeft, ChevronDown } from 'lucide-react';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { activeOptions, buildVariantSummary, fmtDateOrDash, isServiceLine, maintPickerValues, fmtMoneySen } from '@2990s/shared';
import { useCreateGrn, usePostGrn } from '../../vendor/scm/lib/grn-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { useActiveCurrencies, rateFor } from '../../vendor/scm/lib/currencies-queries';
import { CurrencySelect } from '../../vendor/scm/components/CurrencySelect';
import { usePurchaseOrderDetail, usePurchaseOrders, useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons, mfgCategoryLabel } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useGrnRackOptions } from '../../vendor/scm/lib/grn-line-rack';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { skuMapFromBindings, supplierCodeFor } from '../../vendor/scm/lib/supplier-doc-data';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { LinePoRefLink } from '../../vendor/scm/components/LinePoRefLink';
import { linePoLink, type LinePoFields } from '../../vendor/scm/lib/line-po-link';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { specialOrderSurface } from '../../vendor/scm/lib/special-order-surface';
import type { GrnFromPoPick } from './GrnFromPo';
import styles from './SalesOrderDetail.module.css';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { notifyAcNotSent } from '../../vendor/scm/lib/ac-not-sent';
import { grnCreatedOutcome } from '../../vendor/scm/lib/grn-create-outcome';
import { PageHeader } from '../../components/Layout';
import { resolveFxRate } from './fx-rate';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';
import { DateField } from "../../vendor/scm/components/DateField";
import { useAuth } from '../../auth/AuthContext';
import { canPostGoodsReceipts } from '../../auth/salesAccess';
import { afterCreatePath, sourceDocPath } from '../../lib/returnToSource';
import { supplierEmailList } from '../../vendor/shared/supplier-emails';
import { FormTouchScope } from '../../components/FormTouchScope';
import { useFormTouched, useLeaveGuard } from '../../hooks/useLeaveGuard';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtAmt = (centi: number | null | undefined): string =>
  ((centi ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => fmtMoneySen(centi ?? 0, currency);

/* Commander 2026-05-29 — "PO 那边根据 Category 会叫我填写我的 Variant，这个
   (GRN) 怎么没有？" Manual GRN lines whose product is a bedframe/sofa now get
   the SAME per-category variant editor as New PO / the PO Edit modal. Small
   local copy of PurchaseOrderDetail's VariantSelect (not exported there). */
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
        <option value=""></option>
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
  rid:               string;
  purchaseOrderItemId: string | null;
  materialKind:      string;
  itemCode:      string;
  materialName:      string;
  /* Owner 2026-07-27 — the SUPPLIER's own code for this SKU: the PO line's
     snapshot (single-PO / picks paths) or the binding's at pick time (manual
     path). Render + create-payload fall back to the live supplier binding when
     null (old PO lines predate the snapshot column — GRN-detail #1217 parity). */
  supplierSku:       string | null;
  itemGroup:         string | null;
  variants:          Record<string, unknown> | null;
  outstanding:       number | null;
  qtyReceived:       number;
  qtyAccepted:       number;
  qtyRejected:       number;
  unitPriceSen:    number;
  notes:             string;
  rackId:            string;
  sourcePo?:         LinePoFields | null;
};

type GrnNewDraft = {
  lines:            DraftLine[];
  picks:            GrnFromPoPick[] | null;
  receivedAt?:      string;
  deliveryNoteRef?: string;
  notes?:           string;
  warehouseId?:     string;
  selPoId?:         string;
  manualSupplierId?: string;
  /* Landed-cost allocation (Phase 1-A) — freight "平摊" basis, survives the
     From-PO picker round trip. */
  allocationMethod?: 'QTY' | 'VALUE' | 'CBM';
  manualCurrency?:  string;
};

export const GrnNew = () => {
  const { user } = useAuth();
  const mayPost = canPostGoodsReceipts(user);
  const navigate = useNavigate();
  const { touched: formTouched, markTouched } = useFormTouched();
  const { allowLeave } = useLeaveGuard(formTouched, null);
  const notify = useNotify();
  const [params] = useSearchParams();

  const [picks, setPicks] = useState<GrnFromPoPick[] | null>(null);
  const pickSupplierId   = picks?.[0]?.supplierId ?? null;
  const pickSupplierName = picks?.[0]?.supplierName ?? picks?.[0]?.supplierCode ?? null;
  const pickPoId         = picks?.[0]?.poId ?? null;
  const hasPicks         = !!picks && picks.length > 0;

  const [selPoId, setSelPoId] = useState<string>(params.get('poId') ?? '');
  const poListQ = usePurchaseOrders();
  const poQ     = usePurchaseOrderDetail(selPoId || null);
  const backToPo = selPoId && selPoId === params.get('poId') ? sourceDocPath.purchaseOrder(selPoId) : null;

  const [manualSupplierId, setManualSupplierId] = useState<string>('');
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;

  // Special Orders pool now comes from special_addons (Backend↔POS parity, Loo
  // 2026-06-08), filtered by category. FULL rows feed the shared SpecialOrders
  // block (owner 2026-07-20 unification) — a manual GRN line now gets the SAME
  // multi-select + choices + Custom/other editor as the SO, writing
  // variants.specials (array), not the legacy single-select variants.special.
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  const outstanding = useMemo(
    () => (poListQ.data ?? []).filter((po) => po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED'),
    [poListQ.data],
  );

  const create = useCreateGrn();
  const idemKey = useIdempotencyKey();
  const post   = usePostGrn();
  const saving = create.isPending || post.isPending;
  const lastCreatedIdRef = useRef<string | null>(null);

  const [receivedAt, setReceivedAt]           = useState<string>(() => todayMyt());
  const [deliveryNoteRef, setDeliveryNoteRef] = useState<string>('');
  const [notes, setNotes]                     = useState<string>('');
  const [exchangeRate, setExchangeRate]       = useState<string>('1');
  const [rateTouched, setRateTouched]         = useState<boolean>(false);
  /* Landed-cost allocation (Phase 1-A) — how a SERVICE-line freight charge
     ("平摊" / transportation) is split across the goods lines into the FIFO lot
     cost: QTY (default) | VALUE | CBM. Sent on create; the server allocates. */
  const [allocationMethod, setAllocationMethod] = useState<'QTY' | 'VALUE' | 'CBM'>('QTY');
  const [manualCurrency, setManualCurrency]   = useState<string>('MYR');
  const [lines, setLines]                     = useState<DraftLine[]>([]);
  const [warehouseId, setWarehouseId]         = useState<string>('');
  const warehousesQ = useWarehouses();
  const racksQ = useGrnRackOptions(warehouseId || undefined);
  const racks = racksQ.racks;
  const [picksResolved, setPicksResolved]     = useState<boolean>(false);
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string; goLabel?: string } | null>(null);

  const readPicksRef = useRef(false);
  useEffect(() => {
    if (readPicksRef.current) return;
    readPicksRef.current = true;

    const newPicks = readScmHandoff<GrnFromPoPick[]>('grnFromPoPicks');
    if (!newPicks) {
      removeScmHandoff('grnNewDraft');
      setPicksResolved(true);
      return;
    }
    removeScmHandoff('grnFromPoPicks');
    markTouched();

    const draft = readScmHandoff<GrnNewDraft>('grnNewDraft');
    removeScmHandoff('grnNewDraft');

    if (draft) {
      if (draft.receivedAt) setReceivedAt(draft.receivedAt);
      if (typeof draft.deliveryNoteRef === 'string') setDeliveryNoteRef(draft.deliveryNoteRef);
      if (typeof draft.notes === 'string') setNotes(draft.notes);
      if (draft.warehouseId) setWarehouseId(draft.warehouseId);
      if (draft.selPoId) setSelPoId(draft.selPoId);
      if (draft.manualSupplierId) setManualSupplierId(draft.manualSupplierId);
      if (draft.allocationMethod) setAllocationMethod(draft.allocationMethod);
      if (draft.manualCurrency) setManualCurrency(draft.manualCurrency);
    }

    const baseLines = (draft?.lines ?? []) as DraftLine[];
    const seen = new Set(baseLines.map((l) => l.purchaseOrderItemId).filter(Boolean) as string[]);
    const pickLines: DraftLine[] = newPicks
      .filter((p) => !seen.has(p.poItemId))
      .map((p) => ({
        rid:                 `p${p.poItemId}`,
        purchaseOrderItemId: p.poItemId,
        materialKind:        'mfg_product',
        itemCode:        p.itemCode,
        supplierSku:         p.supplierSku ?? null,
        materialName:        p.description ?? p.itemCode,
        itemGroup:           p.itemGroup || null,
        variants:            (p.variants as Record<string, unknown> | null) ?? null,
        outstanding:         p.remainingQty,
        qtyReceived:         p._pickQty,
        qtyAccepted:         p._pickQty,
        qtyRejected:         0,
        unitPriceSen:      p.unitPriceSen ?? 0,
        notes:               '',
        rackId:              '',
        sourcePo:            { source_po_id: p.poId, source_po_number: p.poDocNo },
      }));
    setLines([...baseLines, ...pickLines]);

    const pickMap = new Map<string, GrnFromPoPick>();
    for (const p of (draft?.picks ?? [])) pickMap.set(p.poItemId, p);
    for (const p of newPicks) pickMap.set(p.poItemId, p);
    const union = [...pickMap.values()];
    if (union.length) setPicks(union);
    setPicksResolved(true);
  }, []);

  useEffect(() => {
    if (hasPicks) return;
    if (!selPoId) {
      setLines((prev) => prev.length > 0 ? prev : [{
        rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        purchaseOrderItemId: null,
        materialKind:        'mfg_product',
        itemCode:        '',
        materialName:        '',
        supplierSku:         null,
        itemGroup:           null,
        variants:            null,
        outstanding:         null,
        qtyReceived:         1,
        qtyAccepted:         1,
        qtyRejected:         0,
        unitPriceSen:      0,
        notes:               '',
        rackId:              '',
      }]);
      return;
    }
    if (!poQ.data) return;
    const header = poQ.data.purchaseOrder;
    const next: DraftLine[] = poQ.data.items
      .map((it: any) => {
        const outstanding = (it.qty ?? 0) - (it.received_qty ?? 0);
        return {
          rid:               `r${it.id}`,
          purchaseOrderItemId: it.id,
          materialKind:      it.material_kind,
          itemCode:      it.item_code,
          materialName:      it.material_name,
          supplierSku:       (it.supplier_sku as string | null) ?? null,
          itemGroup:         it.item_group ?? null,
          variants:          (it.variants as Record<string, unknown> | null) ?? null,
          outstanding,
          qtyReceived:       outstanding,
          qtyAccepted:       outstanding,
          qtyRejected:       0,
          unitPriceSen:    it.unit_price_sen ?? 0,
          notes:             '',
          rackId:            '',
          sourcePo:          { source_po_id: header.id, source_po_number: header.po_number },
        };
      })
      .filter((l) => (l.outstanding ?? 0) > 0);
    setLines(next);
  }, [poQ.data, selPoId, hasPicks]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const goToFromPo = () => {
    const draft: GrnNewDraft = {
      lines, picks, receivedAt, deliveryNoteRef, notes, warehouseId,
      selPoId, manualSupplierId, allocationMethod, manualCurrency,
    };
    if (!writeScmHandoff('grnNewDraft', draft)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store the current GRN draft. Nothing was discarded; free some browser storage and try again.' });
      return;
    }
    allowLeave();
    navigate('/scm/grns/from-po');
  };

  const subtotalSen = useMemo(
    () => lines.reduce((s, l) => s + l.qtyReceived * l.unitPriceSen, 0),
    [lines],
  );
  const totalQty = lines
    .filter((l) => l.itemCode.trim() && !isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode }))
    .reduce((s, l) => s + l.qtyReceived, 0);

  /* Landed-cost allocation preview (Phase 1-A) — mirror the server math so the
     operator SEES the freight ("平摊") split across goods lines before posting.
     The charge pool = Σ SERVICE-line values; the per-line allocated freight uses
     the chosen basis (QTY / VALUE / CBM). All in the GRN currency for display
     (the server stores MYR via the exchange rate). Keyed by rid. */
  const allocPreview = useMemo(() => {
    const isSvc = (l: DraftLine) => isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode });
    const goods = lines.filter((l) => l.itemCode.trim() && !isSvc(l));
    const chargePool = lines
      .filter((l) => l.itemCode.trim() && isSvc(l))
      .reduce((s, l) => s + l.qtyReceived * l.unitPriceSen, 0);
    const basisOf = (l: DraftLine): number => {
      if (allocationMethod === 'VALUE') return l.qtyReceived * l.unitPriceSen;
      if (allocationMethod === 'CBM') return l.qtyReceived;
      return l.qtyReceived;
    };
    let sumBasis = goods.reduce((s, l) => s + basisOf(l), 0);
    if (sumBasis <= 0) sumBasis = goods.reduce((s, l) => s + l.qtyReceived, 0);
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
    return { chargePool, allocByRid };
  }, [lines, allocationMethod]);

  const po       = poQ.data?.purchaseOrder;
  const isManual = !hasPicks && !selPoId;

  const supplierId =
    hasPicks   ? pickSupplierId
    : po       ? po.supplier_id
    : isManual ? (manualSupplierId || null)
    : null;
  const supplierName =
    hasPicks   ? pickSupplierName
    : po       ? (po.supplier?.name ?? po.supplier?.code ?? null)
    : isManual ? ((suppliersQ.data ?? []).find((s) => s.id === manualSupplierId)?.name ?? null)
    : null;
  const headerPoId = hasPicks ? pickPoId : (po?.id ?? null);
  /* Owner 2026-09-10 — the free "Add another item" affordance is no longer
     manual-only. A from-PO-picks / single-PO GRN can also receive an EXTRA item
     the PO never ordered (a supplier freebie, a sample) in the SAME create step,
     instead of saving first and adding it on the detail page. The server's
     unlinked-PO guard still refuses a hand-added line whose material IS on the
     header PO. Gated on a resolved supplier so the binding-aware picker has one;
     manual mode keeps showing it even before a supplier is chosen. */
  const canAddManualLine = isManual || !!supplierId;
  const poCurrency     = (po?.currency as string | undefined) ?? null;
  const currencyLocked = !!poCurrency;
  const currency       = poCurrency ?? manualCurrency;
  const isForeign  = String(currency).toUpperCase() !== 'MYR';
  const rateNum    = resolveFxRate(exchangeRate);
  const currenciesQ = useActiveCurrencies();
  useEffect(() => {
    if (!isForeign) { setExchangeRate('1'); setRateTouched(false); return; }
    if (rateTouched) return;
    setExchangeRate(String(rateFor(currenciesQ.data, String(currency).toUpperCase())));
  }, [isForeign, currency, currenciesQ.data, rateTouched]);

  const supplierDetailQ = useSupplierDetail(supplierId);
  const bindings        = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  /* Owner 2026-07-27 — per-line Supplier SKU, snapshot-first (the PO line's /
     binding-pick's code on the DraftLine), else the LIVE binding for this
     supplier + internal code (#1217 GRN-detail parity — covers PO lines raised
     before the snapshot column). Null when neither resolves; shown as '—' and
     omitted from the create payload. */
  const skuByMaterialCode = useMemo(() => skuMapFromBindings(bindings), [bindings]);
  const supplierSkuOf = (l: DraftLine): string | null => {
    const code = supplierCodeFor(
      { item_code: l.itemCode, supplier_sku: l.supplierSku },
      skuByMaterialCode,
    );
    return code === '—' ? null : code;
  };
  const supplier        = supplierDetailQ.data?.supplier ?? null;

  useEffect(() => {
    if (warehouseId) return;
    if (!picksResolved) return;
    const pickLoc = hasPicks
      ? (picks?.find((p) => p.warehouseLocationId)?.warehouseLocationId ?? null)
      : null;
    const poLoc = (po as { purchase_location_id?: string | null } | undefined)?.purchase_location_id ?? null;
    // Owner 2026-07-15 (2990 parity): when neither the picks nor the PO resolve a
    // warehouse, default to the is_default warehouse — NEVER warehousesQ.data[0],
    // which is the China/transit warehouse by code-sort and silently receives stock
    // into the wrong place (real MY warehouse still shows the shortage in MRP).
    const safeDefault = warehousesQ.data?.find((w) => w.is_default)?.id ?? warehousesQ.data?.[0]?.id ?? '';
    const fallback = pickLoc ?? poLoc ?? safeDefault;
    if (fallback) setWarehouseId(fallback);
  }, [warehouseId, picksResolved, hasPicks, picks, po, warehousesQ.data]);

  const [productQuery, setProductQuery] = useState<string>('');
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: debouncedProductQuery.trim().length >= 2,
  });

  const allSkusQ = useMfgProducts({ enabled: !!supplierId && lines.some((l) => l.purchaseOrderItemId === null) });
  const categoryForCode = (code: string): string | undefined => {
    const sku = (allSkusQ.data ?? []).find((p) => p.code === code);
    return sku?.category ? sku.category.toLowerCase() : undefined;
  };

  const addEmptyManualLine = () => {
    setLines((prev) => [...prev, {
      rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      purchaseOrderItemId: null,
      materialKind:        'mfg_product',
      itemCode:        '',
      materialName:        '',
      supplierSku:         null,
      itemGroup:           null,
      variants:            null,
      outstanding:         null,
      qtyReceived:         1,
      qtyAccepted:         1,
      qtyRejected:         0,
      unitPriceSen:      0,
      notes:               '',
      rackId:              '',
    }]);
  };

  const pickItemForLine = (rid: string, code: string) => {
    const sku = (productsQ.data ?? []).find((p) => p.code === code);
    setLine(rid, {
      itemCode: code,
      materialName: sku?.name ?? code,
      supplierSku:  null,
      itemGroup:    sku?.category ? sku.category.toLowerCase() : null,
    });
  };

  // Commander 2026-05-29 — supplier-bound pick (New PO parity): when a supplier
  // is chosen and the typed/picked code matches one of THAT supplier's
  // bindings, fill name + UNIT PRICE (from the binding) + itemGroup + the
  // supplier's own SKU (owner 2026-07-27). Category is resolved from the full
  // catalogue (categoryForCode) since bindings carry no category.
  const pickBindingForLine = (rid: string, b: typeof bindings[number]) => {
    setLine(rid, {
      itemCode:   b.item_code,
      materialName:   b.material_name,
      supplierSku:    b.supplier_sku ?? null,
      unitPriceSen: b.unit_price_sen,
      itemGroup:      categoryForCode(b.item_code) ?? null,
    });
  };

  const canSave = !!supplierId && lines.length > 0 &&
    lines.every((l) => l.qtyReceived >= 0);

  const onSave = async (asDraft = false) => {
    if (!supplierId) {
      setDialog({ title: 'Pick a supplier', body: hasPicks
        ? 'The picks are missing a supplier — go back to the picker and try again.'
        : 'Choose the PO you are receiving against, or pick a supplier for a manual receipt.' });
      return;
    }
    const realLines = lines.filter((l) => l.itemCode.trim());
    if (realLines.length === 0) {
      setDialog({ title: 'Add at least one item', body: 'Pick at least one SKU to receive.' });
      return;
    }
    if (!canSave) {
      setDialog({ title: 'Check the quantities', body: 'Each line must have a received qty of 0 or more.' });
      return;
    }
    try {
      const createRes = await create.mutateAsync({
        idempotencyKey: idemKey,
        purchaseOrderId: headerPoId,
        supplierId,
        asDraft,
        warehouseId:     warehouseId || undefined,
        receivedAt,
        deliveryNoteRef: deliveryNoteRef || undefined,
        notes:           notes || undefined,
        currency,
        exchangeRate:    isForeign ? rateNum : 1,
        // Landed-cost allocation (Phase 1-A) — the freight "平摊" basis.
        allocationMethod,
        items: realLines.map((l) => ({
          purchaseOrderItemId: l.purchaseOrderItemId,
          materialKind:        l.materialKind,
          itemCode:        l.itemCode,
          materialName:        l.materialName,
          // Owner 2026-07-27 — persist the supplier's own code exactly as the
          // form showed it (snapshot-first, else live binding) so the GRN line
          // reconciles against the supplier's delivery note (grn_items.supplier_sku).
          supplierSku:         supplierSkuOf(l) ?? undefined,
          qtyReceived:         l.qtyReceived,
          qtyAccepted:         l.qtyReceived,
          qtyRejected:         0,
          unitPriceSen:      l.unitPriceSen,
          notes:               l.notes || undefined,
          itemGroup:           l.itemGroup,
          variants:            l.variants,
          rackId:              l.rackId || undefined,
        })),
      });
      const isReplay = lastCreatedIdRef.current === createRes.id;
      lastCreatedIdRef.current = createRes.id;
      if (!asDraft) await post.mutateAsync(createRes.id);
      if (isReplay) {
        allowLeave();
        setDialog({
          title: `GRN ${createRes.grnNumber} was already created`,
          body: 'This submit repeated the earlier one — the same receipt was answered again and no second GRN or stock movement was written. '
            + 'If another batch of the same goods has arrived, start a fresh receipt via Transfer from Purchase Order.',
          goTo: `/scm/grns/${createRes.id}`,
        });
        return;
      }
      await notifyAcNotSent(notify, createRes, 'Goods receipt');
      allowLeave();
      setDialog({
        ...grnCreatedOutcome(createRes.grnNumber, asDraft, createRes),
        goTo: afterCreatePath(`/scm/grns/${createRes.id}`, backToPo),
        goLabel: backToPo ? 'Back to PO' : undefined,
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
        title={`New Goods Receipt${po?.po_number ? ` · ${po.po_number}` : ''}`}
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={goToFromPo}>
              <ArrowRightLeft {...ICON} /> From Purchase Order
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/grns')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="ghost" size="md" onClick={() => onSave(true)} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Save as Draft'}
            </Button>
            {mayPost && (
              <Button variant="primary" size="md" onClick={() => onSave(false)} disabled={saving}>
                <Save {...ICON} />
                {saving ? 'Saving…' : 'Create Goods Receipt'}
              </Button>
            )}
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            {hasPicks ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Receiving from PO picks</span>
                <input
                  type="text"
                  readOnly
                  value={`${picks!.length} line${picks!.length === 1 ? '' : 's'} from ${[...new Set(picks!.map((p) => p.poDocNo))].join(', ')}`}
                  className={styles.fieldInput}
                  style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                />
              </label>
            ) : (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Receive against PO</span>
                <SearchableSelect
                  className={styles.fieldInput}
                  value={selPoId}
                  onChange={setSelPoId}
                  disabled={poListQ.isLoading || outstanding.length === 0}
                  placeholder={poListQ.isLoading ? 'Loading POs…'
                    : outstanding.length === 0 ? 'No outstanding POs — receive manually below'
                    : '— Pick an outstanding PO (or leave blank for a manual receipt) —'}
                  options={[
                    { value: '', label: '— Manual receipt (no PO) —' },
                    ...sortByText(outstanding).map((p) => ({
                      value: p.id,
                      label: `${p.po_number} · ${p.supplier?.name ?? p.supplier?.code ?? '—'} · ${fmtDateOrDash(p.po_date)}${p.status === 'PARTIALLY_RECEIVED' ? ' (partial)' : ''}`,
                    })),
                  ]}
                />
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>GRN #</span>
              <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>

            <label className={styles.field}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Supplier <span className={styles.req}>*</span>{hasPicks ? ' (from picks)' : ''}</span>
              {isManual ? (
                <SearchableSelect
                  className={styles.fieldInput}
                  value={manualSupplierId}
                  onChange={setManualSupplierId}
                  disabled={suppliersQ.isLoading}
                  placeholder={suppliersQ.isLoading ? 'Loading suppliers…' : '— Pick a supplier —'}
                  options={sortByText(suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
                />
              ) : (
                <input type="text" readOnly value={supplierName ?? '(auto-filled from PO)'} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                type="text"
                readOnly
                value={supplier?.name ?? supplierName ?? ''}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Address</span>
              <textarea
                readOnly
                value={[supplier?.address, supplier?.area, supplier?.postcode, supplier?.state, supplier?.country]
                  .filter(Boolean).join(', ')}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)', minHeight: 52, resize: 'vertical' }}
                rows={3}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Receive into *</span>
              <SearchableSelect
                className={styles.fieldInput}
                value={warehouseId}
                onChange={setWarehouseId}
                disabled={warehousesQ.isLoading}
                placeholder={warehousesQ.isLoading ? 'Loading warehouses…' : '— Pick a warehouse —'}
                options={sortByText(warehousesQ.data ?? []).map((w) => ({ value: w.id, label: w.code }))}
              />
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                Warehouse the received stock moves into.
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Received Date</span>
              <DateField fullWidth value={receivedAt} onChange={(iso) => setReceivedAt(iso)} className={styles.fieldInput}/>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Note Ref</span>
              <input type="text" value={deliveryNoteRef} onChange={(e) => setDeliveryNoteRef(e.target.value)} placeholder="Supplier's DN # (optional)" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Receiving notes — visible on the GRN detail page" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
            </label>

            <CurrencySelect
              currency={currency}
              onCurrencyChange={setManualCurrency}
              exchangeRate={exchangeRate}
              onRateChange={(v) => { setRateTouched(true); setExchangeRate(v); }}
              disabled={currencyLocked}
              rateHint={<>≈ {fmtRm(Math.round(subtotalSen * rateNum), 'MYR')} recorded as inventory cost</>}
              styles={styles}
            />
            {/* Landed-cost allocation — choose how a SERVICE-line freight charge
                ("平摊" / transportation) is spread across the goods lines into
                their FIFO lot cost. Always selectable so it's set before posting. */}
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
                  {fmtRm(allocPreview.chargePool, currency)} freight spread across {lines.filter((l) => l.itemCode.trim() && !isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode })).length} goods line(s)
                </span>
              )}
            </label>
          </div>

          {supplier && (
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
              {supplier.contact_person && <span>Contact: <strong>{supplier.contact_person}</strong></span>}
              {supplier.phone          && <span>Phone: <strong>{formatPhone(supplier.phone)}</strong></span>}
              {supplierEmailList(supplier).length > 0          && <span>Email: <strong>{supplierEmailList(supplier).join(", ")}</strong></span>}
              {supplier.payment_terms  && <span>Terms: <strong>{supplier.payment_terms}</strong></span>}
              <span>Currency: <strong>{supplier.currency ?? currency}</strong></span>
            </div>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {hasPicks
              ? `${lines.length} line${lines.length === 1 ? '' : 's'} from picks · subtotal ${fmtRm(subtotalSen, currency)}`
              : selPoId
                ? (poQ.isLoading
                    ? 'Loading PO items…'
                    : poQ.isError
                      ? "We couldn't load this PO's lines — please refresh and try again."
                      : lines.length === 0
                        ? 'No outstanding lines came back for this PO. Open the purchase order and check its balance before treating it as received in full.'
                        : `${lines.length} line${lines.length === 1 ? '' : 's'} · subtotal ${fmtRm(subtotalSen, currency)}`)
                : lines.length === 0
                  ? 'Manual receipt — pick a supplier above, then add items below'
                  : `${lines.length} line${lines.length === 1 ? '' : 's'} · subtotal ${fmtRm(subtotalSen, currency)}`}
            {isManual && supplierId && (
              <span style={{ display: 'block', marginTop: 2, color: 'var(--c-burnt)' }}>
                {bindings.length > 0
                  ? `${bindings.length} item${bindings.length === 1 ? '' : 's'} bound to this supplier — picker filters to these`
                  : 'No SKUs bound to this supplier yet — picker shows all SKUs (one-off receipt)'}
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3) 0' }}>
              {isManual
                ? 'Pick a supplier in the header, then use “Add line” below to receive items by hand. Receiving against a PO? Pick one in the header, or use '
                : 'Choose a Purchase Order in the header to receive against it. Receiving lines from several POs at once? Use '}
              <button type="button" onClick={goToFromPo} style={{ background: 'none', border: 'none', color: 'var(--c-orange)', cursor: 'pointer', padding: 0, font: 'inherit' }}>From Purchase Order</button>.
            </p>
          ) : (
            /* Card-per-line layout — Commander 2026-05-29: "PO 跟 GRN 界面要一样".
               Mirrors PurchaseOrderNew's ITEMS: each line is a bordered card with
               LINE N + category pill + line value + remove at top, an inline item
               picker (manual) / read-only code (PO-sourced), description, the
               per-category variant editor, then a fields row. */
            lines.map((l, idx) => {
              const lineValueSen = l.qtyReceived * l.unitPriceSen;
              const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
              const lineIsSvc = isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode });
              const lineAllocSen = allocPreview.allocByRid.get(l.rid) ?? 0;
              const landedUnitSen = l.unitPriceSen + (l.qtyReceived > 0 ? Math.round(lineAllocSen / l.qtyReceived) : 0);
              const cap = l.outstanding;
              const isManualLine = l.purchaseOrderItemId === null;
              const showVariantEditor =
                isManualLine &&
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

              return (
                <div data-grid-row
                  key={l.rid}
                  style={{
                    background: 'var(--c-paper)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--radius-lg)',
                    padding: 'var(--space-4)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <span style={{
                        fontFamily: 'var(--font-button)',
                        fontSize: 'var(--fs-12)',
                        fontWeight: 700,
                        letterSpacing: '0.10em',
                        color: 'var(--fg-muted)',
                      }}>
                        LINE {idx + 1}
                      </span>
                      {l.itemGroup && <ItemGroupPill group={l.itemGroup} />}
                      {l.sourcePo && linePoLink(l.sourcePo) && (
                        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                          From PO <LinePoRefLink line={l.sourcePo} />
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                        <span className={styles.previewPrice}>{fmtRm(lineValueSen, currency)}</span>
                        {isForeign && (
                          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                            ≈ {fmtRm(Math.round(lineValueSen * rateNum), 'MYR')}
                          </span>
                        )}
                        {allocPreview.chargePool > 0 && !lineIsSvc && (
                          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--c-accent, #8a6d3b)', marginTop: 2 }}>
                            +{fmtRm(lineAllocSen, currency)} freight · landed {fmtRm(landedUnitSen, currency)}/unit
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => dropLine(l.rid)}
                        title="Remove line"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))',
                          padding: 4,
                          display: 'inline-flex',
                        }}
                      >
                        <Trash2 {...ICON} />
                      </button>
                    </div>
                  </div>

                  {/* Identity row — Item Code (Internal) + Supplier SKU +
                      Description (owner 2026-07-27: the supplier's code must
                      show on the receiving line, PO/GRN-detail parity). */}
                  <div className={styles.formGrid3}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Item Code (Internal)</span>
                      {isManualLine ? (
                        <>
                          <input
                            type="text"
                            list={`grn-products-${l.rid}`}
                            value={l.itemCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setProductQuery(code);
                              const bound = supplierId
                                ? bindings.find((b) => b.item_code === code)
                                : undefined;
                              if (bound) { pickBindingForLine(l.rid, bound); return; }
                              const match = (productsQ.data ?? []).find((p) => p.code === code);
                              if (match) { pickItemForLine(l.rid, code); return; }
                              setLine(l.rid, { itemCode: code, supplierSku: null });
                            }}
                            placeholder={supplierId && bindings.length > 0
                              ? 'Pick one of this supplier’s bound SKUs…'
                              : 'Type ≥2 chars to search SKUs by code or name…'}
                            className={styles.fieldInput}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                          <datalist id={`grn-products-${l.rid}`}>
                            {supplierId && bindings.length > 0
                              ? sortByText(bindings).map((b) => (
                                  <option key={b.id} value={b.item_code}>
                                    {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_sen, b.currency)}
                                  </option>
                                ))
                              : sortByText(productsQ.data ?? []).map((p) => (
                                  <option key={p.id} value={p.code}>{p.name} · {mfgCategoryLabel(p.category)}</option>
                                ))}
                          </datalist>
                        </>
                      ) : (
                        <input
                          type="text"
                          readOnly
                          value={l.itemCode}
                          className={styles.fieldInput}
                          style={{ fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Supplier SKU</span>
                      <input
                        type="text"
                        readOnly
                        value={supplierSkuOf(l) ?? '—'}
                        className={styles.fieldInput}
                        style={{ fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Description</span>
                      <input
                        type="text"
                        value={l.materialName}
                        onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                        readOnly={!isManualLine}
                        placeholder={isManualLine ? '(auto-filled when an item is picked — editable)' : ''}
                        className={styles.fieldInput}
                        style={!isManualLine ? { background: 'var(--c-cream)', color: 'var(--fg-muted)' } : undefined}
                      />
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
                      />
                    </div>
                  )}
                  {showVariantEditor && (
                    <div style={{
                      background: 'var(--c-cream)',
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-3)',
                    }}>
                      <div style={{
                        fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700,
                        letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)',
                        marginBottom: 'var(--space-2)',
                      }}>{l.itemGroup} Variants</div>
                      {l.itemGroup === 'bedframe' ? (
                        <div className={styles.formGrid4}>
                          <VariantSelect label="Divan Height" options={activeOptions(maint!.divanHeights, String(l.variants?.divanHeight ?? ''))}
                            value={String(l.variants?.divanHeight ?? '')}
                            onChange={(v) => setVariant('divanHeight', v)} />
                          <VariantSelect label="Gap"
                            options={maintPickerValues(maint!.gaps, String(l.variants?.gap ?? '')).map((g) => ({ value: g, priceSen: 0 }))}
                            value={String(l.variants?.gap ?? '')}
                            onChange={(v) => setVariant('gap', v)} />
                          <VariantSelect label="Leg Height" options={activeOptions(maint!.legHeights, String(l.variants?.legHeight ?? ''))}
                            value={String(l.variants?.legHeight ?? '')}
                            onChange={(v) => setVariant('legHeight', v)} />
                          {/* Total Heights removed — auto-computed from Divan +
                              Leg + Gap (see setVariant). Special Orders moved to
                              the shared block below (owner 2026-07-20). */}
                        </div>
                      ) : (
                        <div className={styles.formGrid4}>
                          <VariantSelect label="Seat Size"
                            options={maintPickerValues(maint!.sofaSizes, String(l.variants?.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 }))}
                            value={String(l.variants?.seatHeight ?? '')}
                            onChange={(v) => setVariant('seatHeight', v)} />
                          <VariantSelect label="Leg Height" options={activeOptions(maint!.sofaLegHeights, String(l.variants?.legHeight ?? ''))}
                            value={String(l.variants?.legHeight ?? '')}
                            onChange={(v) => setVariant('legHeight', v)} />
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Fabrics (free text)</span>
                            <input className={styles.fieldInput}
                              value={String(l.variants?.fabricColor ?? '')}
                              onChange={(e) => setVariant('fabricColor', e.target.value)} />
                          </label>
                        </div>
                      )}
                      {/* Special Orders — shared editor (owner 2026-07-20). A
                          manual GRN line is not parent-linked, so it is directly
                          editable and writes variants.specials (array). */}
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

                  <div className={styles.formGrid4}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Outstanding</span>
                      <input
                        type="text"
                        readOnly
                        value={cap ?? '—'}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Received</span>
                      <input type="number" min={0} max={cap ?? undefined} value={l.qtyReceived}
                        onChange={(e) => {
                          let v = Math.max(0, Number(e.target.value) || 0);
                          if (cap != null) v = Math.min(cap, v);
                          setLine(l.rid, { qtyReceived: v, qtyAccepted: v, qtyRejected: 0 });
                        }}
                        className={styles.fieldInput} style={{ textAlign: 'right' }} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                      <MoneyInput bare valueSen={l.unitPriceSen}
                        onCommit={(sen) => setLine(l.rid, { unitPriceSen: sen ?? 0 })}
                        inputClassName={styles.fieldInput} selectOnFocus />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Line Value</span>
                      <input
                        type="text"
                        readOnly
                        value={fmtRm(lineValueSen, currency)}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Rack</span>
                      <SearchableSelect
                        className={styles.fieldInput}
                        value={l.rackId}
                        onChange={(v) => setLine(l.rid, { rackId: v })}
                        disabled={!warehouseId || racksQ.isLoading || racks.length === 0}
                        ariaLabel={`Rack for line ${idx + 1}`}
                        placeholder={!warehouseId ? '— Pick a warehouse first —'
                          : racksQ.isLoading ? 'Loading racks…'
                          : racks.length === 0 ? 'No racks in this warehouse'
                          : '— No rack — (type to search)'}
                        options={[
                          ...(l.rackId ? [{ value: '', label: '— No rack —' }] : []),
                          ...racksQ.options,
                        ]}
                      />
                    </label>
                  </div>
                </div>
              );
            })
          )}

          {/* "Add another item" — a hand-added extra line. Shown in every mode
              now (owner 2026-09-10): manual, from-PO-picks, and single-PO, so an
              item the PO never ordered can be received in the same create step. */}
          {canAddManualLine && (
            <AddLineButton variant="block" onClick={addEmptyManualLine} />
          )}

        </div>
      </section>

      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 640, width: '100%' }}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Line Summary</h2>
          </div>
          <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-12)', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ textAlign: 'left', fontWeight: 600, padding: '6px 8px 6px 0' }}>Item Code</th>
                  <th style={{ textAlign: 'right', fontWeight: 600, padding: '6px 8px' }}>Qty</th>
                  <th style={{ textAlign: 'right', fontWeight: 600, padding: '6px 8px' }}>Unit Price ({currency})</th>
                  <th style={{ textAlign: 'right', fontWeight: 600, padding: '6px 0 6px 8px' }}>Subtotal</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: 'var(--font-mono)' }}>
                {lines.filter((l) => l.itemCode.trim()).map((l) => (
                  <tr key={l.rid} style={{ borderBottom: '1px dashed var(--line)' }}>
                    <td style={{ padding: '6px 8px 6px 0', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.itemCode}>{l.itemCode}</td>
                    <td style={{ textAlign: 'right', padding: '6px 8px' }}>{l.qtyReceived}</td>
                    <td style={{ textAlign: 'right', padding: '6px 8px' }}>{fmtAmt(l.unitPriceSen)}</td>
                    <td style={{ textAlign: 'right', padding: '6px 0 6px 8px' }}>{fmtAmt(l.qtyReceived * l.unitPriceSen)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot style={{ fontFamily: 'var(--font-mono)' }}>
                <tr style={{ borderTop: '2px solid var(--line)' }}>
                  <td style={{ padding: '8px 8px 4px 0', fontFamily: 'var(--font-sans, inherit)', fontWeight: 600 }}>Total Quantity</td>
                  <td style={{ textAlign: 'right', padding: '8px 8px 4px', fontWeight: 700 }}>{totalQty}</td>
                  <td colSpan={2} />
                </tr>
                <tr style={{ fontSize: 'var(--fs-16)', fontWeight: 700 }}>
                  <td colSpan={3} style={{ padding: '4px 8px 4px 0', fontFamily: 'var(--font-sans, inherit)' }}>Total Amount</td>
                  <td style={{ textAlign: 'right', padding: '4px 0 4px 8px', whiteSpace: 'nowrap' }}>{fmtRm(subtotalSen, currency)}</td>
                </tr>
              </tfoot>
            </table>
            {isForeign && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', marginTop: 'var(--space-2)' }}>
                <span>Inventory cost (MYR)</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(Math.round(subtotalSen * rateNum), 'MYR')}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? (dialog.goLabel ?? 'Open GRN') : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          /* Owner 2026-08-13 ("need create the new GRN for like this also") — the
             receiving loop keys one GRN per delivery back-to-back, so success
             offers a one-click start on the next one, mirroring the Purchase
             Invoice dialog's "New Purchase Invoice".

             IT MUST GO TO THE PICKER, NOT BACK TO /scm/grns/new. This page mints
             ONE idempotency key per mount and deliberately survives success (see
             the idemKey block above): navigating to the route we are already on
             is a no-op for the router, so the page would NOT remount, the key
             would NOT rotate, and an operator keying a genuinely DIFFERENT
             receipt would silently get the first GRN replayed instead of a
             second document. The from-PO picker remounts this page with a fresh
             key — which that same block already names as the sanctioned route
             for a genuinely different receipt. A button that looked right and
             quietly replayed a stock-in is precisely the bug that comment was
             written to prevent. */
          secondaryLabel={dialog.goTo ? 'New GRN' : undefined}
          onSecondary={dialog.goTo ? () => { setDialog(null); navigate('/scm/grns/from-po'); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
    </FormTouchScope>
  );
};
