
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, Save, Trash2, X, ChevronDown } from 'lucide-react';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { Button } from '@2990s/design-system';
import { activeOptions, buildVariantSummary, maintPickerValues, fmtMoneySen } from '@2990s/shared';
import {
  useCreatePurchaseReturn,
  usePostPurchaseReturn,
  useReturnableGrnLines,
  useReturnablePiLines,
} from '../../vendor/scm/lib/purchase-return-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { useGrnDetail } from '../../vendor/scm/lib/grn-queries';
import { usePurchaseOrderDetail, useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { PURCHASE_RETURN_REASONS, REPAIR_REASON_CODE } from '../../vendor/shared/purchase-return-reasons';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons, mfgCategoryLabel } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { specialOrderSurface } from '../../vendor/scm/lib/special-order-surface';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';
import { DateField } from "../../vendor/scm/components/DateField";
import { afterCreatePath, sourceDocPath } from '../../lib/returnToSource';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

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
  itemGroup:      string | null;
  variants:       Record<string, unknown> | null;
  qtyReturned:    number;
  unitPriceSen: number;
  reason:         string;
  notes:          string;
};

const newLine = (): DraftLine => ({
  rid:            `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  grnItemId:      null,
  materialKind:   'mfg_product',
  itemCode:   '',
  materialName:   '',
  itemGroup:      null,
  variants:       null,
  qtyReturned:    1,
  unitPriceSen: 0,
  reason:         '',
  notes:          '',
});

export const PurchaseReturnNew = () => {
  const navigate = useNavigate();
  const notify   = useNotify();
  const [params] = useSearchParams();
  const scope    = readConvertScope('grnToPr', params, ['poId', 'piId']);
  const grnId    = params.get('grnId');
  const poId     = params.get('poId');
  // HC-0227: from a Purchase Invoice — the receipt lines it bills, same pool shape as PO mode.
  const piId     = params.get('piId');

  const grnQ       = useGrnDetail(grnId);
  const poQ        = usePurchaseOrderDetail(poId);
  const returnableQ = useReturnableGrnLines(poId);
  const returnablePiQ = useReturnablePiLines(piId);
  const poolQ = poId ? returnableQ : returnablePiQ;
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const isManual = !grnId && !poId && !piId;

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

  const idemKey = useIdempotencyKey();
  const create = useCreatePurchaseReturn();
  const post   = usePostPurchaseReturn();
  const saving = create.isPending || post.isPending;

  const [supplierId, setSupplierId]   = useState<string>('');
  const [returnDate, setReturnDate]   = useState<string>(() => todayMyt());
  const [reason, setReason]           = useState<string>('');
  const [notes, setNotes]             = useState<string>('');
  const [repairWarehouseId, setRepairWarehouseId] = useState<string>('');
  // HC-0221: No keeps the PO received instead of re-opening it for a replacement.
  const [supplierReplaces, setSupplierReplaces] = useState<boolean>(true);
  const warehousesQ = useWarehouses();
  const serviceWarehouses = useMemo(
    () => (warehousesQ.data ?? []).filter((w) => (w as { type?: string | null }).type === 'service'),
    [warehousesQ.data],
  );
  const isRepair = reason === REPAIR_REASON_CODE;
  useEffect(() => {
    if (!isRepair) { setRepairWarehouseId(''); return; }
    if (!repairWarehouseId && serviceWarehouses.length === 1) setRepairWarehouseId(serviceWarehouses[0]!.id);
  }, [isRepair, serviceWarehouses, repairWarehouseId]);
  const [lines, setLines]             = useState<DraftLine[]>([]);

  useEffect(() => {
    if (!isManual) return;
    setLines((prev) => prev.length > 0 ? prev : [newLine()]);
  }, [isManual]);

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
        itemCode:   it.item_code,
        materialName:   it.material_name,
        itemGroup:      it.item_group ?? null,
        variants:       (it.variants as Record<string, unknown> | null) ?? null,
        qtyReturned:    it.qty_rejected ?? 0,
        unitPriceSen: it.unit_price_sen ?? 0,
        reason:         it.rejection_reason ?? '',
        notes:          '',
      }));
    if (items.length > 0) setLines(items);
  }, [grnQ.data]);

  useEffect(() => {
    if ((!poId && !piId) || !poolQ.data) return;
    const po = poQ.data?.purchaseOrder;
    setSupplierId(poolQ.data.supplierId ?? po?.supplier_id ?? '');
    const items: DraftLine[] = (poolQ.data.lines ?? []).map((l) => ({
      rid:            `r${l.grnItemId}`,
      grnItemId:      l.grnItemId,
      materialKind:   l.materialKind ?? 'mfg_product',
      itemCode:   l.itemCode,
      materialName:   l.materialName ?? '',
      itemGroup:      l.itemGroup,
      variants:       l.variants,
      qtyReturned:    0,
      unitPriceSen: l.unitPriceSen,
      reason:         l.rejectionReason ?? '',
      notes:          '',
    }));
    if (items.length > 0) setLines(items);
  }, [poId, piId, poolQ.data, poQ.data]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine  = () => setLines((prev) => [...prev, newLine()]);

  const subtotalSen = useMemo(
    () => lines.filter((l) => l.qtyReturned > 0).reduce((s, l) => s + l.qtyReturned * l.unitPriceSen, 0),
    [lines],
  );

  const [productQuery, setProductQuery] = useState<string>('');
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  const pickItemForLine = (rid: string, code: string) => {
    const sku = (productsQ.data ?? []).find((p) => p.code === code);
    setLine(rid, {
      itemCode: code,
      materialName: sku?.name ?? code,
      itemGroup:    sku?.category ? sku.category.toLowerCase() : null,
    });
  };

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

  const validLines = lines.filter((l) => l.itemCode.trim() && l.qtyReturned > 0);
  const canSave = !!supplierId && validLines.length > 0 && !!reason && (!isRepair || !!repairWarehouseId);

  const onSave = async () => {
    if (!canSave) {
      notify({
        title: !reason ? 'Pick a reason for the return.'
          : isRepair && !repairWarehouseId ? 'Say which warehouse holds the goods while they are repaired.'
          : 'Need supplier + at least one line with an item code and qty > 0.',
        tone: 'error',
      });
      return;
    }
    try {
      const createRes = await create.mutateAsync({
        idempotencyKey: idemKey,
        supplierId,
        purchaseOrderId: poId ?? (piId ? returnablePiQ.data?.purchaseOrderId ?? null : grn?.purchase_order_id ?? null),
        grnId,
        returnDate,
        reason,
        kind: isRepair ? 'REPAIR' : 'CREDIT',
        repairWarehouseId: isRepair ? repairWarehouseId : undefined,
        supplierReplaces: isRepair || supplierReplaces,
        notes: notes || undefined,
        items: validLines.map((l) => ({
          grnItemId:      l.grnItemId,
          materialKind:   l.materialKind,
          itemCode:   l.itemCode,
          materialName:   l.materialName,
          qtyReturned:    l.qtyReturned,
          unitPriceSen: l.unitPriceSen,
          lineRefundSen: l.qtyReturned * l.unitPriceSen,
          reason:         l.reason || undefined,
          notes:          l.notes || undefined,
          itemGroup:      l.itemGroup,
          variants:       l.variants,
        })),
      });
      await post.mutateAsync(createRes.id);
      if (!createRes.movementErrors?.length) {
        await notify({ title: `Purchase Return ${createRes.returnNumber} created + posted`, body: 'Stock OUT recorded.' });
      }
      navigate(afterCreatePath(`/scm/purchase-returns/${createRes.id}`, sourceDocPath.goodsReceipt(grnId) ?? sourceDocPath.purchaseOrder(poId) ?? sourceDocPath.purchaseInvoice(piId)));
    } catch (err) {
      notify({ title: 'Save failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' });
    }
  };

  const sourceTitle =
    grn ? `from GRN ${grn.grn_number}` :
    po  ? `from PO ${po.po_number}` :
    returnablePiQ.data ? `from Purchase Invoice ${returnablePiQ.data.invoiceNumber}` :
    '(free-form)';

  const poPoolEmpty = Boolean(poId) && returnableQ.isSuccess && (returnableQ.data?.lines ?? []).length === 0;
  const piPool = piId && returnablePiQ.isSuccess ? returnablePiQ.data : null;
  const piPoolEmpty = piPool !== null && piPool.lines.length === 0;

  return (
    <div className="space-y-4">
      <UnrecognisedScopeNotice unknown={scope.unknown} />
      {poPoolEmpty && (
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-300">
          Nothing returnable on {po?.po_number ?? 'this Purchase Order'} — no posted Goods Receipt
          line still carries a remaining quantity. A return sends RECEIVED goods back: receive the
          delivery first, or open the Goods Receipt and use Transfer to Purchase Return.
        </div>
      )}
      {piPoolEmpty && (
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-300">
          Nothing returnable on {piPool.invoiceNumber} — none of its
          lines has a posted Goods Receipt line behind it with quantity still here. Either it bills no
          received goods, or what it billed has already gone back.
        </div>
      )}
      <PageHeader back
        eyebrow="Procurement"
        title={`New Purchase Return ${sourceTitle}`}
        actions={
          <div className={styles.actions}>
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
              <DateField fullWidth value={returnDate} onChange={(iso) => setReturnDate(iso)} className={styles.fieldInput} required/>
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
              <span className={styles.fieldLabel}>Reason *</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className={styles.fieldInput}>
                <option value="">Pick a reason…</option>
                {PURCHASE_RETURN_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
            </label>
            {isRepair && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Repair warehouse *</span>
                <select value={repairWarehouseId} onChange={(e) => setRepairWarehouseId(e.target.value)} className={styles.fieldInput}>
                  <option value="">Where do the goods sit meanwhile…</option>
                  {serviceWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
                  ))}
                </select>
              </label>
            )}
            {!isRepair && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Supplier sends a replacement? *</span>
                <select
                  value={supplierReplaces ? 'yes' : 'no'}
                  onChange={(e) => setSupplierReplaces(e.target.value === 'yes')}
                  className={styles.fieldInput}
                >
                  <option value="yes">Yes — the PO stays open for the replacement</option>
                  <option value="no">No — the PO is done, nothing more is coming</option>
                </select>
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Remark</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the reason does not say — shown on the return" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
            </label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items to Return</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {validLines.length} line{validLines.length === 1 ? '' : 's'} · refund {fmtRm(subtotalSen)}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3) 0' }}>
              {isManual
                ? 'Pick a supplier in the header, then use “Add line” below to add returns by hand.'
                : grn
                  ? 'No accepted lines on this GRN to return.'
                  : 'No lines on this PO to return.'}
            </p>
          ) : (
            lines.map((l, idx) => {
              const lineRefundSen = l.qtyReturned * l.unitPriceSen;
              const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
              const isManualLine = isManual && l.grnItemId === null;
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
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span className={styles.previewPrice}>{fmtRm(lineRefundSen)}</span>
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

                  <div className={styles.formGrid2}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Item Code (Internal)</span>
                      {isManualLine ? (
                        <>
                          <input
                            type="text"
                            list={`pr-products-${l.rid}`}
                            value={l.itemCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setProductQuery(code);
                              const match = (productsQ.data ?? []).find((p) => p.code === code);
                              if (match) { pickItemForLine(l.rid, code); return; }
                              setLine(l.rid, { itemCode: code });
                            }}
                            placeholder="Type ≥2 chars to search SKUs by code or name…"
                            className={styles.fieldInput}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                          <datalist id={`pr-products-${l.rid}`}>
                            {sortByText(productsQ.data ?? []).map((p) => (
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

                  <div className={styles.formGrid4}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Qty Returned</span>
                      <NumberInput value={l.qtyReturned} sign="unsigned" decimal={false}
                        onValueChange={(n) => setLine(l.rid, { qtyReturned: Math.max(0, n ?? 0) })}
                        className={styles.fieldInput} style={{ textAlign: 'right' }} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Unit Price (MYR)</span>
                      <MoneyInput bare valueSen={l.unitPriceSen}
                        onCommit={(sen) => setLine(l.rid, { unitPriceSen: sen ?? 0 })}
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
                        value={fmtRm(lineRefundSen)}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                  </div>
                </div>
              );
            })
          )}

          {isManual && (
            <AddLineButton variant="block" onClick={addLine} />
          )}
        </div>
      </section>

      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalSen)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-16)', fontWeight: 700, borderTop: '1px solid var(--line)', paddingTop: 'var(--space-2)' }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalSen)}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
