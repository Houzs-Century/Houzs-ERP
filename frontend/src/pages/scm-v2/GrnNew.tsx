// ----------------------------------------------------------------------------
// GrnNew — full-page Create Goods Receipt at /grns/new.
//
// Commander 2026-05-29: New GRN must work like New PO — land straight on a
// fillable FORM (header + line items) you can complete directly. Three ways in:
//
//   1. Single PO dropdown (or ?poId= deep link from a PO detail "Receive
//      Goods") → its outstanding lines load into the items grid.
//   2. "From PO (multi)" picker (/grns/from-po) → multi-select PO lines across
//      one supplier, stashed in the scoped `grnFromPoPicks` handoff, which this
//      form reads ONCE on mount and loads as lines (supplier locked, header
//      purchaseOrderId = first pick's PO id; each line keeps its own
//      purchase_order_item_id so received_qty rolls up to every source PO).
//   3. Manual / blank GRN — no PO at all: pick a supplier, search products,
//      add line items by hand. Saves with purchaseOrderId:null + each item
//      purchaseOrderItemId:null (server writes inventory-IN, skips PO rollup).
//
// POST /grns creates the row POSTED directly (rolls received_qty onto the PO +
// writes inventory_movements inline). Adjust qty received/accepted/rejected per
// line → Receive & Post.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/GrnNew.tsx. Import boundary
// only: react-router → react-router-dom; GRN create/post hooks → vendored
// grn-queries; suppliers/mfg-products/inventory/warehouse/category-badges/dates +
// the GrnFromPoPick type → ../../vendor/scm/* (the type stays colocated in
// ./GrnFromPo); nav repointed to /scm/grns.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Save, Trash2, X, ArrowRightLeft, ChevronDown } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { activeOptions, buildVariantSummary, fmtDateOrDash, isServiceLine, maintPickerValues } from '@2990s/shared';
import { useCreateGrn, usePostGrn } from '../../vendor/scm/lib/grn-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { useActiveCurrencies, rateFor } from '../../vendor/scm/lib/currencies-queries';
import { CurrencySelect } from '../../vendor/scm/components/CurrencySelect';
import { usePurchaseOrderDetail, usePurchaseOrders, useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useRacks } from '../../vendor/scm/lib/warehouse-queries';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import type { GrnFromPoPick } from './GrnFromPo';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { resolveFxRate } from './fx-rate';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* Commander 2026-05-29 — bedframe Total Height is AUTO-COMPUTED = Divan + Leg +
   Gap (mirrors SoLineCard); it is NOT a manual pick. */
const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

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
        {/* Empty option keeps the variant unset — blank label (no confusing dash). */}
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
  materialCode:      string;
  materialName:      string;
  /* Commander 2026-05-29 — GRN must show WHAT is being received (carry the
     PO line's category + variant selections, exactly like the PO shows). */
  itemGroup:         string | null;
  variants:          Record<string, unknown> | null;
  /** Outstanding qty for PO-linked lines; for manual lines there's no cap so
      this is null (the qty inputs go uncapped). */
  outstanding:       number | null;
  qtyReceived:       number;
  qtyAccepted:       number;
  qtyRejected:       number;
  unitPriceCenti:    number;
  notes:             string;
  /* Commander 2026-06-04 — optional per-line destination Rack (warehouse-scoped).
     Persists to grn_items.rack_id when the create payload forwards rackId. */
  rackId:            string;
};

/* Stashed to sessionStorage before leaving for the From-PO-multi picker, so the
   in-progress GRN draft (lines + header) survives the round trip AND the picker
   can grey-out / cap PO lines this draft already holds (anti-double-pick). */
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
  /* Multi-currency (Phase 1-A) — the manually-chosen currency for a GRN whose
     currency isn't dictated by a source PO. */
  manualCurrency?:  string;
};

