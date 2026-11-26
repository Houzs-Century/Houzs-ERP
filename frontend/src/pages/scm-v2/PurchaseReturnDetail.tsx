
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Undo2, Pencil, Trash2, Printer, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, buildVariantSummary, fmtDateOrDash, maintPickerValues } from '@2990s/shared';
import { isTotalHeightPart, totalHeightPatch } from '../../vendor/shared/total-height';
import {
  usePurchaseReturnDetail,
  useUpdatePurchaseReturnHeader,
  useUpdatePurchaseReturnItem,
  useDeletePurchaseReturnItem,
  useCancelPurchaseReturn,
} from '../../vendor/scm/lib/purchase-return-queries';
import { useSuppliers, useSupplierDetail, type SupplierRow } from '../../vendor/scm/lib/suppliers-queries';
import { useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { DateField } from '../../vendor/scm/components/DateField';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import styles from './SalesOrderDetail.module.css';
import { DetailLoadFailure } from './DetailLoadFailure';
import { supplierEmailList } from '../../vendor/shared/supplier-emails';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (sen: number | null | undefined): string => {
  const v = sen ?? 0;
  return `MYR ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

const VariantSelect = ({
  label, options, value, onChange, disabled = false,
}: {
  label: string;
  options: Array<{ value: string; priceSen: number }>;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <span className={styles.selectWrap}>
      <select className={styles.fieldSelect} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
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

type HeaderDraft = {
  supplierId: string;
  returnDate: string;
  reason: string;
  creditNoteRef: string;
  notes: string;
};
type LineDraft = {
  qty: number;
  unitPriceSen: number;
  materialName: string;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
};

type PrItemRow = Record<string, unknown> & {
  id: string;
  item_code: string;
  material_name: string;
  qty_returned: number;
  unit_price_sen: number;
  line_refund_sen: number;
  reason: string | null;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
  grn_item_id?: string | null;
};

type PrHeaderRow = {
  id: string;
  return_number: string; status: string; return_date: string;
  reason: string | null; refund_sen: number; credit_note_ref: string | null;
  notes: string | null;
  supplier_id?: string | null;
  supplier?: { code: string; name: string };
  purchase_order?: { id: string; po_number: string };
  grn?: { id: string; grn_number: string };
};

const headerSnapshot = (p: PrHeaderRow): HeaderDraft => ({
  supplierId:    p.supplier_id ?? '',
  returnDate:    p.return_date.slice(0, 10),
  reason:        p.reason ?? '',
  creditNoteRef: p.credit_note_ref ?? '',
  notes:         p.notes ?? '',
});

const lineSnapshot = (it: PrItemRow): LineDraft => ({
  qty:            it.qty_returned,
  unitPriceSen: it.unit_price_sen,
  materialName:   it.description ?? it.material_name,
  itemGroup:      it.item_group ?? null,
  variants:       (it.variants as Record<string, unknown> | null) ?? null,
});

export const PurchaseReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = usePurchaseReturnDetail(id ?? null);
  const updateHeader = useUpdatePurchaseReturnHeader();
  const updateItem = useUpdatePurchaseReturnItem();
  const deleteItem = useDeletePurchaseReturnItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseReturn();

  const pr = (detail.data?.purchaseReturn ?? null) as PrHeaderRow | null;
  const items = (detail.data?.items ?? []) as PrItemRow[];

  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat)).map((r) => ({ value: r.code, priceSen: 0 }));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft | undefined>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const isLocked = pr ? pr.status !== 'POSTED' : true;

  useEffect(() => {
    if (isLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    }
  }, [isLocked, isEditing]);

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !pr) {
    return (
      <div className={styles.page}>
        <Link to="/scm/purchase-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <DetailLoadFailure noun="Purchase return" error={detail.isError ? detail.error : null} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      </div>
    );
  }

  const visibleItems = items;
  const lineOf = (it: PrItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PrItemRow): number => {
    if (!isEditing) return it.line_refund_sen;
    const d = lineOf(it);
    return d.qty * d.unitPriceSen;
  };
  const refundTotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);

  const headerView = headerDraft ?? headerSnapshot(pr);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pr)), [k]: v }));
  };

  const setLine = (it: PrItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const setVariant = (it: PrItemRow, key: string, value: string) =>
    setLineDrafts((prev) => {
      const cur = prev[it.id] ?? lineSnapshot(it);
      const variants: Record<string, unknown> = { ...(cur.variants ?? {}), [key]: value };
      if (isTotalHeightPart(key)) {
        const patch = totalHeightPatch(cur.itemGroup, variants);
        if (patch) variants.totalHeight = patch.totalHeight;
      }
      return { ...prev, [it.id]: { ...cur, variants } };
    });

  const enterEdit = () => {
    setHeaderDraft(null);
    setLineDrafts({});
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      if (headerDraft) {
        await updateHeader.mutateAsync({ id: pr.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const snap = lineSnapshot(it);
        const editableIdentity = !it.grn_item_id;
        const identityChanged = editableIdentity && (
          d.materialName !== snap.materialName ||
          (d.itemGroup ?? '') !== (snap.itemGroup ?? '') ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify(snap.variants ?? {})
        );
        const changed =
          d.qty !== it.qty_returned ||
          d.unitPriceSen !== it.unit_price_sen ||
          identityChanged;
        if (changed) {
          await updateItem.mutateAsync({
            id: pr.id, itemId: it.id,
            qty: d.qty, unitPriceSen: d.unitPriceSen,
            ...(editableIdentity ? {
              materialName: d.materialName,
              description:  d.materialName,
              itemGroup:    d.itemGroup ?? undefined,
              variants:     d.variants ?? {},
            } : {}),
          });
        }
      }
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    } catch (e) {
      void notify({ title: 'Save failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  const handlePrint = () => {
    import('../../vendor/scm/lib/purchase-return-pdf').then(({ generatePurchaseReturnPdf }) =>
      generatePurchaseReturnPdf(pr, items),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }));
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/purchase-returns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Undo2 size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {pr.return_number} — {pr.supplier?.name ?? pr.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Refund</span>
            <span className={styles.totalRailValue}>{fmtRm(refundTotal)}</span>
          </div>
          <StatusPill docType="pr" status={pr.status} />
          <RelationshipMapButton type="pr" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          {pr.status !== 'CANCELLED' && pr.status !== 'COMPLETED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Cancel return ${pr.return_number}?`,
                  body: `This reverses the return — the goods are put back into stock. Line items stay for audit.`,
                  confirmLabel: 'Cancel return',
                  danger: true,
                }))) return;
                cancel.mutate(pr.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: `${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
            </Button>
          )}
          {!isEditing ? (
            <Button variant="primary" size="md" onClick={enterEdit} disabled={isLocked}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <Button variant="primary" size="md" onClick={handleSave} disabled={savingDraft}>
              <Save {...ICON} />
              <span>{savingDraft ? 'Saving…' : 'Save'}</span>
            </Button>
          )}
        </div>
      </div>

      <SupplierCard
        pr={pr}
        draft={headerView}
        onField={setHeaderField}
        locked={isLocked}
        isEditing={isEditing}
      />

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({visibleItems.length})</h2>
        </header>

        {visibleItems.length === 0 ? (
          <p className={styles.emptyRow}>No items on this return.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Group</th>
                <th>Warehouse</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Total</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
                const d = lineOf(it);
                const editableIdentity = !it.grn_item_id;
                const showVariantEditor =
                  isEditing && editableIdentity && !isLocked &&
                  (d.itemGroup === 'bedframe' || d.itemGroup === 'sofa') && !!maint;
                return (
                  <Fragment key={it.id}>
                  <tr>
                    <td>
                      <div className={styles.codeCell}>{it.item_code}</div>
                      {(() => {
                        const summary = buildVariantSummary(it.item_group ?? null, it.variants as Record<string, unknown> | null)
                          || it.description
                          || it.material_name;
                        return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                      })()}
                    </td>
                    <td className={styles.muted}>{it.item_group ?? it.material_kind ?? '—'}</td>
                    <td className={styles.muted}>{(it.warehouse_code as string | null) ?? '—'}</td>

                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}>
                          <input
                            type="number"
                            min={0}
                            className={styles.fieldInput}
                            style={{ width: 70, textAlign: 'right' }}
                            value={d.qty}
                            disabled={isLocked}
                            onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <MoneyInput bare selectOnFocus inputClassName={styles.fieldInput}
                            style={{ width: 110, textAlign: 'right' }}
                            valueSen={d.unitPriceSen}
                            disabled={isLocked}
                            onCommit={(sen) => setLine(it, { unitPriceSen: sen ?? 0 })} />
                        </td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceSen)}</td>
                        <td>
                          <span className={styles.actionsCell}>
                            <button type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              title="Remove line" disabled={isLocked || deleteItem.isPending}
                              /* Commander 2026-06-15 — confirm before delete (no
                                 more 裸奔). */
                              onClick={async () => {
                                if (isLocked) return;
                                if (await askConfirm({
                                  title: 'Remove this line?',
                                  body: "The line is removed from this return.",
                                  confirmLabel: 'Remove',
                                  danger: true,
                                })) {
                                  deleteItem.mutate({ id: pr.id, itemId: it.id });
                                }
                              }}>
                              <Trash2 {...SM_ICON} />
                            </button>
                          </span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty_returned}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_sen)}</td>
                        <td className={styles.priceCell}>{fmtRm(lineTotalOf(it))}</td>
                      </>
                    )}
                  </tr>
                  {isEditing && editableIdentity && (
                    <tr>
                      <td colSpan={7} style={{ background: 'var(--c-paper)', borderTop: 'none' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-2) 0' }}>
                          <label className={styles.field} style={{ maxWidth: 480 }}>
                            <span className={styles.fieldLabel}>Description</span>
                            <input
                              type="text" value={d.materialName} disabled={isLocked}
                              onChange={(e) => setLine(it, { materialName: e.target.value })}
                              className={styles.fieldInput}
                            />
                          </label>
                          {showVariantEditor && (
                            <div style={{ background: 'var(--c-cream)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                                {d.itemGroup && <ItemGroupPill group={d.itemGroup} />}
                                <span style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{d.itemGroup} Variants</span>
                              </div>
                              {d.itemGroup === 'bedframe' ? (
                                <div className={styles.formGrid4}>
                                  <VariantSelect label="Divan Height" disabled={isLocked} options={sortByNumeric(activeOptions(maint!.divanHeights, String(d.variants?.divanHeight ?? '')))}
                                    value={String(d.variants?.divanHeight ?? '')} onChange={(v) => setVariant(it, 'divanHeight', v)} />
                                  <VariantSelect label="Gap" disabled={isLocked} options={sortByNumeric(maintPickerValues(maint!.gaps, String(d.variants?.gap ?? '')).map((g) => ({ value: g, priceSen: 0 })))}
                                    value={String(d.variants?.gap ?? '')} onChange={(v) => setVariant(it, 'gap', v)} />
                                  <VariantSelect label="Leg Height" disabled={isLocked} options={sortByNumeric(activeOptions(maint!.legHeights, String(d.variants?.legHeight ?? '')))}
                                    value={String(d.variants?.legHeight ?? '')} onChange={(v) => setVariant(it, 'legHeight', v)} />
                                  <VariantSelect label="Special" disabled={isLocked} options={specialsPools.bedframe}
                                    value={String(d.variants?.special ?? '')} onChange={(v) => setVariant(it, 'special', v)} />
                                </div>
                              ) : (
                                <div className={styles.formGrid4}>
                                  <VariantSelect label="Seat Size" disabled={isLocked} options={sortByNumeric(maintPickerValues(maint!.sofaSizes, String(d.variants?.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 })))}
                                    value={String(d.variants?.seatHeight ?? '')} onChange={(v) => setVariant(it, 'seatHeight', v)} />
                                  <VariantSelect label="Leg Height" disabled={isLocked} options={sortByNumeric(activeOptions(maint!.sofaLegHeights, String(d.variants?.legHeight ?? '')))}
                                    value={String(d.variants?.legHeight ?? '')} onChange={(v) => setVariant(it, 'legHeight', v)} />
                                  <VariantSelect label="Special" disabled={isLocked} options={specialsPools.sofa}
                                    value={String(d.variants?.special ?? '')} onChange={(v) => setVariant(it, 'special', v)} />
                                  <label className={styles.field}>
                                    <span className={styles.fieldLabel}>Fabrics (free text)</span>
                                    <input className={styles.fieldInput} disabled={isLocked} value={String(d.variants?.fabricColor ?? '')}
                                      onChange={(e) => setVariant(it, 'fabricColor', e.target.value)} />
                                  </label>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total Refund</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(refundTotal)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};


const SupplierCard = ({
  pr, draft, onField, locked, isEditing = true,
}: {
  pr: PrHeaderRow;
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (pr.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 'var(--space-3) var(--space-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
            }}
          >
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Supplier"
                value={pr.supplier?.name ?? pr.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Return Date" value={pr.return_date ? fmtDateOrDash(pr.return_date) : null} />
            <InfoCell label="Credit Note Ref" value={pr.credit_note_ref || null} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Reason" value={pr.reason || null} />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={pr.notes || null} />
            </div>
          </div>
        ) : (
        <div className={styles.formGrid4}>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Supplier *</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.supplierId} disabled={locked}
                onChange={(e) => onField('supplierId', e.target.value)}>
                <option value="">— Pick supplier —</option>
                {sortByText(suppliers).map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Return Date</span>
            <DateField fullWidth className={styles.fieldInput} value={draft.returnDate} disabled={locked}
              onChange={(iso) => onField('returnDate', iso)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Credit Note Ref</span>
            <input className={styles.fieldInput} value={draft.creditNoteRef} disabled={locked}
              onChange={(e) => onField('creditNoteRef', e.target.value)} />
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Reason</span>
            <input className={styles.fieldInput} value={draft.reason} disabled={locked}
              onChange={(e) => onField('reason', e.target.value)} />
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={draft.notes} disabled={locked}
              onChange={(e) => onField('notes', e.target.value)} />
          </label>
        </div>
        )}

        {supplier && (
          <div
            style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 'var(--space-3) var(--space-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
            }}
          >
            <InfoCell label="Supplier code" value={supplier.code} />
            <InfoCell label="Contact"       value={supplier.contact_person ?? supplier.attention} />
            <InfoCell label="Phone"         value={supplier.phone ?? supplier.mobile} />
            <InfoCell label="Payment terms" value={supplier.payment_terms} />
            <InfoCell label="Email"         value={supplierEmailList(supplier).join(", ") || null} />
            <InfoCell label="TIN"           value={supplier.tin_number} />
            <InfoCell label="Country / state" value={[supplier.country, supplier.state].filter(Boolean).join(' / ') || null} />
            <InfoCell label="Bindings count" value={String(supplierDetail.data?.bindings.length ?? 0)} />
            <div style={{ gridColumn: '1 / -1', color: 'var(--fg-muted)' }}>
              <span style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Address ·
              </span>{' '}
              {[supplier.address, supplier.area, supplier.postcode].filter(Boolean).join(', ') || '—'}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{
        fontSize: "var(--fs-11)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--fg-muted)",
        marginBottom: 2,
      }}>{label}</div>
      <div style={{ color: value ? "var(--fg)" : "var(--fg-muted)" }}>{value || "—"}</div>
    </div>
  );
}
