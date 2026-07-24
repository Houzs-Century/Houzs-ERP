// ----------------------------------------------------------------------------
// PurchaseConsignmentReceiveDetail — full-page route at
// /scm/purchase-consignment-receives/:id.
//
// Faithful clone of GoodsReceivedDetail.tsx: a draft-style View → Edit →
// Save/Back machine. It reuses the SAME shared components UNCHANGED —
// MoneyInput, ItemGroupPill, the supplier picker + supplier / warehouse data
// hooks. Only the queries are repointed at `/purchase-consignment-receives`
// (the pc-receive hooks) and links go back to /scm/purchase-consignment-receives.
//
// T12 (owner 2026-06-19) — Edit mode on a MANUAL receive line (no
// pc_order_item_id) now gains an editable Description + the shared PcVariantEditor
// for bedframe/sofa, the SAME rich variant editing as New. PCO-sourced lines keep
// identity + variants read-only.
//
// Dropped from the GRN clone (per scope): the per-line Rack column (racks place
// owned inventory, not off-ledger consignment), the From-PO header convert
// button (consignment receives don't append from real POs). Print PDF +
// Relationship Map stay (vendored). The "Received from PO" line label is
// relabelled to the source Purchase Consignment Order.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  ArrowLeft, FileText, Pencil, Printer, Trash2, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import {
  usePurchaseConsignmentReceiveDetail,
  useUpdatePurchaseConsignmentReceiveHeader,
  useUpdatePurchaseConsignmentReceiveItem,
  useDeletePurchaseConsignmentReceiveItem,
  useCancelPurchaseConsignmentReceive,
} from '../../vendor/scm/lib/purchase-consignment-receive-queries';
import {
  useSuppliers, useSupplierDetail,
  type SupplierRow,
} from '../../vendor/scm/lib/suppliers-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
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

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
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
  receivedAt: string;
  deliveryNoteRef: string;
  warehouseId: string;
  currency: string;
  notes: string;
};
/* T12 — widened with the line's identity/variant fields so a MANUAL receive line
   (pc_order_item_id == null) can edit its description + bedframe/sofa variants in
   Edit mode; PCO-sourced lines keep them read-only. */
type LineDraft = {
  qty: number;            // maps to qty_received
  unitPriceCenti: number;
  discountCenti: number;
  deliveryDate: string | null;
  materialName: string;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
};