export const GrnNew = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // ── From-PO-multi picks (Commander 2026-05-29) — read ONCE on mount.
  //    When present, they drive the form: lines pre-loaded, supplier locked,
  //    header purchaseOrderId = first pick's PO id. ────────────────────────
  const [picks, setPicks] = useState<GrnFromPoPick[] | null>(null);
  const pickSupplierId   = picks?.[0]?.supplierId ?? null;
  const pickSupplierName = picks?.[0]?.supplierName ?? picks?.[0]?.supplierCode ?? null;
  const pickPoId         = picks?.[0]?.poId ?? null;
  const hasPicks         = !!picks && picks.length > 0;

  // Inline single-PO picker (drives the form when there are no picks).
  const [selPoId, setSelPoId] = useState<string>(params.get('poId') ?? '');
  const poListQ = usePurchaseOrders();
  const poQ     = usePurchaseOrderDetail(selPoId || null);

  // Manual-mode supplier (Commander 2026-05-29 — blank GRN, no PO).
  const [manualSupplierId, setManualSupplierId] = useState<string>('');
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  // Commander 2026-05-29 — maintenance config drives the per-category variant
  // editor on MANUAL bedframe/sofa lines (same dropdown pools as New PO / the
  // PO Edit modal: divan/leg/total height, gap, special, seat size, fabric).
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
  /* One key for the one receipt this page is open to raise (lib/idempotency.ts).
     Minted once by useState's lazy init, so it is stable across re-renders and
     across a re-press after a stalled submit.

     This page is the one create surface in the set that does NOT navigate on
     success — it shows ActionResultDialog and stays mounted — so the reasoning
     is spelled out rather than inherited:

     WHY STABLE IS RIGHT HERE. The submit is TWO calls: create, then (non-draft)
     `post.mutateAsync(createRes.id)` — both inside one try. If the POST fails,
     the catch shows "Save failed" WHILE THE GRN ALREADY EXISTS, so a re-press is
     not hypothetical, it is invited by the copy. With a stable key that re-press
     REPLAYS the first grnNumber and re-runs post on the SAME id (itself an
     idempotent no-op when already POSTED — see usePostGrn); without one it books
     the stock IN a second time. This is exactly the case lib/idempotency.ts
     refuses to rotate a key for, and it is live here rather than theoretical.

     THE RESIDUAL, STATED. Because the mount outlives the document, an operator
     who closes the success dialog, re-authors the lines and submits AGAIN gets
     the first GRN replayed — one document, not two. Accepted, not overlooked:
     the lines are not reset on success, so a re-press submits the SAME goods and
     replay is the correct answer; raising a genuinely different receipt goes
     through the picker route (/scm/grns/from-po), which remounts this page and
     mints a new key. It is also not silent — the dialog names the FIRST GRN's
     number. Fixing the residual properly means retiring the key only after the
     whole create+post sequence lands, which needs a rotate() that
     lib/idempotency.ts deliberately does not have; not worth inventing here for
     a path the picker already covers. */
  const idemKey = useIdempotencyKey();
  const post   = usePostGrn();
  const saving = create.isPending || post.isPending;

  const [receivedAt, setReceivedAt]           = useState<string>(() => todayMyt());
  const [deliveryNoteRef, setDeliveryNoteRef] = useState<string>('');
  const [notes, setNotes]                     = useState<string>('');
  /* Landed-cost core (Phase 1-A) — MYR per 1 unit of the GRN currency, kept as a
     string so the numeric input stays editable. Shown only for a foreign
     currency; MYR receives 1:1. The rate converts the FIFO lot cost to MYR. */
  const [exchangeRate, setExchangeRate]       = useState<string>('1');
  /* Track a manual rate edit so the currency-master auto-fill stops overwriting it. */
  const [rateTouched, setRateTouched]         = useState<boolean>(false);
  /* Landed-cost allocation (Phase 1-A) — how a SERVICE-line freight charge
     ("平摊" / transportation) is split across the goods lines into the FIFO lot
     cost: QTY (default) | VALUE | CBM. Sent on create; the server allocates. */
  const [allocationMethod, setAllocationMethod] = useState<'QTY' | 'VALUE' | 'CBM'>('QTY');
  /* Multi-currency (Phase 1-A) — the currency for a GRN NOT dictated by a source
     PO (manual / from-picks). A PO-linked GRN locks to the PO's currency
     (resolved below) and the server re-derives it, so this is ignored there. */
  const [manualCurrency, setManualCurrency]   = useState<string>('MYR');
  const [lines, setLines]                     = useState<DraftLine[]>([]);
  /* Commander 2026-05-29 — New GRN must mirror New PO's header, including a
     "Receive into" Warehouse picker (PO calls it Purchase Location). The chosen
     warehouse threads into the create payload (warehouseId) → grns.ts sets it on
     the header so the inventory-IN movement lands there. */
  const [warehouseId, setWarehouseId]         = useState<string>('');
  const warehousesQ = useWarehouses();
  /* Commander 2026-06-04 — racks of the chosen "Receive into" warehouse, for the
     optional per-line Rack picker. Racks are warehouse-scoped, so this re-queries
     whenever the header warehouse changes; gated until a warehouse is chosen. */
  const racksQ = useRacks({ warehouseId: warehouseId || undefined });
  const racks = useMemo(() => racksQ.data?.racks ?? [], [racksQ.data?.racks]);
  /* True once the on-mount From-PO picks restore has run (whether or not picks
     were found). The warehouse-default effect MUST wait for this — otherwise it
     races the async restore: on first render hasPicks is false simply because
     the picks haven't loaded yet, and defaulting to warehousesQ.data[0] then
     LOCKS the GRN to the wrong (first) warehouse, which the picks' real
     warehouse can never override (the `if (warehouseId) return` guard blocks the
     correction). This was the GRN-2605 "received into PG instead of SLGR" bug. */
  const [picksResolved, setPicksResolved]     = useState<boolean>(false);
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  // ── On mount: restore the stashed draft + merge the From-PO-multi picks.
  //    Commander 2026-05-30 (anti-double-pick): leaving for the picker now
  //    stashes the in-progress draft (grnNewDraft). On return we restore those
  //    lines + header first, THEN append only the newly-picked PO lines that
  //    aren't already in the draft (dedupe by purchase_order_item_id) — so the
  //    same PO line can't be received twice across the round trip, and existing
  //    edits aren't lost. Mirrors PurchaseOrderNew's restore-then-append. ─────
  const readPicksRef = useRef(false);
  useEffect(() => {
    if (readPicksRef.current) return;
    readPicksRef.current = true;

    const newPicks = readScmHandoff<GrnFromPoPick[]>('grnFromPoPicks');
    if (!newPicks) {
      // No round-trip picks → drop any stale stashed draft (e.g. the picker was
      // cancelled, which navigates away) so a fresh New GRN starts clean.
      removeScmHandoff('grnNewDraft');
      setPicksResolved(true); // no picks — release the warehouse-default effect
      return;
    }
    removeScmHandoff('grnFromPoPicks');

    // Restore the draft saved before we left for the picker (header + lines).
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

    // Merge: restored draft lines + only the new picks not already drafted.
    const baseLines = (draft?.lines ?? []) as DraftLine[];
    const seen = new Set(baseLines.map((l) => l.purchaseOrderItemId).filter(Boolean) as string[]);
    const pickLines: DraftLine[] = newPicks
      .filter((p) => !seen.has(p.poItemId))
      .map((p) => ({
        rid:                 `p${p.poItemId}`,
        purchaseOrderItemId: p.poItemId,
        materialKind:        'mfg_product',
        materialCode:        p.itemCode,
        materialName:        p.description ?? p.itemCode,
        itemGroup:           p.itemGroup || null,
        variants:            (p.variants as Record<string, unknown> | null) ?? null,
        outstanding:         p.remainingQty,
        qtyReceived:         p._pickQty,
        qtyAccepted:         p._pickQty,
        qtyRejected:         0,
        unitPriceCenti:      p.unitPriceCenti ?? 0,
        notes:               '',
        rackId:              '',
      }));
    setLines([...baseLines, ...pickLines]);

    // Picks state drives the supplier lock + header PO — union of draft + new
    // (deduped by PO line id).
    const pickMap = new Map<string, GrnFromPoPick>();
    for (const p of (draft?.picks ?? [])) pickMap.set(p.poItemId, p);
    for (const p of newPicks) pickMap.set(p.poItemId, p);
    const union = [...pickMap.values()];
    if (union.length) setPicks(union);
    // Picks restore is done — now the warehouse-default effect may run, and it
    // will see the picks' real warehouse (warehouseLocationId) before falling
    // back to the first warehouse.
    setPicksResolved(true);
  }, []);

  // Load lines from the selected single PO (only outstanding qty > 0). Skipped
  // when From-PO-multi picks already populated the form.
  useEffect(() => {
    if (hasPicks) return;
    if (!selPoId) {
      // Manual mode — seed ONE blank starter line so a LINE 1 card shows
      // immediately (matches New PO). Never clobber existing lines (picks /
      // hand-added) — only seed when empty.
      setLines((prev) => prev.length > 0 ? prev : [{
        rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        purchaseOrderItemId: null,
        materialKind:        'mfg_product',
        materialCode:        '',
        materialName:        '',
        itemGroup:           null,
        variants:            null,
        outstanding:         null,
        qtyReceived:         1,
        qtyAccepted:         1,
        qtyRejected:         0,
        unitPriceCenti:      0,
        notes:               '',
        rackId:              '',
      }]);
      return;
    }
    if (!poQ.data) return;
    const next: DraftLine[] = poQ.data.items
      .map((it: any) => {
        const outstanding = (it.qty ?? 0) - (it.received_qty ?? 0);
        return {
          rid:               `r${it.id}`,
          purchaseOrderItemId: it.id,
          materialKind:      it.material_kind,
          materialCode:      it.material_code,
          materialName:      it.material_name,
          itemGroup:         it.item_group ?? null,
          variants:          (it.variants as Record<string, unknown> | null) ?? null,
          outstanding,
          qtyReceived:       outstanding,
          qtyAccepted:       outstanding,
          qtyRejected:       0,
          unitPriceCenti:    it.unit_price_centi ?? 0,
          notes:             '',
          rackId:            '',
        };
      })
      .filter((l) => (l.outstanding ?? 0) > 0);
    setLines(next);
  }, [poQ.data, selPoId, hasPicks]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  // ── Leave for the From-PO-multi picker, stashing the in-progress draft so it
  //    survives the round trip + the picker can exclude lines already drafted
  //    here (anti-double-pick). Mirrors PurchaseOrderNew's goToFromSo. ────────
  const goToFromPo = () => {
    const draft: GrnNewDraft = {
      lines, picks, receivedAt, deliveryNoteRef, notes, warehouseId,
      selPoId, manualSupplierId, allocationMethod, manualCurrency,
    };
    if (!writeScmHandoff('grnNewDraft', draft)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store the current GRN draft. Nothing was discarded; free some browser storage and try again.' });
      return;
    }
    navigate('/scm/grns/from-po');
  };

  const subtotalCenti = useMemo(
    () => lines.reduce((s, l) => s + l.qtyReceived * l.unitPriceCenti, 0),
    [lines],
  );

  /* Landed-cost allocation preview (Phase 1-A) — mirror the server math so the
     operator SEES the freight ("平摊") split across goods lines before posting.
     The charge pool = Σ SERVICE-line values; the per-line allocated freight uses
     the chosen basis (QTY / VALUE / CBM). All in the GRN currency for display
     (the server stores MYR via the exchange rate). Keyed by rid. */
  const allocPreview = useMemo(() => {
    const isSvc = (l: DraftLine) => isServiceLine({ itemGroup: l.itemGroup, itemCode: l.materialCode });
    const goods = lines.filter((l) => l.materialCode.trim() && !isSvc(l));
    const chargePool = lines
      .filter((l) => l.materialCode.trim() && isSvc(l))
      .reduce((s, l) => s + l.qtyReceived * l.unitPriceCenti, 0);
    const basisOf = (l: DraftLine): number => {
      if (allocationMethod === 'VALUE') return l.qtyReceived * l.unitPriceCenti;
      if (allocationMethod === 'CBM') return l.qtyReceived; // volume unknown client-side → qty proxy
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

  // ── Mode + resolved supplier / header PO. ──────────────────────────────
  // Manual mode = no picks AND no single PO chosen. Then the operator picks a
  // supplier + adds lines by hand.
  const po       = poQ.data?.purchaseOrder;
  const isManual = !hasPicks && !selPoId;

  // The effective supplier id + display name for the save + header card.
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
  // Header PO id: picks → first pick's PO; single-PO → that PO; manual → null.
  const headerPoId = hasPicks ? pickPoId : (po?.id ?? null);
  /* Multi-currency (Phase 1-A) — a PO-linked GRN inherits (and the server
     re-derives) the source PO's currency, so the picker is LOCKED to it; a
     manual / from-picks GRN lets the operator choose (defaults MYR = no-op). */
  const poCurrency     = (po?.currency as string | undefined) ?? null;
  const currencyLocked = !!poCurrency;
  const currency       = poCurrency ?? manualCurrency;
  /* Landed-cost core (Phase 1-A) — show the Exchange rate field + MYR previews
     only for a foreign-currency receipt. An MYR GRN posts 1:1 (rate 1), so the
     lot cost / COGS are unchanged (strict no-op). */
  const isForeign  = String(currency).toUpperCase() !== 'MYR';
  const rateNum    = resolveFxRate(exchangeRate);
  /* Auto-fill the rate from the currencies MASTER when the GRN settles on a
     foreign currency (still editable). MYR resets to 1; a manual edit wins. */
  const currenciesQ = useActiveCurrencies();
  useEffect(() => {
    if (!isForeign) { setExchangeRate('1'); setRateTouched(false); return; }
    if (rateTouched) return;
    setExchangeRate(String(rateFor(currenciesQ.data, String(currency).toUpperCase())));
  }, [isForeign, currency, currenciesQ.data, rateTouched]);

  // Commander 2026-05-29 — make the MANUAL item picker supplier-binding-aware,
  // exactly like New PO. Once a supplier is chosen the per-line Item Code
  // datalist lists THAT supplier's bound SKUs (material_code + name + price);
  // picking one fills name + unit price + itemGroup from the binding. When no
  // supplier is set yet we fall back to the free useMfgProducts search below.
  const supplierDetailQ = useSupplierDetail(supplierId);
  const bindings        = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  /* Commander 2026-05-29 — the resolved supplier object (same source PO uses)
     so the GRN header can auto-fill Name + Address + the Contact · Phone ·
     Email · Terms · Currency info bar, exactly like New PO. */
  const supplier        = supplierDetailQ.data?.supplier ?? null;

  /* Default the Warehouse picker sensibly: prefer the source PO's purchase
     location (so receiving against a PO lands where the PO expected), else the
     first warehouse. Only seeds when the picker is still blank — never clobbers
     a manual choice. */
  useEffect(() => {
    if (warehouseId) return;
    // CRITICAL ordering guard — do nothing until the on-mount picks restore has
    // run. Before that hasPicks is false only because the async restore is still
    // pending; defaulting to warehousesQ.data[0] now would lock the GRN to the
    // wrong (first) warehouse and the picks' real warehouse could never win.
    if (!picksResolved) return;
    // In the from-PO picks flow no single PO is selected (selPoId is unset, so
    // `po` is undefined). The picked lines all share one warehouse — honour it
    // first, so the GRN receives into the PO's warehouse instead of silently
    // defaulting to the first warehouse in the list.
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

  // ── Manual product search (gated by min query length, mirrors PO form). ──
  // Commander 2026-05-29 — the single top "ADD ITEM" box is gone. Each MANUAL
  // line now carries its own inline Item Code picker (PO parity). The search
  // query is shared: only one line input is focused at a time, so a single
  // gated query feeds whichever line's datalist is active.
  const [productQuery, setProductQuery] = useState<string>('');
  /* Perf — debounce the datalist search so a fast typist fires one
     /mfg-products request per pause, not per keystroke. Native <datalist>
     renders <option>s directly, so no render cap is needed — only the refetch. */
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  // Commander 2026-05-29 — supplier-bound picks carry no category on the
  // binding row, so (mirroring New PO's `allSkus`/`categoryForCode`) we pull
  // the full catalogue to resolve a bound SKU's itemGroup. Gated to manual +
  // supplier so a PO-sourced / no-supplier GRN never fires the lookup.
  const allSkusQ = useMfgProducts({ enabled: isManual && !!supplierId });
  const categoryForCode = (code: string): string | undefined => {
    const sku = (allSkusQ.data ?? []).find((p) => p.code === code);
    return sku?.category ? sku.category.toLowerCase() : undefined;
  };

  // Append a fresh, empty MANUAL line (the per-line picker fills it in). Used by
  // the dashed "Add another item" button at the bottom of the items card.
  const addEmptyManualLine = () => {
    setLines((prev) => [...prev, {
      rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      purchaseOrderItemId: null,
      materialKind:        'mfg_product',
      materialCode:        '',
      materialName:        '',
      itemGroup:           null,
      variants:            null,
      outstanding:         null,
      qtyReceived:         1,
      qtyAccepted:         1,
      qtyRejected:         0,
      unitPriceCenti:      0,
      notes:               '',
      rackId:              '',
    }]);
  };

  // Pick / type an internal SKU on a manual line → fill code + name + itemGroup
  // (category drives the variant editor below, exactly like the PO line picker).
  const pickItemForLine = (rid: string, code: string) => {
    const sku = (productsQ.data ?? []).find((p) => p.code === code);
    setLine(rid, {
      materialCode: code,
      materialName: sku?.name ?? code,
      itemGroup:    sku?.category ? sku.category.toLowerCase() : null,
    });
  };

  // Commander 2026-05-29 — supplier-bound pick (New PO parity): when a supplier
  // is chosen and the typed/picked code matches one of THAT supplier's
  // bindings, fill name + UNIT PRICE (from the binding) + itemGroup. GRN's
  // DraftLine has no supplierSku field, so we skip it. Category is resolved
  // from the full catalogue (categoryForCode) since bindings carry no category.
  const pickBindingForLine = (rid: string, b: typeof bindings[number]) => {
    setLine(rid, {
      materialCode:   b.material_code,
      materialName:   b.material_name,
      unitPriceCenti: b.unit_price_centi,
      itemGroup:      categoryForCode(b.material_code) ?? null,
    });
  };

  const canSave = !!supplierId && lines.length > 0 &&
    lines.every((l) => l.qtyReceived >= 0);

  // asDraft=true saves the GRN as a DRAFT (no stock IN, no PO rollup) for later
  // review + Confirm on the detail page. asDraft=false (default) creates then
  // immediately confirms (the historical "Receive & Post" behaviour).
  const onSave = async (asDraft = false) => {
    if (!supplierId) {
      setDialog({ title: 'Pick a supplier', body: hasPicks
        ? 'The picks are missing a supplier — go back to the picker and try again.'
        : 'Choose the PO you are receiving against, or pick a supplier for a manual receipt.' });
      return;
    }
    // Drop the blank starter line(s) — only real items (with a code) are saved.
    const realLines = lines.filter((l) => l.materialCode.trim());
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
        // Draft/Confirmed — when true the server lands the GRN at DRAFT and
        // commits nothing until it's confirmed on the detail page.
        asDraft,
        // Commander 2026-05-29 — chosen "Receive into" warehouse (PO parity).
        // grns.ts persists it on the header (falls back to the default warehouse
        // when omitted) so the inventory-IN movement lands in the right place.
        warehouseId:     warehouseId || undefined,
        receivedAt,
        deliveryNoteRef: deliveryNoteRef || undefined,
        notes:           notes || undefined,
        /* Landed-cost core (Phase 1-A) — send the resolved currency + rate. The
           server re-derives the currency from the source PO when PO-linked; the
           rate (MYR per 1 unit) converts the FIFO lot cost to MYR. MYR forces 1
           server-side, so a manual MYR receipt is unaffected (no-op). */
        currency,
        exchangeRate:    isForeign ? rateNum : 1,
        // Landed-cost allocation (Phase 1-A) — the freight "平摊" basis.
        allocationMethod,
        items: realLines.map((l) => ({
          purchaseOrderItemId: l.purchaseOrderItemId,
          materialKind:        l.materialKind,
          materialCode:        l.materialCode,
          materialName:        l.materialName,
          qtyReceived:         l.qtyReceived,
          // Commander 2026-05-29 — GRN only captures received qty; accepted
          // follows received (rejected 0) so the existing API + inventory
          // rollup keep working with the simplified single-qty UI.
          qtyAccepted:         l.qtyReceived,
          qtyRejected:         0,
          unitPriceCenti:      l.unitPriceCenti,
          notes:               l.notes || undefined,
          // Commander 2026-05-29 — persist the line's category + variant
          // selections (manual bedframe/sofa lines pick these below; PO-sourced
          // lines carry them through) so the GRN/inventory reflect WHAT was received.
          itemGroup:           l.itemGroup,
          variants:            l.variants,
          // Commander 2026-06-04 — optional destination rack (warehouse-scoped).
          // grns.ts reads it.rackId and writes grn_items.rack_id. Empty = no rack.
          rackId:              l.rackId || undefined,
        })),
      });
      // Non-draft → confirm immediately (the historical Receive & Post). A draft
      // is left at DRAFT for review; the detail page's Confirm runs the commit.
      if (!asDraft) await post.mutateAsync(createRes.id);
      setDialog({
        title: `GRN ${createRes.grnNumber} ${asDraft ? 'saved as draft' : 'created'}`,
        body: asDraft
          ? 'Saved as a draft — no stock moved yet. Open it and Confirm to receive the goods.'
          : 'Received & posted — inventory + PO received qty updated.',
        goTo: `/scm/grns/${createRes.id}`,
      });
    } catch (err) {
      setDialog({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title={`New Goods Receipt${po?.po_number ? ` · ${po.po_number}` : ''}`}
        actions={
          <div className={styles.actions}>
            {/* Bulk / multi-PO picker that FEEDS this form. */}
            <Button variant="ghost" size="md" onClick={goToFromPo}>
              <ArrowRightLeft {...ICON} /> From Purchase Order
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/grns')}>
              <X {...ICON} /> Cancel
            </Button>
            {/* Save as Draft — lands the GRN at DRAFT (no stock IN, no PO rollup)
                for later review + Confirm. */}
            <Button variant="ghost" size="md" onClick={() => onSave(true)} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Save as Draft'}
            </Button>
            <Button variant="primary" size="md" onClick={() => onSave(false)} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Create Goods Receipt'}
            </Button>
          </div>
        }
      />

      {/* Header card — PO picker is inline so you stay on the form. */}
      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            {/* Receive-against picker. Hidden when From-PO-multi picks drive the
                form (supplier + PO are locked to the picks). */}
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
                <select
                  value={selPoId}
                  onChange={(e) => setSelPoId(e.target.value)}
                  className={styles.fieldInput}
                  disabled={poListQ.isLoading || outstanding.length === 0}
                >
                  <option value="">
                    {poListQ.isLoading ? 'Loading POs…'
                      : outstanding.length === 0 ? 'No outstanding POs — receive manually below'
                      : '— Pick an outstanding PO (or leave blank for a manual receipt) —'}
                  </option>
                  {sortByText(outstanding).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.po_number} · {p.supplier?.name ?? p.supplier?.code ?? '—'} · {fmtDateOrDash(p.po_date)}
                      {p.status === 'PARTIALLY_RECEIVED' ? ' (partial)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>GRN #</span>
              <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>

            {/* Supplier — locked from picks / PO, or a manual <select>. */}
            <label className={styles.field}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Supplier <span className={styles.req}>*</span>{hasPicks ? ' (from picks)' : ''}</span>
              {isManual ? (
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
              ) : (
                <input type="text" readOnly value={supplierName ?? '(auto-filled from PO)'} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
              )}
            </label>
            {/* Commander 2026-05-29 — Name + Address auto-fill once a supplier is
                resolved (manual / from PO / from picks), mirroring New PO. */}
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
            {/* Receive into — Warehouse picker (PO's Purchase Location equivalent).
                Threads into the create payload → inventory-IN lands here. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Receive into *</span>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className={styles.fieldInput}
                disabled={warehousesQ.isLoading}
                required
              >
                <option value="">{warehousesQ.isLoading ? 'Loading warehouses…' : '— Pick a warehouse —'}</option>
                {sortByText(warehousesQ.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                Warehouse the received stock moves into.
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Received Date</span>
              <input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Note Ref</span>
              <input type="text" value={deliveryNoteRef} onChange={(e) => setDeliveryNoteRef(e.target.value)} placeholder="Supplier's DN # (optional)" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Receiving notes — visible on the GRN detail page" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
            </label>

            {/* Multi-currency + landed cost (Phase 1-A). Currency defaults to MYR
                (a strict no-op — the rate field stays hidden); a foreign currency
                reveals the auto-filled, editable exchange rate. A PO-linked GRN
                locks the currency to its source PO. */}
            <CurrencySelect
              currency={currency}
              onCurrencyChange={setManualCurrency}
              exchangeRate={exchangeRate}
              onRateChange={(v) => { setRateTouched(true); setExchangeRate(v); }}
              disabled={currencyLocked}
              rateHint={<>≈ {fmtRm(Math.round(subtotalCenti * rateNum), 'MYR')} recorded as inventory cost</>}
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
                  {fmtRm(allocPreview.chargePool, currency)} freight spread across {lines.filter((l) => l.materialCode.trim() && !isServiceLine({ itemGroup: l.itemGroup, itemCode: l.materialCode })).length} goods line(s)
                </span>
              )}
            </label>
          </div>

          {/* Read-only supplier-info bar — same markup/classes as New PO. */}
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
              {supplier.email          && <span>Email: <strong>{supplier.email}</strong></span>}
              {supplier.payment_terms  && <span>Terms: <strong>{supplier.payment_terms}</strong></span>}
              <span>Currency: <strong>{supplier.currency ?? currency}</strong></span>
            </div>
          )}
        </div>
      </section>

      {/* Items card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {hasPicks
              ? `${lines.length} line${lines.length === 1 ? '' : 's'} from picks · subtotal ${fmtRm(subtotalCenti, currency)}`
              : selPoId
                ? (poQ.isLoading
                    ? 'Loading PO items…'
                    : lines.length === 0
                      ? 'No outstanding lines on this PO (all qty already received)'
                      : `${lines.length} line${lines.length === 1 ? '' : 's'} · subtotal ${fmtRm(subtotalCenti, currency)}`)
                : lines.length === 0
                  ? 'Manual receipt — pick a supplier above, then add items below'
                  : `${lines.length} line${lines.length === 1 ? '' : 's'} · subtotal ${fmtRm(subtotalCenti, currency)}`}
            {/* Commander 2026-05-29 — same supplier-binding hint New PO shows:
                once a supplier is chosen the manual picker filters to that
                supplier's bound SKUs (or falls back to the full catalogue when
                the supplier has no bindings yet). */}
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
                ? 'Pick a supplier in the header, then use “Add another item” below to receive items by hand. Receiving against a PO? Pick one in the header, or use '
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
              const lineValueCenti = l.qtyReceived * l.unitPriceCenti;
              const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
              /* Landed-cost allocation (Phase 1-A) — this goods line's share of the
                 freight pool + its landed unit cost (base + per-unit freight),
                 shown only when there's a charge to spread. Service lines get 0. */
              const lineIsSvc = isServiceLine({ itemGroup: l.itemGroup, itemCode: l.materialCode });
              const lineAllocCenti = allocPreview.allocByRid.get(l.rid) ?? 0;
              const landedUnitCenti = l.unitPriceCenti + (l.qtyReceived > 0 ? Math.round(lineAllocCenti / l.qtyReceived) : 0);
              // Manual lines have no outstanding cap — qty inputs go uncapped.
              const cap = l.outstanding;
              const isManualLine = l.purchaseOrderItemId === null;
              // Commander 2026-05-29 — editable variant section only for MANUAL
              // lines (purchaseOrderItemId === null) that are bedframe/sofa, once
              // the maintenance pools are loaded. PO-sourced lines keep their
              // read-only summary (their variants came from the PO).
              const showVariantEditor =
                isManualLine &&
                (l.itemGroup === 'bedframe' || l.itemGroup === 'sofa') &&
                !!maint;
              const setVariant = (key: string, value: string) =>
                setLine(l.rid, { variants: (() => {
                  const variants: Record<string, unknown> = { ...(l.variants ?? {}), [key]: value };
                  // Auto-compute bedframe Total Height = Divan + Leg + Gap.
                  if (l.itemGroup === 'bedframe' && (key === 'divanHeight' || key === 'legHeight' || key === 'gap')) {
                    const d = parseInches(variants.divanHeight);
                    const lg = parseInches(variants.legHeight);
                    const g = parseInches(variants.gap);
                    variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
                  }
                  return variants;
                })() });

              return (
                <div
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
                  {/* Card header — LINE N · category pill · line value · remove */}
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
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                        <span className={styles.previewPrice}>{fmtRm(lineValueCenti, currency)}</span>
                        {/* Landed-cost core — MYR cost preview for a foreign GRN. */}
                        {isForeign && (
                          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                            ≈ {fmtRm(Math.round(lineValueCenti * rateNum), 'MYR')}
                          </span>
                        )}
                        {/* Landed-cost allocation — +freight & landed unit cost, on
                            goods lines only when there's a charge pool. */}
                        {allocPreview.chargePool > 0 && !lineIsSvc && (
                          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--c-accent, #8a6d3b)', marginTop: 2 }}>
                            +{fmtRm(lineAllocCenti, currency)} freight · landed {fmtRm(landedUnitCenti, currency)}/unit
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
                          color: 'var(--c-festive-b, #B8331F)',
                          padding: 4,
                          display: 'inline-flex',
                        }}
                      >
                        <Trash2 {...ICON} />
                      </button>
                    </div>
                  </div>

                  {/* Identity row — Item Code (Internal) + Description */}
                  <div className={styles.formGrid2}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Item Code (Internal)</span>
                      {isManualLine ? (
                        <>
                          <input
                            type="text"
                            list={`grn-products-${l.rid}`}
                            value={l.materialCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setProductQuery(code);
                              // Commander 2026-05-29 — supplier-binding-aware
                              // pick (New PO parity). When a supplier is chosen
                              // and the code matches one of its bindings, fill
                              // name + unit price + itemGroup from the binding.
                              const bound = supplierId
                                ? bindings.find((b) => b.material_code === code)
                                : undefined;
                              if (bound) { pickBindingForLine(l.rid, bound); return; }
                              // No supplier (or no binding for this code) → fall
                              // back to the full SKU search match.
                              const match = (productsQ.data ?? []).find((p) => p.code === code);
                              if (match) { pickItemForLine(l.rid, code); return; }
                              // Free typing — keep what's typed so the field stays editable.
                              setLine(l.rid, { materialCode: code });
                            }}
                            placeholder={supplierId && bindings.length > 0
                              ? 'Pick one of this supplier’s bound SKUs…'
                              : 'Type ≥2 chars to search SKUs by code or name…'}
                            className={styles.fieldInput}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                          <datalist id={`grn-products-${l.rid}`}>
                            {/* Supplier chosen + has bindings → list THAT
                                supplier's bound SKUs (New PO parity). Else fall
                                back to the gated full-catalogue search. */}
                            {supplierId && bindings.length > 0
                              ? sortByText(bindings).map((b) => (
                                  <option key={b.id} value={b.material_code}>
                                    {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                                  </option>
                                ))
                              : sortByText(productsQ.data ?? []).map((p) => (
                                  <option key={p.id} value={p.code}>{p.name} · {p.category}</option>
                                ))}
                          </datalist>
                        </>
                      ) : (
                        <input
                          type="text"
                          readOnly
                          value={l.materialCode}
                          className={styles.fieldInput}
                          style={{ fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
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

                  {/* PO-sourced lines: read-only variant summary (variants came
                      from the PO). Manual lines get the editable variant block. */}
                  {!isManualLine && variantSummary && (
                    <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
                  )}

                  {/* Per-category VARIANT EDITOR for MANUAL bedframe/sofa lines —
                      Commander 2026-05-29: mirrors New PO / the PO Edit modal so
                      the receiver specifies divan/leg/total height, gap, special,
                      seat size + fabric. Same variant keys the PO/SO store. */}
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

                  {/* Fields row — Outstanding · Received · Unit Price · Line Value.
                      Commander 2026-05-29: GRN only needs the RECEIVED qty.
                      Accepted/Rejected are gone from the UI — internally accepted
                      tracks received (rejected 0) so the inventory rollup is intact.
                      (Outstanding is read-only / PO lines only; manual lines "—".) */}
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
                          // Accepted follows received (rejected 0) — kept in sync so
                          // the create payload + inventory rollup stay correct.
                          setLine(l.rid, { qtyReceived: v, qtyAccepted: v, qtyRejected: 0 });
                        }}
                        className={styles.fieldInput} style={{ textAlign: 'right' }} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                      {/* Editable unit price — carried from the PO / manual entry,
                          adjustable at receiving time (Commander 2026-05-29). */}
                      <MoneyInput bare valueSen={l.unitPriceCenti}
                        onCommit={(sen) => setLine(l.rid, { unitPriceCenti: sen ?? 0 })}
                        inputClassName={styles.fieldInput} selectOnFocus />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Line Value</span>
                      <input
                        type="text"
                        readOnly
                        value={fmtRm(lineValueCenti, currency)}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                    {/* Commander 2026-06-04 — optional destination Rack. Racks are
                        warehouse-scoped, so the options come from the header
                        "Receive into" warehouse. Disabled (with a hint) until a
                        warehouse is chosen; shows "No racks…" when the warehouse
                        has none. Empty value = "— No rack —". */}
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Rack</span>
                      <span className={styles.selectWrap}>
                        <select
                          className={styles.fieldSelect}
                          value={l.rackId}
                          onChange={(e) => setLine(l.rid, { rackId: e.target.value })}
                          disabled={!warehouseId || racksQ.isLoading}
                        >
                          {!warehouseId ? (
                            <option value="">— Pick a warehouse first —</option>
                          ) : racksQ.isLoading ? (
                            <option value="">Loading racks…</option>
                          ) : racks.length === 0 ? (
                            <option value="">No racks in this warehouse</option>
                          ) : (
                            <>
                              <option value="">— No rack —</option>
                              {sortByText(racks).map((r) => (
                                <option key={r.id} value={r.id}>{r.rack}</option>
                              ))}
                            </>
                          )}
                        </select>
                        <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                      </span>
                    </label>
                  </div>
                </div>
              );
            })
          )}

          {/* "Add another item" — manual mode (mirrors New PO, always shown). */}
          {isManual && (
            <button
              type="button"
              onClick={addEmptyManualLine}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                width: '100%',
                padding: '12px 14px',
                border: '1px dashed var(--c-orange)',
                borderRadius: 'var(--radius-md)',
                background: 'transparent',
                color: 'var(--c-orange)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-13)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Plus {...ICON} /> Add another item
            </button>
          )}

        </div>
      </section>

      {/* Totals card aligned right — identical to New PO / New Purchase Invoice.
          lg:pr-32 clears the fixed FAB cluster. */}
      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-16)', fontWeight: 700, borderTop: '1px solid var(--line)', paddingTop: 'var(--space-2)' }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
            {/* Landed-cost core — MYR inventory cost for a foreign GRN. */}
            {isForeign && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', marginTop: 'var(--space-2)' }}>
                <span>Inventory cost (MYR)</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(Math.round(subtotalCenti * rateNum), 'MYR')}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? 'Open GRN' : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
