// ----------------------------------------------------------------------------
// PurchaseConsignmentReturnNew — full-page Create at
// /purchase-consignment-return/new.
//
// Faithful clone of PurchaseReturnNew.tsx. It reuses the SAME shared components
// UNCHANGED — MoneyInput, ItemGroupPill, the supplier / product / maintenance
// data hooks — and the SAME card-per-line editor with the per-category variant
// block. Only the create + post mutations are repointed at
// `/purchase-consignment-returns` (the pc-return hooks) and the page title /
// back link point at /purchase-consignment-return.
//
// Dropped from the PR clone (per scope): the from-GRN picker that points at real
// Goods Receipts. Instead the form accepts a `?fromPcReceive=<id>` prefill from
// a Purchase Consignment Receive, OR a `?fromPcOrder=<id>` prefill from a
// Purchase Consignment Order, OR free manual entry. Numbering is PCT-…
// ----------------------------------------------------------------------------

import { transferFromLabel } from '../../lib/convertScope';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, Plus, Save, Trash2, X, ChevronDown } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary } from '@2990s/shared';
import {
  useCreatePurchaseConsignmentReturn,
  usePostPurchaseConsignmentReturn,
} from '../../vendor/scm/lib/purchase-consignment-return-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { usePurchaseConsignmentReceiveDetail } from '../../vendor/scm/lib/purchase-consignment-receive-queries';
import { usePurchaseConsignmentOrderDetail } from '../../vendor/scm/lib/purchase-consignment-order-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { PcVariantEditor } from '../../vendor/scm/components/PcVariantEditor';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
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
  materialCode:   string;
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
  materialCode:   '',
  materialName:   '',
  itemGroup:      null,
  variants:       null,
  qtyReturned:    1,
  unitPriceSen: 0,
  reason:         '',
  notes:          '',
});

export const PurchaseConsignmentReturnNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [params] = useSearchParams();
  const receiveId = params.get('fromPcReceive');
  const orderId   = params.get('fromPcOrder');
  const fromPicks = params.get('fromPicks') === '1';

  const receiveQ   = usePurchaseConsignmentReceiveDetail(receiveId);
  const orderQ     = usePurchaseConsignmentOrderDetail(orderId);
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  // Free-form mode = no source receive and no source order.
  const isManual = !receiveId && !orderId;

  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];

  /* One key for the one return this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the return detail on success, so the MOUNT is
     exactly one return: stable across re-renders and across a re-press after a
     stalled submit, fresh on remount. */
  const idemKey = useIdempotencyKey();
  const create = useCreatePurchaseConsignmentReturn();
  const post   = usePostPurchaseConsignmentReturn();
  const saving = create.isPending || post.isPending;

  const [supplierId, setSupplierId]   = useState<string>('');
  const [returnDate, setReturnDate]   = useState<string>(() => todayMyt());
  const [reason, setReason]           = useState<string>('');
  const [notes, setNotes]             = useState<string>('');
  const [lines, setLines]             = useState<DraftLine[]>([]);

  // Free-form mode — seed ONE blank starter line.
  useEffect(() => {
    if (!isManual) return;
    setLines((prev) => prev.length > 0 ? prev : [newLine()]);
  }, [isManual]);

  // From-Receive multi-picker merge (fromPicks) — the operator chose specific
  // receive lines + quantities on /purchase-consignment-return/from-receive. The
  // header still binds to the first picked receive (via ?fromPcReceive=), but the
  // LINES come from the stash (picked subset + picked qty).
  const [picksLoaded, setPicksLoaded] = useState(false);
  useEffect(() => {
    if (!fromPicks || picksLoaded) return;
    type Stash = {
      receiveItemId: string; pcReceiveId: string; supplierId: string | null;
      materialKind: string; materialCode: string; materialName: string;
      itemGroup: string | null; description: string | null; uom: string | null;
      qty: number; unitPriceSen: number; variants: unknown;
    };
    const stash = readScmHandoff<Stash[]>('pcrnFromReceivePicks');
    if (!stash || stash.length === 0) return;
    setSupplierId(stash[0]?.supplierId ?? '');
    setLines(stash.map((s) => ({
      rid:            `p${s.receiveItemId}`,
      grnItemId:      s.receiveItemId,
      materialKind:   s.materialKind,
      materialCode:   s.materialCode,
      materialName:   s.materialName,
      itemGroup:      s.itemGroup,
      variants:       (s.variants as Record<string, unknown> | null) ?? null,
      qtyReturned:    Number(s.qty ?? 0),
      unitPriceSen: Number(s.unitPriceSen ?? 0),
      reason:         '',
      notes:          '',
    })));
    removeScmHandoff('pcrnFromReceivePicks');
    setPicksLoaded(true);
  }, [fromPicks, picksLoaded]);

  // Pre-fill lines + supplier from the source Receive.
  useEffect(() => {
    if (fromPicks) return; // the picker stash drives the lines, not the whole receive
    if (!receiveQ.data) return;
    const grn = receiveQ.data.grn as { supplier_id?: string } | null;
    setSupplierId(grn?.supplier_id ?? '');
    const items: DraftLine[] = (receiveQ.data.items ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((it: any) => (it.qty_accepted ?? it.qty_received ?? 0) > 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => ({
        rid:            `r${it.id}`,
        grnItemId:      it.id,
        materialKind:   it.material_kind,
        materialCode:   it.material_code,
        materialName:   it.material_name,
        itemGroup:      it.item_group ?? null,
        variants:       (it.variants as Record<string, unknown> | null) ?? null,
        qtyReturned:    it.qty_rejected ?? 0,
        unitPriceSen: it.unit_price_sen ?? 0,
        reason:         it.rejection_reason ?? '',
        notes:          '',
      }));
    if (items.length > 0) setLines(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed-once from the nav prefill; the loaded-flag guard makes any re-run a no-op
  }, [receiveQ.data]);

  // Pre-fill lines + supplier from the source Order (no grnItemId linkage).
  useEffect(() => {
    if (!orderQ.data) return;
    const po = orderQ.data.purchaseOrder;
    setSupplierId(po?.supplier_id ?? '');
    const items: DraftLine[] = (orderQ.data.items ?? []).map((it) => ({
      rid:            `r${it.id}`,
      grnItemId:      null,
      materialKind:   it.material_kind,
      materialCode:   it.material_code,
      materialName:   it.material_name,
      itemGroup:      it.item_group ?? null,
      variants:       (it.variants as Record<string, unknown> | null) ?? null,
      qtyReturned:    0,
      unitPriceSen: it.unit_price_sen ?? 0,
      reason:         '',
      notes:          '',
    }));
    if (items.length > 0) setLines(items);
  }, [orderQ.data]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine  = () => setLines((prev) => [...prev, newLine()]);

  const subtotalSen = useMemo(
    () => lines.filter((l) => l.qtyReturned > 0).reduce((s, l) => s + l.qtyReturned * l.unitPriceSen, 0),
    [lines],
  );

  const [productQuery, setProductQuery] = useState<string>('');
  /* Perf — debounce the datalist search so a fast typist fires one
     /mfg-products request per pause, not per keystroke. Native <datalist>
     renders <option>s directly, so no render cap is needed — only the refetch. */
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  const pickItemForLine = (rid: string, code: string) => {
    const sku = (productsQ.data ?? []).find((p) => p.code === code);
    setLine(rid, {
      materialCode: code,
      materialName: sku?.name ?? code,
      itemGroup:    sku?.category ? sku.category.toLowerCase() : null,
    });
  };

  type ReceiveDetail = {
    grn_number?: string;
    purchase_order_id?: string | null;
    supplier?: { name?: string } | null;
    purchase_order?: { po_number?: string } | null;
  };
  const grn = receiveQ.data?.grn as ReceiveDetail | undefined;
  const po  = orderQ.data?.purchaseOrder;
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
        purchaseOrderId: orderId ?? (grn?.purchase_order_id ?? null),
        grnId: receiveId,
        returnDate,
        reason: reason || undefined,
        notes: notes || undefined,
        items: validLines.map((l) => ({
          grnItemId:      l.grnItemId,
          pcReceiveItemId: l.grnItemId,
          materialKind:   l.materialKind,
          materialCode:   l.materialCode,
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
      await notify({ title: `Purchase Consignment Return ${createRes.returnNumber} created + posted.` });
      navigate(`/scm/purchase-consignment-returns/${createRes.id}`);
    } catch (err) {
      notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const sourceTitle =
    grn ? `from Receive ${grn.grn_number}` :
    po  ? `from Order ${po.po_number}` :
    '(free-form)';

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title={`New Purchase Consignment Return ${sourceTitle}`}
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-consignment-returns/from-receive')}>
              <ArrowRightLeft {...ICON} /> {transferFromLabel('pcr')}
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-consignment-returns')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="primary" size="md" onClick={onSave} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Create Purchase Consignment Return'}
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
              <span className={styles.fieldLabel}>Source Receive #</span>
              <input type="text" readOnly value={grn?.grn_number ?? '—'} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Source Order #</span>
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

      {/* Items card — card-per-line. */}
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
                ? 'Pick a supplier in the header, then use “Add another item” below to add returns by hand.'
                : grn
                  ? 'No accepted lines on this Receive to return.'
                  : 'No lines on this Order to return.'}
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
              const setVariant = (key: string, value: unknown) =>
                setLine(l.rid, { variants: (() => {
                  const variants: Record<string, unknown> = { ...(l.variants ?? {}), [key]: value };
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
                          color: 'var(--c-festive-b, #B8331F)',
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
                            list={`pct-products-${l.rid}`}
                            value={l.materialCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setProductQuery(code);
                              const match = (productsQ.data ?? []).find((p) => p.code === code);
                              if (match) { pickItemForLine(l.rid, code); return; }
                              setLine(l.rid, { materialCode: code });
                            }}
                            placeholder="Type ≥2 chars to search SKUs by code or name…"
                            className={styles.fieldInput}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                          <datalist id={`pct-products-${l.rid}`}>
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

                  {!isManualLine && variantSummary && (
                    <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
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
                      <PcVariantEditor
                        category={l.itemGroup ?? ''}
                        itemCode={l.materialCode}
                        variants={(l.variants ?? {}) as Record<string, unknown>}
                        onChange={setVariant}
                        fabrics={fabrics}
                        maint={maint!}
                      />
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

      {/* Totals card aligned right — lg:pr-32 clears the fixed FAB cluster. */}
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