type GrnItemRow = Record<string, unknown> & {
  id: string;
  material_code: string;
  material_name: string;
  qty_received: number;
  unit_price_centi: number;
  discount_centi?: number;
  line_total_centi?: number;
  delivery_date?: string | null;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
  source_po_number?: string | null;
  received_at?: string | null;
  /* PCO-sourced lines carry the source order line id; identity + variants stay
     read-only on those. Manual lines have it null → full editing. */
  pc_order_item_id?: string | null;
  downstream?: { docNumber: string; docType: string; qty: number; status: string }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const headerSnapshot = (g: any): HeaderDraft => ({
  supplierId:      g.supplier_id ?? '',
  receivedAt:      (g.received_at ?? '').slice(0, 10),
  deliveryNoteRef: g.delivery_note_ref ?? '',
  warehouseId:     g.warehouse_id ?? '',
  currency:        g.currency ?? 'MYR',
  notes:           g.notes ?? '',
});

const lineSnapshot = (it: GrnItemRow): LineDraft => ({
  qty:            it.qty_received,
  unitPriceCenti: it.unit_price_centi,
  discountCenti:  it.discount_centi ?? 0,
  deliveryDate:   it.delivery_date ?? null,
  materialName:   it.description ?? it.material_name ?? '',
  itemGroup:      it.item_group ?? null,
  variants:       (it.variants as Record<string, unknown> | null) ?? null,
});

export const PurchaseConsignmentReceiveDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseConsignmentReceiveDetail(id ?? null);
  const updateHeader = useUpdatePurchaseConsignmentReceiveHeader();
  const updateItem = useUpdatePurchaseConsignmentReceiveItem();
  const deleteItem = useDeletePurchaseConsignmentReceiveItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseConsignmentReceive();

  const grn = detail.data?.grn ?? null;
  const items = (detail.data?.items ?? []) as GrnItemRow[];

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

  const hasChildren = Boolean(grn?.has_children);
  const isLocked = grn ? (grn.status !== 'POSTED' || hasChildren) : true;
  const lockedDueToChildren = grn ? (grn.status === 'POSTED' && hasChildren) : false;

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
  if (detail.isError || !grn) {
    return (
      <div className="space-y-4">
        <Link to="/scm/purchase-consignment-receives" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase consignment receive not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const visibleItems = items;
  const lineOf = (it: GrnItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: GrnItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? (it.qty_received * it.unit_price_centi - (it.discount_centi ?? 0));
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);
  const grandTotal = itemsSubtotal + (grn.tax_centi ?? 0);
  const totalQty = visibleItems.reduce((s, it) => s + (isEditing ? lineOf(it).qty : (it.qty_received ?? 0)), 0);

  const headerView = headerDraft ?? headerSnapshot(grn);

  const handlePrint = () => {
    // A consignment receive has no QC accept/reject — accepted = received.
    const pdfHeader = {
      grn_number: grn.grn_number,
      status: String(grn.status),
      received_at: grn.received_at ?? '',
      delivery_note_ref: grn.delivery_note_ref ?? null,
      notes: grn.notes ?? null,
      posted_at: grn.posted_at ?? null,
      supplier: grn.supplier ?? undefined,
    };
    const pdfItems = items.map((it) => ({
      material_code: it.material_code,
      material_name: it.material_name,
      qty_received: it.qty_received,
      qty_accepted: it.qty_received,
      qty_rejected: 0,
      rejection_reason: null,
      unit_price_centi: it.unit_price_centi,
    }));
    import('../../vendor/scm/lib/grn-pdf')
      .then(({ generateGrnPdf }) =>
        generateGrnPdf(pdfHeader as never, pdfItems as never, { docTitle: 'CONSIGNMENT RECEIVE', docNoLabel: 'Receive No' }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }));
  };

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(grn)), [k]: v }));
    if (k === 'receivedAt') {
      setLineDrafts((prev) => {
        const next = { ...prev };
        for (const it of items) {
          next[it.id] = { ...(prev[it.id] ?? lineSnapshot(it)), deliveryDate: v || null };
        }
        return next;
      });
    }
  };

  const setLine = (it: GrnItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  /* T12 — patch one variant key on a line + auto-compute bedframe Total Height
     (= Divan + Leg + Gap), mirroring New consignment receive's setVariant. */
  const setVariant = (it: GrnItemRow, key: string, value: unknown) =>
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
        await updateHeader.mutateAsync({ id: grn.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const snap = lineSnapshot(it);
        /* Identity/variants are only editable on MANUAL lines (no
           pc_order_item_id); PCO-sourced lines never send those keys. */
        const manual = !it.pc_order_item_id;
        const identityChanged = manual && (
          d.materialName !== snap.materialName ||
          (d.itemGroup ?? '') !== (snap.itemGroup ?? '') ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify(snap.variants ?? {})
        );
        const changed =
          d.qty !== it.qty_received ||
          d.unitPriceCenti !== it.unit_price_centi ||
          d.discountCenti !== (it.discount_centi ?? 0) ||
          (d.deliveryDate ?? null) !== (it.delivery_date ?? null) ||
          identityChanged;
        if (changed) {
          await updateItem.mutateAsync({
            grnId: grn.id, itemId: it.id,
            qty: d.qty, unitPriceCenti: d.unitPriceCenti,
            discountCenti: d.discountCenti, deliveryDate: d.deliveryDate,
            /* T12 — only manual lines send identity/variants; the server
               recomputes description2 + resyncs inventory. */
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
        title={`${grn.grn_number} — ${grn.supplier?.name ?? grn.supplier?.code ?? '—'}`}
        actions={
          <div className={styles.actions}>
            <div className={styles.totalRail}>
              <span className={styles.totalRailLabel}>Total</span>
              <span className={styles.totalRailValue}>{fmtRm(grandTotal, grn.currency)}</span>
            </div>
            <StatusPill docType="grn" status={grn.status} />
            <RelationshipMapButton type="pcr" id={grn.id} />
            <Button variant="ghost" size="md" onClick={handlePrint}>
              <Printer {...ICON} /><span>Print PDF</span>
            </Button>
            {grn.status === 'POSTED' && !isEditing && (
              <Button variant="ghost" size="md"
                onClick={() => navigate(`/scm/purchase-consignment-returns/new?fromPcReceive=${grn.id}`)}>
                <FileText {...ICON} />
                <span>Raise Return</span>
              </Button>
            )}
            {grn.status === 'POSTED' && !hasChildren && (
              <Button variant="ghost" size="md"
                onClick={async () => {
                  if (!(await askConfirm({
                    title: `Cancel ${grn.grn_number}?`,
                    body: 'This reverses the receipt. Line items stay for audit.',
                    confirmLabel: 'Cancel Receive',
                    danger: true,
                  }))) return;
                  cancel.mutate(grn.id, {
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

      {lockedDueToChildren && (
        <div className={styles.bannerWarn}>
          <strong>Locked</strong> — has a downstream document. Delete it first to edit.
        </div>
      )}

      {/* ── Supplier / dates / warehouse / currency / notes ─────── */}
      <SupplierCard
        grn={grn}
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
          <p className={styles.emptyRow}>No items on this receive.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {visibleItems.map((it, idx) => {
              const d = lineOf(it);
              const lineValueCenti = lineTotalOf(it);
              const variantSummary = buildVariantSummary(it.item_group ?? null, it.variants as Record<string, unknown> | null)
                || it.description
                || it.material_name;
              /* T12 — identity + variants are editable only on MANUAL lines
                 (no pc_order_item_id); PCO-sourced lines stay read-only. */
              const isManualLine = !it.pc_order_item_id;
              const showVariantEditor =
                isEditing && isManualLine && !isLocked &&
                (d.itemGroup === 'bedframe' || d.itemGroup === 'sofa') && !!maint;
              return (
                <div
                  key={it.id}
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
                      {it.item_group && <ItemGroupPill group={it.item_group} />}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span className={styles.previewPrice}>{fmtRm(lineValueCenti, grn.currency)}</span>
                      {isEditing && (
                        <button
                          type="button"
                          /* Commander 2026-06-15 — confirm before delete (no more
                             裸奔). */
                          onClick={async () => {
                            if (isLocked) return;
                            if (await askConfirm({
                              title: 'Remove this line?',
                              body: "The line is removed from this consignment receive.",
                              confirmLabel: 'Remove',
                              danger: true,
                            })) {
                              deleteItem.mutate({ grnId: grn.id, itemId: it.id });
                            }
                          }}
                          title="Remove line"
                          disabled={isLocked || deleteItem.isPending}
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
                      )}
                    </div>
                  </div>

                  <div className={styles.formGrid2}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Item Code (Internal)</span>
                      <input
                        type="text" readOnly value={it.material_code}
                        className={styles.fieldInput}
                        style={{ fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Description</span>
                      {/* T12 — Description editable on MANUAL lines in Edit;
                          read-only on PCO-sourced lines + in View. */}
                      {isEditing && isManualLine ? (
                        <input
                          type="text" value={d.materialName} disabled={isLocked}
                          onChange={(e) => setLine(it, { materialName: e.target.value })}
                          className={styles.fieldInput}
                        />
                      ) : (
                        <input
                          type="text" readOnly value={it.description ?? it.material_name}
                          className={styles.fieldInput}
                          style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                  </div>

                  {/* T12 — variants. Edit + MANUAL bedframe/sofa line → the shared
                      PcVariantEditor; otherwise the read-only summary. PCO-sourced
                      lines stay locked to the summary. */}
                  {showVariantEditor ? (
                    <div style={{ background: 'var(--c-cream)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
                      <div style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 'var(--space-2)' }}>{d.itemGroup} Variants</div>
                      <PcVariantEditor
                        category={d.itemGroup ?? ''}
                        itemCode={it.material_code}
                        variants={(d.variants ?? {}) as Record<string, unknown>}
                        onChange={(k, v) => setVariant(it, k, v)}
                        fabrics={fabrics}
                        maint={maint!}
                      />
                    </div>
                  ) : (
                    variantSummary && (
                      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
                    )
                  )}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                    <span>
                      Received from Order:{' '}
                      <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
                        {it.source_po_number ?? '— (manual)'}
                      </strong>
                    </span>
                    <span>
                      Receive date:{' '}
                      <strong style={{ color: 'var(--fg)' }}>
                        {fmtDateOrDash(it.received_at ?? grn.received_at ?? null)}
                      </strong>
                    </span>
                    <span>
                      Transfer To:{' '}
                      {(it.downstream ?? []).length === 0
                        ? <strong style={{ color: 'var(--fg)' }}>—</strong>
                        : (it.downstream ?? []).map((dn, dni) => (
                            <strong key={dni} style={{ color: 'var(--c-burnt)', marginRight: 8, whiteSpace: 'nowrap' }}>
                              {dn.docNumber} <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>×{dn.qty}</span>
                            </strong>
                          ))}
                    </span>
                  </div>

                  {/* Fields row — Received · Unit Price · Discount · Delivery Date. */}
                  <div className={styles.formGrid4}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Received</span>
                      {isEditing ? (
                        <input
                          type="number" min={0}
                          className={styles.fieldInput} style={{ textAlign: 'right' }}
                          value={d.qty} disabled={isLocked}
                          onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })}
                        />
                      ) : (
                        <input
                          type="text" readOnly value={it.qty_received}
                          className={styles.fieldInput}
                          style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Unit Price ({grn.currency})</span>
                      {isEditing ? (
                        <MoneyInput bare selectOnFocus inputClassName={styles.fieldInput}
                          valueSen={d.unitPriceCenti} disabled={isLocked}
                          onCommit={(sen) => setLine(it, { unitPriceCenti: sen ?? 0 })} />
                      ) : (
                        <input
                          type="text" readOnly value={fmtRm(it.unit_price_centi, grn.currency)}
                          className={styles.fieldInput}
                          style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Discount</span>
                      {isEditing ? (
                        <MoneyInput bare selectOnFocus inputClassName={styles.fieldInput}
                          valueSen={d.discountCenti} disabled={isLocked}
                          onCommit={(sen) => setLine(it, { discountCenti: sen ?? 0 })} />
                      ) : (
                        <input
                          type="text" readOnly
                          value={(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, grn.currency) : '—'}
                          className={styles.fieldInput}
                          style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Delivery Date</span>
                      {isEditing ? (
                        <input
                          type="date" className={styles.fieldInput}
                          value={d.deliveryDate ?? ''} disabled={isLocked}
                          onChange={(e) => setLine(it, { deliveryDate: e.target.value || null })}
                        />
                      ) : (
                        <input
                          type="text" readOnly value={it.delivery_date ?? '—'}
                          className={styles.fieldInput}
                          style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Totals ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Total qty</span>
              <span className={styles.totalValue}>{totalQty}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Subtotal</span>
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, grn.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, grn.currency)}</span>
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
  grn, draft, onField, locked, isEditing = true,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grn: any;
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  const warehousesQ = useWarehouses();
  const warehouses = warehousesQ.data ?? [];
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (grn.supplier_id ?? null);
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
                value={grn.supplier?.name ?? grn.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Currency" value={grn.currency || null} />
            <div />
            <InfoCell label="Received Date" value={grn.received_at ? fmtDateOrDash(grn.received_at) : null} />
            <InfoCell label="Delivery Note Ref" value={grn.delivery_note_ref || null} />
            <InfoCell label="Receive Into"
              value={(() => {
                const wh = warehouses.find((w) => w.id === grn.warehouse_id);
                return wh ? wh.code : null;
              })()} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={grn.notes || null} />
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
            <span className={styles.fieldLabel}>Currency</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.currency} disabled={locked}
                onChange={(e) => onField('currency', e.target.value)}>
                <option value="MYR">MYR</option>
                <option value="RMB">RMB</option>
                <option value="USD">USD</option>
                <option value="SGD">SGD</option>
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <div />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Received Date</span>
            <input type="date" className={styles.fieldInput} value={draft.receivedAt} disabled={locked}
              onChange={(e) => onField('receivedAt', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Delivery Note Ref</span>
            <input className={styles.fieldInput} value={draft.deliveryNoteRef} disabled={locked}
              onChange={(e) => onField('deliveryNoteRef', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Receive Into</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.warehouseId} disabled={locked}
                onChange={(e) => onField('warehouseId', e.target.value)}>
                <option value="">— No warehouse —</option>
                {sortByText(warehouses.filter((w) => w.is_active)).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
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
