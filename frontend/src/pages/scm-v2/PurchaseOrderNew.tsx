// ----------------------------------------------------------------------------
// PurchaseOrderNew — full-page Create PO at /scm/purchase-orders/new (PR #97).
//
// Commander 2026-05-26 (AutoCount parity): "Create PO 也要像这样子啊". The
// old side-drawer is gone — replaced with a single full-page form that
// mirrors AutoCount's "New Purchase Order" window: 2-col header above an
// inline-editable items table.
//
// PR #103 — Layout fix: original landed using class names that don't exist
// on SalesOrderDetail.module.css (header / titleRow / cardHeadRow / itemsTable).
// CSS modules silently return undefined for missing keys, so half the page
// fell back to default block layout. Switched to the real class names
// (headerRow / titleBlock / cardHeader / cardBody / table / formGrid2) and
// dropped the inline `grid-template-columns` in favour of formGrid2 + a
// dedicated `.itemsGrid` table column setup.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useRef, useState } from 'react';
// HOUZS VENDOR — Link lives on 'react-router-dom' in react-router v6 (the
// version Houzs ships). Only the import specifier changed.
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Save, Trash2, X, ArrowRightLeft } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import {
  useCreatePurchaseOrder,
  useSuppliers,
  useSupplierDetail,
  useSuppliersForMaterial,
  type BindingRow,
  type NewPoItem,
  type MaterialKind,
  type OutstandingSoItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { serviceConfirm } from '../../vendor/scm/lib/dialog-service';
import { readScmHandoff, removeScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { activeOptions, maintPickerValues } from '@2990s/shared';
import { useFabricTrackings, fabricOptionLabel } from '../../vendor/scm/lib/fabric-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByText, sortByNumeric, byText } from '../../vendor/scm/lib/sort-options';
import {
  computeMfgPoUnitCost,
  type MfgFabricTier,
  type PoPriceMatrix,
} from '@2990s/shared/mfg-pricing';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON    = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/** Per-line draft row. PR #97 — materialKind uses the schema's lowercase
    enum ('mfg_product' | 'fabric' | 'raw') so the POST body lines up with
    apps/api/src/routes/mfg-purchase-orders.ts §VALID_KINDS.
    PR #126 — Commander 2026-05-26: "Item Code 需要显示两行（internal +
    supplier code）+ description 也要显示两行 + 根据 category 带出变体属性".
    `category` is set when an SKU is picked; drives which variant editor
    unfolds beneath the line. `variants` JSON ships to API as part of
    NewPoItem.variants — already supported by the API §POST handler. */
type DraftLine = {
  rid: string;
  bindingId?: string;
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku?: string;
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  deliveryDate?: string;
  /* Mig 0026 — supplier-revised per-line delivery dates (optional). The
     supplier pushes the date back; effective = MAX over non-null of
     [deliveryDate, date2, date3, date4]. */
  supplierDeliveryDate2?: string;
  supplierDeliveryDate3?: string;
  supplierDeliveryDate4?: string;
  warehouseId?: string;
  /* PR #126 — set when materialCode matches an mfg_product so the row knows
     which variant editor to render (sofa / bedframe / mattress). Lowercase
     to match SoLineCard's itemGroup convention. */
  category?: string;
  /** PR #126 — variant payload (fabric / color / design / total height /
      seat / leg / size depending on category). Shipped to API as
      NewPoItem.variants. */
  variants: Record<string, unknown>;
  /** Phase 3 (2026-05-29) — true once the operator types into Unit Price.
      A manual override always wins: auto-pricing from the supplier price
      table + maintenance surcharges stops touching this line's cost. */
  priceTouched?: boolean;
  /** Commander 2026-05-29 (BUG 1) — the source SO line this PO line came from
      (set only when added via "From SO"). Threaded through the create payload
      so the API increments mfg_sales_order_items.po_qty_picked, which drops the
      line from the From-SO picker. NULL for manual / one-off PO lines. */
  soItemId?: string | null;
};

const newLine = (): DraftLine => ({
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  materialKind: 'mfg_product',
  materialCode: '',
  materialName: '',
  qty: 1,
  unitPriceCenti: 0,
  variants: {},
});

export const PurchaseOrderNew = () => {
  const navigate = useNavigate();
  const create   = useCreatePurchaseOrder();
  /* One key for the one PO this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the PO detail on success, so the MOUNT is
     exactly one PO: stable across re-renders (lazy init) and across a re-press
     after a stalled submit — which is the point, since a duplicate PO orders and
     pays for the same goods twice from a real supplier — and fresh on remount. */
  const idemKey  = useIdempotencyKey();
  const notify   = useNotify();

  // ── Header state ────────────────────────────────────────────────────
  const [supplierId, setSupplierId]   = useState<string>('');
  const [poDate, setPoDate]           = useState<string>(() => todayMyt());
  const [expectedAt, setExpectedAt]   = useState<string>('');
  /* Mig 0026 — supplier-revised header delivery dates. Fan down to lines that
     don't carry their own revised date. */
  const [supplierDeliveryDate2, setSupplierDeliveryDate2] = useState<string>('');
  const [supplierDeliveryDate3, setSupplierDeliveryDate3] = useState<string>('');
  const [supplierDeliveryDate4, setSupplierDeliveryDate4] = useState<string>('');
  const [purchaseLocationId, setPurchaseLocationId] = useState<string>('');
  const [notes, setNotes]             = useState<string>('');

  // ── Items state ─────────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  /* Commander 2026-05-29 (BUG 2) — in-app result dialog. Used to surface the
     "一张 PO 只能一个 supplier" guard when From-SO picks belong to a different
     supplier than the one this PO is already bound to. */
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);


  // ── Data ────────────────────────────────────────────────────────────
  const suppliers       = useSuppliers({ status: 'ACTIVE' });
  const supplierDetail  = useSupplierDetail(supplierId || null);
  const warehouses      = useWarehouses();
  const supplier        = supplierDetail.data?.supplier ?? null;
  const bindings        = useMemo(() => supplierDetail.data?.bindings ?? [], [supplierDetail.data?.bindings]);
  const currency        = supplier?.currency ?? 'MYR';

  // PR #114 — Commander 2026-05-26: "逻辑上应该可以让我选 Item，选好之后
  // Supplier 的范围再缩小到目前供货这个 Item 的几个供应商". Item-first
  // picking — item input is enabled even when supplier is unset; the
  // datalist falls back to the full mfg_products list when no supplier is
  // picked. Picking an item triggers a reverse lookup against the
  // existing GET /suppliers/material/:kind/:code endpoint. Outcome:
  //   1 binding   → auto-set supplier + pull the binding's price/SKU
  //   N bindings  → show a hint banner so commander picks above
  //   0 bindings  → one-off purchase, commander enters everything manually
  const allSkus = useMfgProducts();
  /* PR #126 — Pull maintenance config + fabrics list so per-category variant
     editors can render the same dropdowns SO uses (single source of truth).
     PR #208 — when a supplier is picked, surcharges resolve from the supplier
     scope first (commander's per-supplier price book) and fall back to the
     master / selling-price config when no supplier row exists. The query is
     gated so a no-supplier PO doesn't fire a doomed lookup. */
  const supplierMaintQ = useMaintenanceConfig(
    supplierId ? `supplier:${supplierId}` : '',
    { enabled: Boolean(supplierId) },
  );
  const masterMaintQ = useMaintenanceConfig('master', {
    enabled: !supplierId || !supplierMaintQ.data?.data,
  });
  const maint =
    supplierMaintQ.data?.data ?? masterMaintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];

  // Special Orders pool from special_addons (Backend↔POS parity, Loo
  // 2026-06-08), filtered by category. The FULL rows feed the shared
  // SpecialOrders block (owner 2026-07-20 unification) so the PO renders the
  // SAME checkbox + choices + Custom/other editor as the SO and shows the human
  // label, not the raw code.
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  /* PR #126 — Helper: look up an mfg_product by code → returns its category
     (lowercased). Used by both supplier-first and item-first flows to tag
     the line with which variant editor to show. */
  const categoryForCode = (code: string): string | undefined => {
    const sku = (allSkus.data ?? []).find((p) => p.code === code);
    return sku?.category.toLowerCase();
  };
  const [pendingItemPick, setPendingItemPick] = useState<{ rid: string; code: string } | null>(null);
  const itemSuppliersQuery = useSuppliersForMaterial(
    pendingItemPick ? 'mfg_product' : null,
    pendingItemPick?.code ?? null,
  );
  useEffect(() => {
    if (!pendingItemPick) return;
    if (supplierId) { setPendingItemPick(null); return; }
    if (itemSuppliersQuery.isLoading) return;
    const matches = itemSuppliersQuery.data?.bindings ?? [];
    const b = matches[0];
    if (matches.length === 1 && b) {
      // Exactly one supplier binds this — adopt it + autofill the line.
      setSupplierId(b.supplier.id);
      setLines((prev) => prev.map((l) => (l.rid === pendingItemPick.rid ? {
        ...l,
        bindingId:      b.id,
        materialKind:   b.material_kind,
        materialCode:   b.material_code,
        materialName:   b.material_name,
        supplierSku:    b.supplier_sku,
        unitPriceCenti: b.unit_price_centi,
        category:       categoryForCode(b.material_code) ?? l.category,
      } : l)));
      setPendingItemPick(null);
    }
    // N > 1 — leave pendingItemPick set so the hint banner renders.
    // 0      — keep pendingItemPick so the "no bindings, free entry" hint renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categoryForCode is a stable code→category lookup, not a reactive trigger
  }, [pendingItemPick, supplierId, itemSuppliersQuery.isLoading, itemSuppliersQuery.data]);

  // Item-first companion effect — once supplier resolves (commander clicked a
  // hint banner link, or picked manually after typing an item), backfill any
  // line whose materialCode matches a binding but lacks a bindingId. Mirrors
  // pickBinding without forcing commander to re-type the code.
  useEffect(() => {
    if (!supplierId || bindings.length === 0) return;
    setLines((prev) => prev.map((l) => {
      if (l.bindingId || !l.materialCode) return l;
      const b = bindings.find((x) => x.material_code === l.materialCode);
      if (!b) return l;
      return {
        ...l,
        bindingId:      b.id,
        materialKind:   b.material_kind,
        materialName:   b.material_name,
        supplierSku:    b.supplier_sku,
        unitPriceCenti: l.unitPriceCenti || b.unit_price_centi,
        category:       l.category ?? categoryForCode(b.material_code),
      };
    }));
    // Banner has done its job once a supplier is chosen.
    setPendingItemPick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categoryForCode is a stable code→category lookup, not a reactive trigger
  }, [supplierId, bindings]);

  // PR #115 — Commander 2026-05-26: "Purchase Location 已经换了，可是下面的
  // Warehouse 还没换". Header values fan out to all lines whenever they
  // change — commander can still override any single line afterwards, but
  // a fresh header change will overwrite again (matches AutoCount: header
  // is the source of truth, lines inherit until explicitly diverged).
  // Same pattern for Expected Delivery → per-line Delivery Date.
  useEffect(() => {
    if (!purchaseLocationId) return;
    setLines((prev) => prev.map((l) => ({ ...l, warehouseId: purchaseLocationId })));
  }, [purchaseLocationId]);
  useEffect(() => {
    if (!expectedAt) return;
    setLines((prev) => prev.map((l) => ({ ...l, deliveryDate: expectedAt })));
  }, [expectedAt]);

  /* "From SO" → add the picked SO lines into THIS form (Commander 2026-05-29).
     A PO is one supplier, so adopt the picks' main supplier; the binding /
     price backfill effects above then fill each line's supplier SKU + cost.

     Commander 2026-05-29 (BUG 2) — a PO is ONE supplier. The picker greys out
     other suppliers within a session, but the form may already be bound to a
     supplier (a creditor was chosen, or earlier From-SO picks set one) before a
     SECOND From-SO trip brings back a DIFFERENT supplier's lines. Guard here:
     resolve the form's current supplier, and only append picks that match it.
     If the form has no supplier yet, adopt the picks' supplier (old behaviour).
     Mismatched picks are dropped and surfaced via the result dialog. */
  const applyFromSo = (picks: Array<OutstandingSoItem & { _pickQty?: number }>) => {
    if (picks.length === 0) return;

    // The supplier CODE the form is already bound to (if any): explicit creditor
    // wins; else fall back to the first existing non-empty line's resolved
    // binding supplier code.
    const formSupplierCode = (() => {
      if (supplierId) {
        return (suppliers.data ?? []).find((s) => s.id === supplierId)?.code ?? null;
      }
      const existing = lines.find((l) => l.materialCode.trim());
      if (!existing) return null;
      const b = existing.bindingId
        ? bindings.find((x) => x.id === existing.bindingId)
        : bindings.find((x) => x.material_code === existing.materialCode);
      // bindings only resolve once a supplierId is set, so this is mostly a
      // no-op when supplierId is empty — the explicit-creditor branch above is
      // the real guard. Returned for completeness.
      return b ? (suppliers.data ?? []).find((s) => s.id === b.supplier_id)?.code ?? null : null;
    })();

    // The picks' bound supplier — first pick that HAS a main supplier.
    const picksSupplierCode = picks.find((p) => p.mainSupplierCode)?.mainSupplierCode ?? null;

    if (formSupplierCode && picksSupplierCode && picksSupplierCode !== formSupplierCode) {
      // Whole batch belongs to a different supplier — reject all, tell the user.
      setDialog({
        title: 'One supplier per PO',
        body: `These Sales Order lines belong to supplier ${picksSupplierCode}, but this PO is already bound to ${formSupplierCode}. Clear this PO first, or start a new PO to convert them.`,
      });
      return;
    }

    // When the form is already bound, only keep picks that match (or are unbound
    // — they ride as one-off lines under the current creditor). Drop the rest.
    const keep = formSupplierCode
      ? picks.filter((p) => !p.mainSupplierCode || p.mainSupplierCode === formSupplierCode)
      : picks;
    const dropped = picks.length - keep.length;

    // No supplier yet → adopt the picks' supplier (old behaviour); the binding /
    // price backfill effects then fill each line's supplier SKU + cost.
    if (!formSupplierCode && picksSupplierCode) {
      const sup = (suppliers.data ?? []).find((s) => s.code === picksSupplierCode);
      if (sup) setSupplierId(sup.id);
    }

    if (keep.length === 0) {
      setDialog({
        title: 'One supplier per PO',
        body: `No lines match supplier ${formSupplierCode}. Lines from other suppliers were skipped — clear this PO or start a new one.`,
      });
      return;
    }

    const mapped: DraftLine[] = keep.map((p) => ({
      rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      materialKind: 'mfg_product',
      materialCode: p.itemCode,
      materialName: p.description ?? p.itemCode,
      qty: p._pickQty ?? (p.remainingQty > 0 ? p.remainingQty : p.qty),
      unitPriceCenti: 0,
      variants: (p.variants ?? {}) as Record<string, unknown>,
      category: categoryForCode(p.itemCode),
      deliveryDate: p.lineDeliveryDate ?? p.deliveryDate ?? undefined,
      // Commander 2026-05-29 (BUG 1) — remember the source SO line so the
      // create call can increment its po_qty_picked (drops it from the picker).
      soItemId: p.soItemId,
    }));
    // Replace the initial blank line if the form is still empty; else append.
    setLines((prev) => (prev.some((l) => l.materialCode.trim()) ? [...prev, ...mapped] : mapped));

    /* Commander 2026-05-29 — carry the SO's header context onto the PO so the
       buyer doesn't re-key it: "为什么 convert 进来不会把 SO 的 Purchase
       Location 跟 Delivery Date 带过来呢？SO 的 Delivery Date 就等于我们的
       Expected Delivery Date". Use functional setState with `cur ||` so an
       already-set value (e.g. restored draft) wins; otherwise adopt the SO's.
         · Expected Delivery ← SO line delivery date (else SO header date)
         · Purchase Location ← SO sales_location (a warehouse CODE) resolved to
           the matching warehouse id in the Purchase Location dropdown. */
    const firstDelivery = keep.map((p) => p.lineDeliveryDate ?? p.deliveryDate).find(Boolean) ?? null;
    if (firstDelivery) setExpectedAt((cur) => cur || firstDelivery);
    const firstLoc = keep.map((p) => p.salesLocation).find(Boolean) ?? null;
    if (firstLoc) {
      const wh = (warehouses.data ?? []).find((w) => w.code === firstLoc || w.name === firstLoc);
      if (wh) setPurchaseLocationId((cur) => cur || wh.id);
    }

    // If some (but not all) picks were a supplier mismatch, tell the user what
    // was skipped so the omission isn't silent.
    if (dropped > 0) {
      setDialog({
        title: 'Some lines skipped',
        body: `Added ${keep.length} line(s) for supplier ${formSupplierCode}. The other ${dropped} line(s) belong to different suppliers and were skipped — one supplier per PO.`,
      });
    }
  };

  /* Commander 2026-05-29 — when the From-SO grid hands back a selection, it
     stashes the picked rows in sessionStorage and returns here. Apply them once
     suppliers have loaded (so the creditor can resolve), then clear.

     Commander 2026-05-29 (fix) — clicking "From SO" NAVIGATES away, which
     unmounts this form and wipes the lines you already added. So before
     leaving we stash the whole draft (header + lines) under `poNewDraft`; on
     return we RESTORE that draft first, then applyFromSo APPENDS the new picks
     to it (instead of the old behaviour where the remounted form started blank
     and the picks replaced everything). The draft is only consumed when picks
     are actually present; a stale draft (user cancelled the picker) is dropped
     on the next New-PO mount. */
  const appliedFromSoRef = useRef(false);
  useEffect(() => {
    if (appliedFromSoRef.current || suppliers.isLoading) return;
    const pickedRows = readScmHandoff<Array<OutstandingSoItem & { _pickQty?: number }>>('poFromSoPicks');
    /* Commander 2026-05-30 — restore the stashed draft REGARDLESS of whether
       picks came back. If the operator hit Cancel on the picker, picks are
       absent but they STILL want their in-progress lines/header back — losing
       the draft on Cancel was the original complaint. The draft is cleared
       once it's been read so a fresh /new visit (no draft) starts blank. */
    const draft = readScmHandoff<{
      supplierId?: string; poDate?: string; expectedAt?: string;
      purchaseLocationId?: string; notes?: string; lines?: DraftLine[];
    }>('poNewDraft');
    removeScmHandoff('poNewDraft');

    appliedFromSoRef.current = true;
    try {
      // Restore the prior draft (header + lines) FIRST so any picks append.
      if (draft) {
        if (draft.supplierId)         setSupplierId(draft.supplierId);
        if (draft.poDate)             setPoDate(draft.poDate);
        if (draft.expectedAt)         setExpectedAt(draft.expectedAt);
        if (draft.purchaseLocationId) setPurchaseLocationId(draft.purchaseLocationId);
        if (draft.notes)              setNotes(draft.notes);
        if (Array.isArray(draft.lines) && draft.lines.length) setLines(draft.lines);
      }
      if (pickedRows) {
        removeScmHandoff('poFromSoPicks');
        if (Array.isArray(pickedRows) && pickedRows.length) applyFromSo(pickedRows);
      }
    } catch { /* malformed — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suppliers.isLoading]);

  /* Persist the in-progress draft, then go to the full-page From-SO picker.
     Restored on return (see the effect above) so the picked lines APPEND to
     what's already here instead of resetting the form. */
  const goToFromSo = () => {
    if (!writeScmHandoff('poNewDraft', {
      supplierId, poDate, expectedAt, purchaseLocationId, notes, lines,
    })) {
      notify({ title: 'Unable to continue', body: 'This browser could not safely store the current Purchase Order draft. Nothing was discarded; free some browser storage and try again.', tone: 'error' });
      return;
    }
    navigate('/scm/purchase-orders/from-so');
  };

  /* Phase 3 (2026-05-29) — Resolve the fabric tier for a line from the
     `fabrics` list by the line's `variants.fabricCode`, split per category
     (sofa → sofa_price_tier, bedframe → bedframe_price_tier), mirroring
     SoLineCard. Returns null for non-tiered categories or when no fabric /
     tier is set → the cost engine then defaults to P2. */
  const fabricTierForLine = (line: DraftLine): MfgFabricTier | null => {
    const code = String(line.variants.fabricCode ?? '');
    if (!code) return null;
    const f = fabrics.find((x) => x.fabric_code === code);
    if (!f) return null;
    const cat = line.category?.toLowerCase();
    if (cat === 'sofa')     return f.sofa_price_tier ?? f.price_tier ?? null;
    if (cat === 'bedframe') return f.bedframe_price_tier ?? f.price_tier ?? null;
    return null;
  };

  /* Phase 3 (2026-05-29) — Auto-fill a PO line's unit COST from the SUPPLIER's
     own price table (binding.price_matrix) + that supplier's maintenance
     surcharges, instead of the flat binding.unit_price_centi. Falls back to
     the flat binding price when there's no binding / matrix / maint, and is a
     no-op (returns the line's current cost) when the operator has manually
     overridden the price (priceTouched). Combos are OUT OF SCOPE this phase —
     PO lines are per-SKU, so there's no combo override here. */
  const recomputeLineCost = (line: DraftLine): number => {
    // Find the line's binding: by id when known, else by material_code.
    const binding = line.bindingId
      ? bindings.find((b) => b.id === line.bindingId)
      : bindings.find((b) => b.material_code === line.materialCode);
    if (!binding) return line.unitPriceCenti;
    // No maint config loaded yet (or none seeded) → don't crash / zero out;
    // computeMfgPoUnitCost still returns the matrix/flat base with no
    // surcharges, which is the right fallback.
    const category = (line.category?.toUpperCase() ?? '') as
      'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
    if (!category) return binding.unit_price_centi;
    const v = line.variants;
    const specials = Array.isArray(v.specials) ? (v.specials as string[]) : [];
    const breakdown = computeMfgPoUnitCost(
      {
        category,
        priceMatrix:    (binding.price_matrix ?? null) as PoPriceMatrix,
        unitPriceCenti: binding.unit_price_centi,
        fabricTier:     fabricTierForLine(line),
        // Sofa seat SIZE lives on variants.seatHeight; sofa leg height is the
        // same variants.legHeight field (the editor only renders one leg input).
        seatSize:       category === 'SOFA' ? (v.seatHeight as string | undefined) ?? null : null,
        divanHeight:    (v.divanHeight as string | undefined) ?? null,
        legHeight:      category === 'BEDFRAME' ? (v.legHeight as string | undefined) ?? null : null,
        sofaLegHeight:  category === 'SOFA' ? (v.legHeight as string | undefined) ?? null : null,
        // Bedframe Total Heights surcharge — Commander 2026-05-29: picking a
        // total height now re-prices the line (engine reads totalHeights).
        totalHeight:    (v.totalHeight as string | undefined) ?? null,
        specials,
      },
      maint,
    );
    return breakdown.unitPriceSen;
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine  = () => setLines((prev) => [...prev, { ...newLine(), warehouseId: purchaseLocationId || undefined, deliveryDate: expectedAt || undefined }]);
  const dropLine = (rid: string) => setLines((prev) =>
    prev.length === 1 ? [newLine()] : prev.filter((l) => l.rid !== rid),
  );

  const pickBinding = (rid: string, b: BindingRow) => {
    setLine(rid, {
      bindingId:      b.id,
      materialKind:   b.material_kind,
      materialCode:   b.material_code,
      materialName:   b.material_name,
      supplierSku:    b.supplier_sku,
      unitPriceCenti: b.unit_price_centi,
      category:       categoryForCode(b.material_code),
      // Phase 3 — picking a (new) SKU re-arms supplier-price auto-fill; the
      // auto-pricing effect below then overwrites the flat seed with the
      // matrix + maintenance cost (mirrors SoLineCard re-enabling on re-pick).
      priceTouched:   false,
    });
  };

  /* PR #126 — Patch only the variants bag for a line. Used by per-category
     editors so other line fields (qty, price, supplier SKU) stay untouched.
     Commander 2026-05-29: bedframe Total Height is NOT a manual pick — it's
     AUTO-COMPUTED = Divan + Leg + Gap (mirrors SoLineCard), so we recompute it
     here whenever one of those three changes. */
  const parseInches = (s: unknown): number => {
    if (s == null) return 0;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
    return m && m[1] ? Number(m[1]) : 0;
  };
  const setVariant = (rid: string, k: string, v: unknown) =>
    setLines((prev) => prev.map((l) => {
      if (l.rid !== rid) return l;
      const variants: Record<string, unknown> = { ...l.variants, [k]: v };
      if (l.category === 'bedframe' && (k === 'divanHeight' || k === 'legHeight' || k === 'gap')) {
        const d = parseInches(variants.divanHeight);
        const lg = parseInches(variants.legHeight);
        const g = parseInches(variants.gap);
        variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
      }
      return { ...l, variants };
    }));

  /* Phase 3 (2026-05-29) — Auto-fill each line's unit COST from the supplier
     price table + maintenance surcharges whenever a binding is picked
     (pickBinding / the two item-first effects) or variants change (setVariant).
     Centralised here so all those paths share one recompute. A manually
     overridden line (priceTouched) is left alone — the manual value wins.
     Updates only lines whose computed cost differs from the current value, so
     this doesn't loop. */
  useEffect(() => {
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (l.priceTouched) return l;
        const cost = recomputeLineCost(l);
        if (cost === l.unitPriceCenti) return l;
        changed = true;
        return { ...l, unitPriceCenti: cost };
      });
      return changed ? next : prev;
    });
    // recomputeLineCost closes over bindings / fabrics / maint; re-run when any
    // of those (or the lines' pricing-relevant fields) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings, fabrics, maint, lines]);

  const subtotalCenti = useMemo(
    () => lines.reduce(
      (s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0)),
      0,
    ),
    [lines],
  );

  // Draft/Confirmed — asDraft saves the PO as DRAFT (review queue; no MRP
  // supply, no SO-quota lock) instead of a live SUBMITTED PO. Omitted/false
  // keeps the original "Create Purchase Order" -> SUBMITTED behaviour.
  const onSave = (asDraft = false) => {
    if (!supplierId) {
      notify({ title: 'Pick a Creditor (supplier) first.', tone: 'error' });
      return;
    }
    // PR #157 — Commander 2026-05-26: "这些没有 expected delivery date 和
    // purchase location，为什么能生成 PO 呢？" Both fields are required on
    // submit — they fan out to per-line warehouse + delivery date and are
    // needed downstream for GRN. Defense-in-depth: API also rejects missing.
    if (!expectedAt) {
      notify({ title: 'Expected Delivery date is required.', tone: 'error' });
      return;
    }
    if (!purchaseLocationId) {
      notify({ title: 'Purchase Location is required.', tone: 'error' });
      return;
    }
    const validLines = lines.filter((l) => l.materialCode.trim() && l.qty > 0);
    const items: NewPoItem[] = validLines.map((l) => ({
      materialKind:   l.materialKind,
      materialCode:   l.materialCode,
      materialName:   l.materialName || l.materialCode,
      supplierSku:    l.supplierSku,
      qty:            l.qty,
      unitPriceCenti: l.unitPriceCenti,
      bindingId:      l.bindingId,
      discountCenti:  l.discountCenti,
      deliveryDate:   l.deliveryDate || undefined,
      /* Mig 0026 — per-line supplier-revised delivery dates. */
      supplierDeliveryDate2: l.supplierDeliveryDate2 || undefined,
      supplierDeliveryDate3: l.supplierDeliveryDate3 || undefined,
      supplierDeliveryDate4: l.supplierDeliveryDate4 || undefined,
      warehouseId:    l.warehouseId  || undefined,
      /* PR #126 — Per-line variants + itemGroup. NewPoItem already supports
         these (PR #41 schema). The API §POST handler persists them onto
         purchase_order_items.variants JSONB / item_group. */
      itemGroup:      l.category,
      variants:       Object.keys(l.variants).length ? l.variants : undefined,
      // Commander 2026-05-29 (BUG 1) — pass the source SO line id (when this
      // line came from "From SO") so the API rolls po_qty_picked forward and
      // the line disappears from the From-SO picker.
      soItemId:       l.soItemId ?? null,
    }));

    const basePayload = {
      idempotencyKey: idemKey,
      supplierId,
      currency,
      poDate,
      expectedAt,
      /* Mig 0026 — supplier-revised header delivery dates. */
      supplierDeliveryDate2: supplierDeliveryDate2 || undefined,
      supplierDeliveryDate3: supplierDeliveryDate3 || undefined,
      supplierDeliveryDate4: supplierDeliveryDate4 || undefined,
      notes: notes || undefined,
      purchaseLocationId,
      items,
      asDraft,
    };

    /* Over-convert soft-warn -> confirm -> replay (mirror of the confirmShortStock
       "ship anyway?" gate in authedFetch). SO-sourced lines are capped server-side
       at the source SO line's remaining qty; the backend returns 409
       qty_exceeds_remaining. On confirm we replay the SAME create with
       confirmOverConvert set — the server marked that 409 no-write, so the
       idempotency key re-runs instead of replaying the rejection. */
    const runCreate = (confirmOverConvert = false) => {
      create.mutate(
        confirmOverConvert ? { ...basePayload, confirmOverConvert } : basePayload,
        {
          onSuccess: (res) => navigate(`/scm/purchase-orders/${res.id}`),
          onError: async (err) => {
            const e = err as { status?: number; body?: string } | null;
            if (
              !confirmOverConvert && e?.status === 409 &&
              typeof e.body === 'string' && e.body.includes('"qty_exceeds_remaining"')
            ) {
              let detail = 'One line orders more than its Sales Order still needs.';
              try {
                const b = JSON.parse(e.body.slice(e.body.indexOf('{'))) as
                  { soItemId?: string; requested?: number; remaining?: number };
                const ln = lines.find((l) => l.soItemId === b.soItemId);
                const code = ln?.materialCode || ln?.materialName || 'This line';
                detail = `${code}: ordering ${b.requested}, but this Sales Order line only needs ${b.remaining} more.`;
              } catch { /* keep the generic fallback */ }
              const proceed = await serviceConfirm({
                title: 'Ordering more than this Sales Order needs',
                body: `${detail}\n\nCreate the Purchase Order anyway? The extra quantity will be ordered beyond what the Sales Order requires.`,
                confirmLabel: 'Create anyway',
                danger: true,
              });
              if (proceed) runCreate(true);
              return;
            }
            notify({ title: 'Save failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' });
          },
        },
      );
    };
    runCreate();
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title="New Purchase Order"
        actions={
          <div className={styles.actions}>
            {/* PR — Commander 2026-05-27: parity with PO list — quick swap into
                the SO-driven flow without bouncing back to the list page. */}
            <Button variant="ghost" size="md" onClick={goToFromSo}>
              <ArrowRightLeft {...ICON} /> From Sales Order
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-orders')}>
              <X {...ICON} /> Cancel
            </Button>
            {/* Draft/Confirmed — opt-in DRAFT save. Lands the PO in the Draft
                review queue (no MRP supply, no SO-quota lock) until Confirmed. */}
            <Button
              variant="ghost" size="md"
              onClick={() => onSave(true)}
              disabled={create.isPending}
            >
              <Save {...ICON} />
              {create.isPending ? 'Saving…' : 'Save as Draft'}
            </Button>
            <Button
              variant="primary" size="md"
              onClick={() => onSave(false)}
              disabled={create.isPending}
            >
              <Save {...ICON} />
              {create.isPending ? 'Saving…' : 'Create Purchase Order'}
            </Button>
          </div>
        }
      />

      {/* Header card — 2-column grid */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Header</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            {/* LEFT column */}
            <label className={styles.field}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Creditor <span className={styles.req}>*</span></span>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className={styles.fieldInput}
              >
                <option value="">— Pick a supplier —</option>
                {sortByText(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
            </label>

            {/* RIGHT column */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>P/O No</span>
              <input
                type="text"
                readOnly
                value="(assigned on Save)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                type="text"
                readOnly
                value={supplier?.name ?? ''}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
              />
            </label>
            <label className={styles.field}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Date <span className={styles.req}>*</span></span>
              <input
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
                className={styles.fieldInput}
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
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Expected Delivery <span className={styles.req}>*</span></span>
              <input
                type="date"
                value={expectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
                className={styles.fieldInput}
                required
              />
            </label>

            {/* Mig 0026 — supplier-revised header delivery dates. Optional; the
                supplier pushes the delivery back. Fan down to lines that don't
                carry their own revised date. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier Date 2</span>
              <input
                type="date"
                value={supplierDeliveryDate2}
                onChange={(e) => setSupplierDeliveryDate2(e.target.value)}
                className={styles.fieldInput}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier Date 3</span>
              <input
                type="date"
                value={supplierDeliveryDate3}
                onChange={(e) => setSupplierDeliveryDate3(e.target.value)}
                className={styles.fieldInput}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier Date 4</span>
              <input
                type="date"
                value={supplierDeliveryDate4}
                onChange={(e) => setSupplierDeliveryDate4(e.target.value)}
                className={styles.fieldInput}
              />
            </label>

            <label className={styles.field}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Purchase Location <span className={styles.req}>*</span></span>
              <select
                value={purchaseLocationId}
                onChange={(e) => setPurchaseLocationId(e.target.value)}
                className={styles.fieldInput}
                required
              >
                <option value="">— Pick a warehouse —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                Default ship-to warehouse for every line; each line can override below.
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Free text — supplier instructions, internal notes…"
                className={styles.fieldInput}
                rows={3}
                style={{ minHeight: 52, resize: 'vertical' }}
              />
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
              {supplier.email          && <span>Email: <strong>{supplier.email}</strong></span>}
              {supplier.payment_terms  && <span>Terms: <strong>{supplier.payment_terms}</strong></span>}
              <span>Currency: <strong>{currency}</strong></span>
            </div>
          )}
        </div>
      </section>

      {/* Item-first lookup hint — only renders when commander picked an item
          before a supplier and the reverse lookup found >1 bound suppliers
          (or 0). The 1-supplier case is handled silently by the useEffect
          above. */}
      {pendingItemPick && !supplierId && !itemSuppliersQuery.isLoading && (() => {
        const matches = itemSuppliersQuery.data?.bindings ?? [];
        if (matches.length === 0) {
          return (
            <div style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderLeft: '3px solid var(--fg-muted)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--fg)',
            }}>
              <strong style={{ fontFamily: 'var(--font-mono)' }}>{pendingItemPick.code}</strong> isn't bound to any supplier yet. Pick any Creditor above for a one-off purchase, or add a binding from the supplier detail page first.
            </div>
          );
        }
        // N > 1
        return (
          <div style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'rgba(213, 90, 40, 0.06)',
            border: '1px solid var(--c-orange)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--fs-13)',
            color: 'var(--fg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}>
            <div>
              <strong style={{ fontFamily: 'var(--font-mono)' }}>{pendingItemPick.code}</strong> is bound to {matches.length} suppliers — pick one above to auto-fill price + supplier SKU.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {matches.map((b) => (
                <span key={b.id}>
                  <button
                    type="button"
                    onClick={() => setSupplierId(b.supplier.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      color: 'var(--c-orange)',
                      cursor: 'pointer',
                      fontWeight: 600,
                      textDecoration: 'underline',
                    }}
                  >
                    {b.supplier.code} · {b.supplier.name}
                  </button>
                  {' '}({fmtRm(b.unit_price_centi, b.currency)})
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Items card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {supplierId
              ? (bindings.length > 0
                  ? `${bindings.length} item(s) bound to this supplier — picker filters to these`
                  // PR — Commander 2026-05-28: a supplier with no SKU bindings used
                  // to leave the Item Code picker empty (dead field). Fall back to
                  // the full catalogue so a one-off purchase is still pickable.
                  : `No SKUs bound to this supplier yet — picker shows all ${(allSkus.data ?? []).length} SKUs (one-off purchase)`)
              : `Pick any item from ${(allSkus.data ?? []).length} SKUs — supplier auto-narrows`}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {/* PR #129 — Card-per-line layout. Commander 2026-05-26: "其实有很
              多字都塞在了一个小小的格子里，你可能 UI 整个要再整理过一下".
              Replaces the 9-column cramped grid with breathing-room cards
              (same shape as SoLineCard from PR #125). Each card has 4
              sections: identity (item + supplier code), description,
              variants (per category), pricing. */}
          {lines.map((l, idx) => {
            const lineTotalCenti = Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0));
            const categoryLabel = l.category?.toUpperCase() ?? 'UNSET';
            // PR #135 — drop mattress from the variant editor list.
            // Commander 2026-05-26: "mattress variant 还有 branding 为什么要带
            // 出来呢？不需要带出来啊". For mattress SKUs the size + branding
            // are already encoded in the SKU code itself (e.g. "HAPPI.S
            // DEWCOOL MATT (S)"), so the editor was just visual noise.
            const showVariants  = l.category && ['sofa', 'bedframe'].includes(l.category) && maint;

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
                {/* Card header — Line N · category badge · line total · remove */}
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
                    {l.category && (
                      <span style={{
                        fontFamily: 'var(--font-button)',
                        fontSize: 'var(--fs-11)',
                        fontWeight: 700,
                        letterSpacing: '0.10em',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-pill)',
                        background: 'rgba(166, 71, 30, 0.12)',
                        color: 'var(--c-burnt)',
                      }}>
                        {categoryLabel}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span className={styles.previewPrice}>{fmtRm(lineTotalCenti, currency)}</span>
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

                {/* Identity row — Internal code + Supplier SKU side by side */}
                <div className={styles.formGrid2}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Item Code (Internal)</span>
                    <input
                      type="text"
                      list={`bindings-${l.rid}`}
                      value={l.materialCode}
                      onChange={(e) => {
                        const code = e.target.value;
                        // Bound match wins (autofills supplier SKU + price).
                        const match = supplierId
                          ? bindings.find((b) => b.material_code === code)
                          : undefined;
                        if (match) { pickBinding(l.rid, match); return; }
                        // No binding (no supplier yet, OR supplier has no binding
                        // for this code) → one-off line: pull name + category
                        // from the master SKU list so the row isn't left blank.
                        const sku = (allSkus.data ?? []).find((p) => p.code === code);
                        setLine(l.rid, {
                          materialCode: code,
                          materialName: sku?.name ?? l.materialName,
                          bindingId: undefined,
                          category: sku?.category.toLowerCase() ?? categoryForCode(code),
                        });
                        // Reverse supplier lookup only matters before a supplier
                        // is chosen; once one is picked we don't re-narrow.
                        if (!supplierId) setPendingItemPick(code ? { rid: l.rid, code } : null);
                      }}
                      placeholder="Type or pick our internal SKU…"
                      className={styles.fieldInput}
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                    <datalist id={`bindings-${l.rid}`}>
                      {/* PR — Commander 2026-05-28: only show bound SKUs when the
                          supplier actually HAS bindings; otherwise fall back to
                          the full catalogue so the picker is never dead. */}
                      {supplierId && bindings.length > 0
                        ? sortByText(bindings).map((b) => (
                            <option key={b.id} value={b.material_code}>
                              {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                            </option>
                          ))
                        : sortByText(allSkus.data ?? []).map((p) => (
                            <option key={p.id} value={p.code}>
                              {p.name} · {p.category}
                            </option>
                          ))
                      }
                    </datalist>
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Supplier SKU</span>
                    {/* PR #134 — Bi-directional picker: typing/picking a
                        supplier_sku reverse-fills the matching binding's
                        internal materialCode + name + price (same as
                        picking from the Item Code side). Commander: "怎么
                        不能选 Supplier Code 呢". Requires supplier picked
                        first (we only know which bindings to search). */}
                    <input
                      type="text"
                      list={`supplier-skus-${l.rid}`}
                      value={l.supplierSku ?? ''}
                      onChange={(e) => {
                        const sku = e.target.value;
                        if (supplierId) {
                          const match = bindings.find((b) => b.supplier_sku === sku);
                          if (match) {
                            pickBinding(l.rid, match);
                          } else {
                            setLine(l.rid, { supplierSku: sku });
                          }
                        } else {
                          setLine(l.rid, { supplierSku: sku });
                        }
                      }}
                      placeholder={supplierId
                        ? 'Type or pick supplier’s code…'
                        : 'Pick a supplier first to enable picker'}
                      className={styles.fieldInput}
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                    <datalist id={`supplier-skus-${l.rid}`}>
                      {supplierId && sortByText(bindings).map((b) => (
                        <option key={b.id} value={b.supplier_sku || ''}>
                          {b.material_code} · {b.material_name} · {fmtRm(b.unit_price_centi, b.currency)}
                        </option>
                      ))}
                    </datalist>
                  </label>
                </div>

                {/* Description — full width */}
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Description</span>
                  <input
                    type="text"
                    value={l.materialName}
                    onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                    placeholder="(auto-filled if bound — editable for one-off purchases)"
                    className={styles.fieldInput}
                  />
                </label>

                {/* Per-category variant editor (PR #126 logic, PR #129 card layout) */}
                {showVariants && (
                  <div style={{
                    background: 'var(--c-cream)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3)',
                  }}>
                    <div style={{
                      fontFamily: 'var(--font-button)',
                      fontSize: 'var(--fs-11)',
                      fontWeight: 700,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-muted)',
                      marginBottom: 'var(--space-2)',
                    }}>
                      {l.category} Variants
                    </div>

                    {/* BEDFRAME — Commander 2026-05-28: mirror the Sales Order
                        variant editor exactly — Fabrics · Gaps · Divan · Leg
                        (dropdowns) + Special Orders. Dropped the free-text
                        Color + Design fields. */}
                    {l.category === 'bedframe' && (
                      <>
                        <div className={styles.formGrid4}>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Fabrics</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.fabricCode ?? '')}
                              onChange={(e) => setVariant(l.rid, 'fabricCode', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {[...fabrics.filter((f) => f.is_active !== false || f.fabric_code === String(l.variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                                <option key={f.id} value={f.fabric_code}>
                                  {fabricOptionLabel(f)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Gaps</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.gap ?? '')}
                              onChange={(e) => setVariant(l.rid, 'gap', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {sortByNumeric(maintPickerValues(maint!.gaps, String(l.variants.gap ?? ''))).map((g) => (<option key={g} value={g}>{g}</option>))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Divan Heights</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.divanHeight ?? '')}
                              onChange={(e) => setVariant(l.rid, 'divanHeight', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {sortByNumeric(activeOptions(maint!.divanHeights, String(l.variants.divanHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Leg Heights</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.legHeight ?? '')}
                              onChange={(e) => setVariant(l.rid, 'legHeight', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {sortByNumeric(activeOptions(maint!.legHeights, String(l.variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
                            </select>
                          </label>
                          {/* Total Heights — Commander 2026-05-29: removed the
                              manual picker. Total Height is AUTO-COMPUTED from
                              Divan + Leg + Gap (see setVariant), so there's
                              nothing to choose here. */}
                        </div>
                        <SpecialOrders
                          options={specialsPools.bedframe}
                          variants={l.variants}
                          onPatch={(patch) => setLine(l.rid, { variants: { ...l.variants, ...patch } })}
                          showPrices={false}
                          sourceLinked={Boolean(l.soItemId)}
                          sourceLabel="Sales Order"
                        />
                      </>
                    )}

                    {/* SOFA — Commander 2026-05-28: mirror the SO editor —
                        Fabrics · Seat · Leg + Special Orders. Dropped free-text
                        Color. */}
                    {l.category === 'sofa' && (
                      <>
                        <div className={styles.formGrid4}>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Fabrics</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.fabricCode ?? '')}
                              onChange={(e) => setVariant(l.rid, 'fabricCode', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {[...fabrics.filter((f) => f.is_active !== false || f.fabric_code === String(l.variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                                <option key={f.id} value={f.fabric_code}>
                                  {fabricOptionLabel(f)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Seat Size</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.seatHeight ?? '')}
                              onChange={(e) => setVariant(l.rid, 'seatHeight', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {sortByNumeric(maintPickerValues(maint!.sofaSizes, String(l.variants.seatHeight ?? ''))).map((s) => (<option key={s} value={s}>{s}</option>))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Leg Heights</span>
                            <select
                              className={styles.fieldSelect}
                              value={String(l.variants.legHeight ?? '')}
                              onChange={(e) => setVariant(l.rid, 'legHeight', e.target.value)}
                            >
                              <option value="" disabled>Select…</option>
                              {sortByNumeric(activeOptions(maint!.sofaLegHeights, String(l.variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
                            </select>
                          </label>
                          <span />
                        </div>
                        <SpecialOrders
                          options={specialsPools.sofa}
                          variants={l.variants}
                          onPatch={(patch) => setLine(l.rid, { variants: { ...l.variants, ...patch } })}
                          showPrices={false}
                          sourceLinked={Boolean(l.soItemId)}
                          sourceLabel="Sales Order"
                        />
                      </>
                    )}

                    {/* PR #135 — mattress block removed: size + branding are
                        already encoded in the mattress SKU code itself, no
                        need for a separate editor. */}
                  </div>
                )}

                {/* Pricing row — Qty · Unit Price · Discount · Delivery · Ship-to */}
                <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Qty</span>
                    <input
                      type="number" min={0} step={1}
                      value={l.qty}
                      onChange={(e) => setLine(l.rid, { qty: Number(e.target.value) })}
                      className={styles.fieldInput}
                      style={{ textAlign: 'right' }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                    {/* MoneyInput — free typing, no mid-keystroke reformat
                        (Commander "500→5" fix). Phase 3 — manual edit wins:
                        flag priceTouched so supplier-price auto-fill stops
                        overwriting this line. */}
                    <MoneyInput
                      bare
                      valueSen={l.unitPriceCenti}
                      onCommit={(sen) => setLine(l.rid, { unitPriceCenti: sen ?? 0, priceTouched: true })}
                      inputClassName={styles.fieldInput}
                      selectOnFocus
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Discount ({currency})</span>
                    <MoneyInput
                      bare
                      valueSen={l.discountCenti ?? 0}
                      onCommit={(sen) => setLine(l.rid, { discountCenti: sen ?? 0 })}
                      inputClassName={styles.fieldInput}
                      selectOnFocus
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Delivery Date</span>
                    <input
                      type="date"
                      value={l.deliveryDate ?? ''}
                      onChange={(e) => setLine(l.rid, { deliveryDate: e.target.value })}
                      className={styles.fieldInput}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Ship-to Location</span>
                    <select
                      value={l.warehouseId ?? ''}
                      onChange={(e) => setLine(l.rid, { warehouseId: e.target.value })}
                      className={styles.fieldInput}
                    >
                      <option value="">— Inherit Purchase Location —</option>
                      {sortByText(warehouses.data ?? []).map((w) => (
                        <option key={w.id} value={w.id}>{w.code}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={addLine}
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
        </div>
      </section>

      {/* Totals card aligned right — lg:pr-32 clears the fixed FAB cluster. */}
      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--fs-16)',
              fontWeight: 700,
              borderTop: '1px solid var(--line)',
              paddingTop: 'var(--space-2)',
            }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
          </div>
        </section>
      </div>

      {/* BUG 2 — one-supplier-per-PO guard surfaced in-app (no window.alert). */}
      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          onClose={() => setDialog(null)}
        />
      )}

    </div>
  );
};
