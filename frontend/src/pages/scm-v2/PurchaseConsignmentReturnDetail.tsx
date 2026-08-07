// ----------------------------------------------------------------------------
// PurchaseConsignmentReturnDetail — full-page route at
// /scm/purchase-consignment-returns/:id.
//
// Faithful clone of PurchaseReturnDetail.tsx: a draft-style View → Edit →
// Save/Back machine. It reuses the SAME shared components UNCHANGED —
// MoneyInput, the supplier picker + supplier data hooks. Only the queries are
// repointed at `/purchase-consignment-returns` (the pc-return hooks) and links
// go back to /scm/purchase-consignment-returns.
//
// T12 (owner 2026-06-19) — Edit mode on an EXISTING MANUAL line (no
// pc_receive_item_id) gains an editable Description + the shared PcVariantEditor
// for bedframe/sofa. Receive-sourced lines keep identity + variants read-only.
// (Owner decision: NO manual free-add — variant editing only.)
//
// Dropped from the PR clone (per scope): nothing structural — Print PDF +
// Relationship Map stay (vendored).
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  ArrowLeft, Pencil, Printer, Trash2, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import {
  usePurchaseConsignmentReturnDetail,
  useUpdatePurchaseConsignmentReturnHeader,
  useUpdatePurchaseConsignmentReturnItem,
  useDeletePurchaseConsignmentReturnItem,
  useCancelPurchaseConsignmentReturn,
} from '../../vendor/scm/lib/purchase-consignment-return-queries';
import { useSuppliers, useSupplierDetail, type SupplierRow } from '../../vendor/scm/lib/suppliers-queries';
import { useMaintenanceConfig } from '../../vendor/scm/lib/mfg-products-queries';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { PcVariantEditor } from '../../vendor/scm/components/PcVariantEditor';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined): string => {
  const v = centi ?? 0;
  return `MYR ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/* T12 — bedframe Total Height is AUTO-COMPUTED = Divan + Leg + Gap. */
const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

type HeaderDraft = {
  supplierId: string;
  returnDate: string;
  reason: string;
  creditNoteRef: string;
  notes: string;
};
/* T12 — widened with identity/variant fields so an EXISTING MANUAL line
   (pc_receive_item_id == null) can edit its description + bedframe/sofa variants;
   receive-sourced lines keep them read-only. (Owner decision: NO manual
   free-add — this is the ONLY new editing capability here.) */
type LineDraft = {
  qty: number;            // maps to qty_returned
  unitPriceCenti: number;
  materialName: string;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
};

type PrItemRow = Record<string, unknown> & {
  id: string;
  material_code: string;
  material_name: string;
  qty_returned: number;
  unit_price_centi: number;
  line_refund_centi?: number;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
  /* Receive-sourced lines carry the source PC Receive line id; their identity +
     variants stay read-only. Manual lines have it null → variant editing. */
  pc_receive_item_id?: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:    p.supplier_id ?? '',
  returnDate:    (p.return_date ?? '').slice(0, 10),
  reason:        p.reason ?? '',
  creditNoteRef: p.credit_note_ref ?? '',
  notes:         p.notes ?? '',
});

const lineSnapshot = (it: PrItemRow): LineDraft => ({
  qty:            it.qty_returned,
  unitPriceCenti: it.unit_price_centi,
  materialName:   it.description ?? it.material_name ?? '',
  itemGroup:      it.item_group ?? null,
  variants:       (it.variants as Record<string, unknown> | null) ?? null,
});

export const PurchaseConsignmentReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = usePurchaseConsignmentReturnDetail(id ?? null);
  const updateHeader = useUpdatePurchaseConsignmentReturnHeader();
  const updateItem = useUpdatePurchaseConsignmentReturnItem();
  const deleteItem = useDeletePurchaseConsignmentReturnItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseConsignmentReturn();

  const pr = detail.data?.purchaseReturn ?? null;
  const items = (detail.data?.items ?? []) as PrItemRow[];

  /* T12 — maintenance config + fabrics drive the per-category variant editor on
     MANUAL bedframe/sofa lines in Edit mode (shared PcVariantEditor). */
  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
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
      <div className="space-y-4">
        <Link to="/scm/purchase-consignment-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase consignment return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const visibleItems = items;
  const lineOf = (it: PrItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PrItemRow): number => {
    if (!isEditing) return it.line_refund_centi ?? (it.qty_returned * it.unit_price_centi);
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti;
  };
  const refundTotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);

  const headerView = headerDraft ?? headerSnapshot(pr);

  const deliverPrintPdf = (action: PdfAction) => {
    const pdfHeader = {
      return_number: pr.return_number,
      status: String(pr.status),
      return_date: pr.return_date ?? '',
      reason: pr.reason ?? null,
      refund_centi: refundTotal,
      credit_note_ref: pr.credit_note_ref ?? null,
      notes: pr.notes ?? null,
      supplier: pr.supplier ?? undefined,
    };
    const pdfItems = items.map((it) => ({
      material_code: it.material_code,
      material_name: it.material_name,
      qty_returned: it.qty_returned,
      unit_price_centi: it.unit_price_centi,
      line_refund_centi: it.line_refund_centi ?? (it.qty_returned * it.unit_price_centi),
      reason: null,
    }));
    return import('../../vendor/scm/lib/purchase-return-pdf')
      .then(({ generatePurchaseReturnPdf }) =>
        generatePurchaseReturnPdf(pdfHeader as never, pdfItems as never, {
          docTitle: 'PURCHASE CONSIGNMENT RETURN', docNoLabel: 'Return No',
          amountLabel: 'Value', totalLabel: 'TOTAL VALUE', action,
        }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }));
  };
  const print = usePrintPreview(deliverPrintPdf);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pr)), [k]: v }));
  };

  const setLine = (it: PrItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  /* T12 — patch one variant key on a line + auto-compute bedframe Total Height
     (= Divan + Leg + Gap), mirroring the consignment New flow's setVariant. */
  const setVariant = (it: PrItemRow, key: string, value: unknown) =>
    setLineDrafts((prev) => {
      const cur = prev[it.id] ?? lineSnapshot(it);
      const variants: Record<string, unknown> = { ...(cur.variants ?? {}), [key]: value };
      if (cur.itemGroup === 'bedframe' && (key === 'divanHeight' || key === 'legHeight' || key === 'gap')) {
        const d = parseInches(variants.divanHeight);
        const lg = parseInches(variants.legHeight);
        const g = parseInches(variants.gap);
        variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
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
        /* Identity/variants are editable only on MANUAL lines (no
           pc_receive_item_id); receive-sourced lines never send those keys. */
        const manual = !it.pc_receive_item_id;
        const identityChanged = manual && (
          d.materialName !== snap.materialName ||
          (d.itemGroup ?? '') !== (snap.itemGroup ?? '') ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify(snap.variants ?? {})
        );
        const changed =
          d.qty !== it.qty_returned ||
          d.unitPriceCenti !== it.unit_price_centi ||
          identityChanged;
        if (changed) {
          await updateItem.mutateAsync({
            id: pr.id, itemId: it.id,
            qty: d.qty, unitPriceCenti: d.unitPriceCenti,
            /* T12 — only manual lines send identity/variants; the server
               recomputes description2 + resyncs the return's inventory. */
            ...(manual ? {
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
      notify({ title: 'Save failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────── */}
      <PageHeader back
        eyebrow="Procurement"
        title={`${pr.return_number} — ${pr.supplier?.name ?? pr.supplier?.code ?? '—'}`}
        actions={
          <div className={styles.actions}>
            <div className={styles.totalRail}>
              <span className={styles.totalRailLabel}>Refund</span>
              <span className={styles.totalRailValue}>{fmtRm(refundTotal)}</span>
            </div>
            <StatusPill docType="pr" status={pr.status} />
            <RelationshipMapButton type="pcrn" id={pr.id} />
            <Button variant="ghost" size="md" onClick={print.openPreview}>
              <Printer {...ICON} /><span>Print PDF</span>
            </Button>
            <PrintPreviewModal
              open={print.open}
              onClose={print.close}
              docTitle="Purchase Consignment Return"
              docNo={pr.return_number}
              rows={[
                { label: 'Supplier', value: pr.supplier?.name ?? pr.supplier?.code ?? '—' },
                { label: 'Return date', value: pr.return_date ? fmtDateOrDash(pr.return_date) : '—' },
                { label: 'Items', value: `${items.length} line${items.length === 1 ? '' : 's'}` },
                { label: 'Goods value', value: fmtRm(refundTotal) },
              ]}
              {...print.handlers}
            />
            {pr.status !== 'CANCELLED' && pr.status !== 'COMPLETED' && (
              <Button variant="ghost" size="md"
                onClick={async () => {
                  if (!(await askConfirm({
                    title: `Cancel return ${pr.return_number}?`,
                    body: 'This reverses the return — the goods are put back into stock. Line items stay for audit.',
                    confirmLabel: 'Cancel Return',
                    danger: true,
                  }))) return;
                  cancel.mutate(pr.id, {
                    onError: (err) => notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
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
        }
      />

      {/* ── Supplier / dates / reason / notes ───────────────────── */}
      <SupplierCard
        pr={pr}
        draft={headerView}
        onField={setHeaderField}
        locked={isLocked}
        isEditing={isEditing}
      />

      {/* ── Line items ──────────────────────────────────────────── */}
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
                /* T12 — identity + variants are editable only on MANUAL lines
                   (no pc_receive_item_id); receive-sourced lines stay read-only.
                   Owner decision: NO manual free-add — variant editing only. */
                const manual = !it.pc_receive_item_id;
                const showVariantEditor =
                  isEditing && manual && !isLocked &&
                  (d.itemGroup === 'bedframe' || d.itemGroup === 'sofa') && !!maint;
                return (
                  <Fragment key={it.id}>
                  <tr>
                    <td>
                      <div className={styles.codeCell}>{it.material_code}</div>
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
                            valueSen={d.unitPriceCenti}
                            disabled={isLocked}
                            onCommit={(sen) => setLine(it, { unitPriceCenti: sen ?? 0 })} />
                        </td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti)}</td>
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
                                  body: "The line is removed from this consignment return.",
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
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                        <td className={styles.priceCell}>{fmtRm(lineTotalOf(it))}</td>
                      </>
                    )}
                  </tr>
                  {/* T12 — expanded editor row (Edit mode, MANUAL lines): an
                      editable Description + the shared PcVariantEditor. A
                      receive-sourced line gets no editor — identity stays
                      read-only (owner decision: no manual free-add). */}
                  {isEditing && manual && (
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
                              <PcVariantEditor
                                category={d.itemGroup ?? ''}
                                itemCode={it.material_code}
                                variants={(d.variants ?? {}) as Record<string, unknown>}
                                onChange={(k, v) => setVariant(it, k, v)}
                                fabrics={fabrics}
                                maint={maint!}
                              />
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

      {/* ── Totals ────────────────────────────────────────────────── */}
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

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft.
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  pr, draft, onField, locked, isEditing = true,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pr: any;
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
            <input type="date" className={styles.fieldInput} value={draft.returnDate} disabled={locked}
              onChange={(e) => onField('returnDate', e.target.value)} />
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
            <InfoCell label="Phone"         value={formatPhone(supplier.phone ?? supplier.mobile) || null} />
            <InfoCell label="Payment terms" value={supplier.payment_terms} />
            <InfoCell label="Email"         value={supplier.email} />
            <InfoCell label="TIN"           value={supplier.tin_number} />
            <InfoCell label="Country / state" value={[supplier.country, supplier.state].filter(Boolean).join(' / ') || null} />
            <InfoCell label="Bindings count" value={String(supplierDetail.data?.bindings?.length ?? 0)} />
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
