// ----------------------------------------------------------------------------
// PurchaseReturnNew — full-page Create Purchase Return at
// /purchase-returns/new (PR — Phase 4 of Purchasing rebuild,
// Commander 2026-05-26).
//
// Two entry modes via URL params:
//   ?grnId={uuid}  — pre-fill lines from a posted GRN (defect / reject /
//                    over-supply). Each line carries grn_item_id so the
//                    server can validate qty <= qty_accepted - already
//                    returned (future check).
//   ?poId={uuid}   — pre-fill supplier + lines from the PO header. No
//                    grn_item_id linkage; commander enters qty manually.
//   (neither)      — free-form. Pick supplier from a dropdown, type lines.
//
// Commander 2026-05-29 — the ITEMS section now mirrors New PO / New GRN /
// New Purchase Invoice: each line is a bordered CARD (LINE N + category pill +
// refund value + remove), an inline Item Code picker (manual lines) / read-only
// code (GRN/PO-sourced), description, the per-category variant editor
// (bedframe/sofa), then a fields row. A dashed "Add another item" button +
// a right-aligned Totals card complete the layout.
//
// Save flow: POST /purchase-returns → PATCH /:id/post in sequence.
// /post writes inventory OUT (stock leaves the warehouse) and stamps
// posted_at. Subsequent /complete adds the supplier's credit note ref.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, Plus, Save, Trash2, X, ChevronDown } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, buildVariantSummary, maintPickerValues } from '@2990s/shared';
import {
  useCreatePurchaseReturn,
  usePostPurchaseReturn,
} from '../../vendor/scm/lib/purchase-return-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { useGrnDetail } from '../../vendor/scm/lib/grn-queries';
import { usePurchaseOrderDetail, useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* Commander 2026-05-29 — bedframe Total Height is AUTO-COMPUTED = Divan + Leg +
   Gap (mirrors GrnNew / SoLineCard); it is NOT a manual pick. */
const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

/* Commander 2026-05-29 — Purchase Return manual lines whose product is a
   bedframe/sofa get the SAME per-category variant editor as New PO / New GRN.
   Small local copy of GrnNew's VariantSelect (not exported there). */
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
  materialCode:   string;
  materialName:   string;
  /* Commander 2026-05-29 — carry the source GRN/PO line's category + variant
     selections so the return shows WHAT is going back (PO/GRN parity). */
  itemGroup:      string | null;
  variants:       Record<string, unknown> | null;
  qtyReturned:    number;
  unitPriceCenti: number;
  reason:         string;
  notes:          string;
};

const newLine = (): DraftLine => ({
  rid:            `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  grnItemId:      null,
  materialKind:   'mfg_product',
  materialCode:   '',
  materialName:   '',
  itemGroup:      null,
  variants:       null,
  qtyReturned:    1,
  unitPriceCenti: 0,
  reason:         '',
  notes:          '',
});

export const PurchaseReturnNew = () => {
  const navigate = useNavigate();
  const notify   = useNotify();
  const [params] = useSearchParams();
  /* The GRN screens' "Transfer to Purchase Return" sent ?fromGrn=<id> here while this page has
     always read `grnId`, so the button opened a blank free-form return with no
     note attached and said nothing (fixed 2026-08-16 by routing both callers
     through lib/convertScope). The scope read now goes through the same module,
     and a parameter this page does not understand is SHOWN rather than dropped
     — a silent drop is what let that mismatch survive. */
  const scope    = readConvertScope('grnToPr', params, ['poId']);
  const grnId    = params.get('grnId');
  const poId     = params.get('poId');

  const grnQ       = useGrnDetail(grnId);
  const poQ        = usePurchaseOrderDetail(poId);
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  // Free-form mode = no GRN and no PO source. Then the operator picks a
  // supplier + adds lines by hand (with the inline Item Code picker).
  const isManual = !grnId && !poId;

  // Commander 2026-05-29 — maintenance config drives the per-category variant
  // editor on MANUAL bedframe/sofa lines (same dropdown pools as New PO / GRN).
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

  /* One key for the one return this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the return detail on success, so the MOUNT is
     exactly one return. Load-bearing: the POST creates the return already POSTED
     and writes the stock OUT inline (see useCreatePurchaseReturn), so a re-press
     after a stalled submit moves stock twice unless it replays. */
  const idemKey = useIdempotencyKey();
  const create = useCreatePurchaseReturn();
  const post   = usePostPurchaseReturn();
  const saving = create.isPending || post.isPending;

  const [supplierId, setSupplierId]   = useState<string>('');
  const [returnDate, setReturnDate]   = useState<string>(() => todayMyt());
  const [reason, setReason]           = useState<string>('');
  const [notes, setNotes]             = useState<string>('');
  const [lines, setLines]             = useState<DraftLine[]>([]);

  // Free-form mode — seed ONE blank starter line so a LINE 1 card shows
  // immediately (matches New GRN / New PO). Never clobber sourced lines —
  // only seed when empty.
  useEffect(() => {
    if (!isManual) return;
    setLines((prev) => prev.length > 0 ? prev : [newLine()]);
  }, [isManual]);

  // Pre-fill lines + supplier from GRN.
  useEffect(() => {
    if (!grnQ.data) return;
    const grn = grnQ.data.grn as { supplier_id?: string } | null;
    setSupplierId(grn?.supplier_id ?? '');
    const items: DraftLine[] = (grnQ.data.items ?? [])
      .filter((it: any) => (it.qty_accepted ?? 0) > 0)
      .map((it: any) => ({
        rid:            `r${it.id}`,
        grnItemId:      it.id,
        materialKind:   it.material_kind,
        materialCode:   it.material_code,
        materialName:   it.material_name,
        itemGroup:      it.item_group ?? null,
        variants:       (it.variants as Record<string, unknown> | null) ?? null,
        qtyReturned:    it.qty_rejected ?? 0,        // pre-fill with rejected qty if any
        unitPriceCenti: it.unit_price_centi ?? 0,
        reason:         it.rejection_reason ?? '',
        notes:          '',
      }));
    if (items.length > 0) setLines(items);
  }, [grnQ.data]);

  // Pre-fill lines + supplier from PO (no grnItemId linkage).
  useEffect(() => {
    if (!poQ.data) return;
    const po = poQ.data.purchaseOrder;
    setSupplierId(po?.supplier_id ?? '');
    const items: DraftLine[] = (poQ.data.items ?? []).map((it: any) => ({
      rid:            `r${it.id}`,
      grnItemId:      null,
      materialKind:   it.material_kind,
      materialCode:   it.material_code,
      materialName:   it.material_name,
      itemGroup:      it.item_group ?? null,
      variants:       (it.variants as Record<string, unknown> | null) ?? null,
      qtyReturned:    0,                              // commander enters
      unitPriceCenti: it.unit_price_centi ?? 0,
      reason:         '',
      notes:          '',
    }));
    if (items.length > 0) setLines(items);
  }, [poQ.data]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine  = () => setLines((prev) => [...prev, newLine()]);

  const subtotalCenti = useMemo(
    () => lines.filter((l) => l.qtyReturned > 0).reduce((s, l) => s + l.qtyReturned * l.unitPriceCenti, 0),
    [lines],
  );

  // ── Manual product search (gated by min query length, mirrors GRN/PO form).
  // Each MANUAL line carries its own inline Item Code picker; the search query
  // is shared (only one input is focused at a time, so a single gated query
  // feeds whichever line's datalist is active).
  const [productQuery, setProductQuery] = useState<string>('');
  /* Perf — debounce the datalist search so a fast typist fires one
     /mfg-products request per pause, not per keystroke. Native <datalist>
     renders <option>s directly, so no render cap is needed — only the refetch. */
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  // Pick / type an internal SKU on a manual line → fill code + name + itemGroup
  // (category drives the variant editor below, exactly like the GRN/PO picker).
  const pickItemForLine = (rid: string, code: string) => {
    const sku = (productsQ.data ?? []).find((p) => p.code === code);
    setLine(rid, {
      materialCode: code,
      materialName: sku?.name ?? code,
      itemGroup:    sku?.category ? sku.category.toLowerCase() : null,
    });
  };

  // Narrow the loose `any` from flow-queries.ts to the fields touched in
  // this page. Avoids `as any` on every property access.
  type GrnDetail = {
    grn_number?: string;
    purchase_order_id?: string | null;
    supplier?: { name?: string } | null;
    purchase_order?: { po_number?: string } | null;
  };
  const grn = grnQ.data?.grn as GrnDetail | undefined;
  const po  = poQ.data?.purchaseOrder;
  const supplierName = useMemo(() => {
    if (grn?.supplier?.name) return grn.supplier.name;
    if (po?.supplier?.name)  return po.supplier.name;
    const s = (suppliersQ.data ?? []).find((sp) => sp.id === supplierId);
    return s ? `${s.code} · ${s.name}` : '';
  }, [grn, po, suppliersQ.data, supplierId]);

  const validLines = lines.filter((l) => l.materialCode.trim() && l.qtyReturned > 0);
  const canSave = !!supplierId && validLines.length > 0;

  const onSave = async () => {
    if (!canSave) { notify({ title: 'Need supplier + at least one line with an item code and qty > 0.', tone: 'error' }); return; }
    try {
      const createRes = await create.mutateAsync({
        idempotencyKey: idemKey,
        supplierId,
        purchaseOrderId: poId ?? (grn?.purchase_order_id ?? null),
        grnId,
        returnDate,
        reason: reason || undefined,
        notes: notes || undefined,
        items: validLines.map((l) => ({
          grnItemId:      l.grnItemId,
          materialKind:   l.materialKind,
          materialCode:   l.materialCode,
          materialName:   l.materialName,
          qtyReturned:    l.qtyReturned,
          unitPriceCenti: l.unitPriceCenti,
          lineRefundCenti: l.qtyReturned * l.unitPriceCenti,
          reason:         l.reason || undefined,
          notes:          l.notes || undefined,
          // Commander 2026-05-29 — send the line's category + variant selections
          // so the return reflects WHAT is going back. (purchase_return_items
          // has item_group/variants columns the inventory-OUT writer reads, but
          // the POST handler does not currently persist these keys — see report.)
          itemGroup:      l.itemGroup,
          variants:       l.variants,
        })),
      });
      await post.mutateAsync(createRes.id);
      /* "Stock OUT recorded." was printed unconditionally, including when the
         response's own movementErrors said the OUT was refused. The create hook
         raises that failure now, so say nothing about stock here rather than
         contradict it with a second dialog. */
      if (!createRes.movementErrors?.length) {
        await notify({ title: `Purchase Return ${createRes.returnNumber} created + posted`, body: 'Stock OUT recorded.' });
      }
      navigate(`/scm/purchase-returns/${createRes.id}`);
    } catch (err) {
      notify({ title: 'Save failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' });
    }
  };

  const sourceTitle =
    grn ? `from GRN ${grn.grn_number}` :
    po  ? `from PO ${po.po_number}` :
    '(free-form)';

  return (
    <div className="space-y-4">
      <UnrecognisedScopeNotice unknown={scope.unknown} />
      <PageHeader back
        eyebrow="Procurement"
        title={`New Purchase Return ${sourceTitle}`}
        actions={
          <div className={styles.actions}>
            {/* Pull lines from a Goods Receipt — routes to the GRN list where the
                user right-clicks "Transfer to Purchase Return" (no dedicated picker page). */}
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/grns')}>
              <ArrowRightLeft {...ICON} /> From Goods Receipt
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-returns')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="primary" size="md" onClick={onSave} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Create Purchase Return'}
            </Button>
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier *</span>
              {grn || po ? (
                <input type="text" readOnly value={supplierName} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
              ) : (
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={styles.fieldInput} required>
                  <option value="">— Pick a supplier —</option>
                  {sortByText(suppliersQ.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                  ))}
                </select>
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date *</span>
              <DateField
                fullWidth
                value={returnDate}
                onChange={(iso) => setReturnDate(iso)}
                className={styles.fieldInput}
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Source GRN #</span>
              <input type="text" readOnly value={grn?.grn_number ?? '—'} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Source PO #</span>
              <input type="text" readOnly value={po?.po_number ?? (grn?.purchase_order?.po_number ?? '—')} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Reason</span>
              <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. defective, wrong colour, over-supply" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
            </label>
          </div>
        </div>
      </section>

      {/* Items card — Commander 2026-05-29: card-per-line, identical to New PO /
          New GRN / New Purchase Invoice. */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items to Return</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {validLines.length} line{validLines.length === 1 ? '' : 's'} · refund {fmtRm(subtotalCenti)}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3) 0' }}>
              {isManual
                ? 'Pick a supplier in the header, then use “Add another item” below to add returns by hand.'
                : grn
                  ? 'No accepted lines on this GRN to return.'
                  : 'No lines on this PO to return.'}
            </p>
          ) : (
            lines.map((l, idx) => {
              const lineRefundCenti = l.qtyReturned * l.unitPriceCenti;
              const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
              // Manual lines (no grn linkage AND free-form mode) get the inline
              // picker + editable variant block. Sourced lines stay read-only.
              const isManualLine = isManual && l.grnItemId === null;
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
                  {/* Card header — LINE N · category pill · refund value · remove */}
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
                      <span className={styles.previewPrice}>{fmtRm(lineRefundCenti)}</span>
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
                            list={`pr-products-${l.rid}`}
                            value={l.materialCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setProductQuery(code);
                              // Exact match on the searched SKU list → fill the line.
                              const match = (productsQ.data ?? []).find((p) => p.code === code);
                              if (match) { pickItemForLine(l.rid, code); return; }
                              // Free typing — keep what's typed so the field stays editable.
                              setLine(l.rid, { materialCode: code });
                            }}
                            placeholder="Type ≥2 chars to search SKUs by code or name…"
                            className={styles.fieldInput}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                          <datalist id={`pr-products-${l.rid}`}>
                            {sortByText(productsQ.data ?? []).map((p) => (
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

                  {/* Sourced lines: read-only variant summary (variants came from
                      the GRN/PO). Manual lines get the editable variant block. */}
                  {!isManualLine && variantSummary && (
                    <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
                  )}

                  {/* Per-category VARIANT EDITOR for MANUAL bedframe/sofa lines —
                      mirrors New PO / New GRN: divan/leg/total height, gap,
                      special, seat size + fabric. Same variant keys the PO/SO store. */}
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
                          <VariantSelect label="Divan Height" options={sortByNumeric(activeOptions(maint!.divanHeights, String(l.variants?.divanHeight ?? '')))}
                            value={String(l.variants?.divanHeight ?? '')}
                            onChange={(v) => setVariant('divanHeight', v)} />
                          <VariantSelect label="Gap"
                            options={sortByNumeric(maintPickerValues(maint!.gaps, String(l.variants?.gap ?? '')).map((g) => ({ value: g, priceSen: 0 })))}
                            value={String(l.variants?.gap ?? '')}
                            onChange={(v) => setVariant('gap', v)} />
                          <VariantSelect label="Leg Height" options={sortByNumeric(activeOptions(maint!.legHeights, String(l.variants?.legHeight ?? '')))}
                            value={String(l.variants?.legHeight ?? '')}
                            onChange={(v) => setVariant('legHeight', v)} />
                          {/* Total Heights removed — auto-computed from Divan +
                              Leg + Gap (see setVariant). Special Orders moved to
                              the shared block below. */}
                        </div>
                      ) : (
                        <div className={styles.formGrid4}>
                          <VariantSelect label="Seat Size"
                            options={sortByNumeric(maintPickerValues(maint!.sofaSizes, String(l.variants?.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 })))}
                            value={String(l.variants?.seatHeight ?? '')}
                            onChange={(v) => setVariant('seatHeight', v)} />
                          <VariantSelect label="Leg Height" options={sortByNumeric(activeOptions(maint!.sofaLegHeights, String(l.variants?.legHeight ?? '')))}
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
                          manual PR line is not parent-linked, so it is directly
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

                  {/* Fields row — Qty Returned · Unit Price · Reason · Refund. */}
                  <div className={styles.formGrid4}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Qty Returned</span>
                      <input type="number" min={0} value={l.qtyReturned}
                        onChange={(e) => setLine(l.rid, { qtyReturned: Math.max(0, Number(e.target.value) || 0) })}
                        className={styles.fieldInput} style={{ textAlign: 'right' }} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Unit Price (MYR)</span>
                      <MoneyInput bare valueSen={l.unitPriceCenti}
                        onCommit={(sen) => setLine(l.rid, { unitPriceCenti: sen ?? 0 })}
                        inputClassName={styles.fieldInput} selectOnFocus />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Reason</span>
                      <input type="text" value={l.reason}
                        onChange={(e) => setLine(l.rid, { reason: e.target.value })}
                        placeholder="Optional"
                        className={styles.fieldInput} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Refund</span>
                      <input
                        type="text"
                        readOnly
                        value={fmtRm(lineRefundCenti)}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                  </div>
                </div>
              );
            })
          )}

          {/* "Add another item" — free-form mode (mirrors New PO / New GRN). */}
          {isManual && (
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
          )}
        </div>
      </section>

      {/* Totals card aligned right — identical to New PO / New GRN / New PI.
          lg:pr-32 clears the fixed FAB cluster. */}
      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-16)', fontWeight: 700, borderTop: '1px solid var(--line)', paddingTop: 'var(--space-2)' }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti)}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
