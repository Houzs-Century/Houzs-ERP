// ----------------------------------------------------------------------------
// PurchaseReturnDetail — full-page route at /purchase-returns/:id.
//
// EXACT clone of PurchaseOrderDetail / GoodsReceivedDetail / PurchaseInvoiceDetail
// (the gold standard): a draft-style View → Edit → Save/Back machine, Print PDF,
// Cancel. A Purchase Return is CONFIRMED the moment it exists (no Draft
// lifecycle), so POSTED reads as "Confirmed".
//
//   1. Header: back button + Return# · supplier + status pill + actions
//   2. Supplier card: editable supplier + return date + reason + credit note ref
//      + notes (inputs in Edit, read-only InfoCells in View). No currency /
//      warehouse — money shows as MYR.
//   3. Line items table: code + group + variants summary + qty(returned) + unit
//      + total  (a return has NO discount / delivery — qty × unit price)
//   4. Totals card: refund total (live from line items = Σ line_refund_centi)
//
// Draft model (mirrors PO #194 / GRN / PI):
//   • Edit  → snapshots header + lets you edit Qty(returned) / Unit INLINE per
//             row. Nothing persists until the single top Save.
//   • Save  → commits header changes + every changed line's field edits.
//   • Back  → leaves the page, discarding the field-edit draft (no auto-save).
//   • Delete (trash) removes the line immediately (no confirm popup).
//
// purchase_return_status enum: POSTED / COMPLETED / CANCELLED. POSTED →
// "Confirmed" (editable). COMPLETED / CANCELLED render their label and lock the
// page read-only. isLocked = CANCELLED or COMPLETED (mirror GRN's lock logic).
// Cancel reverses the inventory OUT server-side (writes a reversing IN).
//
// HOUZS VENDOR — re-vendored from apps/backend/src/pages/PurchaseReturnDetail.tsx
// (2990 T12, 2026-06-19). Import boundary only: react-router → react-router-dom;
// the PR flow hooks resolve from the vendored split module purchase-return-queries
// (NOT the 2990 flow-queries barrel); suppliers / category-badges / mfg-products
// + the PDF helper → ../../vendor/scm/*; back links repointed to /scm/*. Carries
// 2990's T12 in-place variant editor verbatim (editable Description + per-category
// SOFA/BEDFRAME variant editor + bedframe total-height auto-compute) for existing
// non-sourced bedframe/sofa lines in Edit mode; from-GRN lines stay read-only.
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Undo2, Pencil, Trash2, Printer, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, buildVariantSummary, fmtDateOrDash, maintPickerValues } from '@2990s/shared';
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
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import styles from './SalesOrderDetail.module.css';

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

/* T12 — existing PR lines whose product is a bedframe/sofa get the SAME
   per-category variant editor as New PR. Small local copy of PurchaseReturnNew's
   VariantSelect (not exported there). */
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

/* Draft state shapes (mirror PO #194 / GRN / PI). HeaderDraft mirrors the
   editable PR header fields; LineDraft holds the inline-editable per-line fields
   where qty maps to qty_returned (a return has NO discount / delivery). T12 adds
   the identity/variant fields so a non-sourced PR line can edit its description +
   bedframe/sofa variants; from-GRN lines keep their identity read-only. */
type HeaderDraft = {
  supplierId: string;
  returnDate: string;
  reason: string;
  creditNoteRef: string;
  notes: string;
};
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
  /* From-GRN lines carry the source GRN line id; their identity + variants stay
     read-only to avoid stranding the GRN's returned-qty inventory. Manual /
     PO-sourced lines (no grn_item_id) get full editing. */
  grn_item_id?: string | null;
};

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

export const PurchaseReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = usePurchaseReturnDetail(id ?? null);
  const updateHeader = useUpdatePurchaseReturnHeader();
  const updateItem = useUpdatePurchaseReturnItem();
  const deleteItem = useDeletePurchaseReturnItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseReturn();

  const pr = detail.data?.purchaseReturn ?? null;
  const items = (detail.data?.items ?? []) as PrItemRow[];

  /* T12 — maintenance config + special-orders pools drive the per-category
     variant editor on EXISTING bedframe/sofa lines in Edit mode (same dropdown
     pools as New PR). */
  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat)).map((r) => ({ value: r.code, priceSen: 0 }));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  /* View → Edit gate (mirror PO/GRN/PI) — default read-only View; click Edit to
     flip into draft mode. The PR list's right-click "Edit" lands here with
     ?edit=1. */
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  /* Draft buffers. headerDraft is null until the first header field is touched
     (then seeded from the PR). lineDrafts overlays per-line edits keyed by item
     id; any line without an entry shows its stored values. None of this persists
     until Save. */
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // POSTED ("Confirmed") is editable; COMPLETED / CANCELLED lock read-only
  // (mirror GRN's lock logic).
  const isLocked = pr ? pr.status !== 'POSTED' : true;

  /* If the PR locks while we're in Edit mode (e.g. cancelled in another tab),
     drop back to View + discard the draft. */
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
        <div className={styles.bannerWarn}>
          <strong>Purchase return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* ── Draft helpers (pr is guaranteed non-null past the guards above) ── */
  const visibleItems = items;
  const lineOf = (it: PrItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PrItemRow): number => {
    if (!isEditing) return it.line_refund_centi ?? (it.qty_returned * it.unit_price_centi);
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti;
  };
  const refundTotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);

  const headerView = headerDraft ?? headerSnapshot(pr);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pr)), [k]: v }));
  };

  const setLine = (it: PrItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  /* T12 — patch one variant key on a line + auto-compute bedframe Total Height
     (= Divan + Leg + Gap), mirroring New PR's setVariant. */
  const setVariant = (it: PrItemRow, key: string, value: string) =>
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

  /* Single Save — commit header (only if touched) + every changed line's field
     edits, then drop back to View. Back discards the field-edit draft.
     (Line delete already committed server-side — see the trash handler.) */
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
        /* Identity/variants are editable only on non-sourced lines (no
           grn_item_id); from-GRN lines never send those keys (their identity is
           locked so the GRN's returned-qty inventory can't be stranded). */
        const editableIdentity = !it.grn_item_id;
        const identityChanged = editableIdentity && (
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
            /* T12 — only non-sourced lines send identity/variants; the server
               recomputes description2 + writes inventory with the new identity. */
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
      notify({ title: 'Save failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  const handlePrint = () => {
    // PR PDF (to send to the supplier for credit-note issuance) — mirrors
    // PO/GRN/PI's handlePrint wiring its own purchase-return-pdf helper.
    import('../../vendor/scm/lib/purchase-return-pdf').then(({ generatePurchaseReturnPdf }) =>
      generatePurchaseReturnPdf(pr, items as any),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }));
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
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
          {/* Refund KPI tile — tracks the live line items (incl. unsaved draft
              edits). */}
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Refund</span>
            <span className={styles.totalRailValue}>{fmtRm(refundTotal)}</span>
          </div>
          {/* A return is Confirmed the moment it exists (no Draft/lifecycle). */}
          <StatusPill docType="pr" status={pr.status} />
          <RelationshipMapButton type="pr" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          {/* Cancel — only when the PR is still active (not cancelled / completed).
              Confirm dialog → cancel mutation (reverses the inventory OUT
              server-side — stock is put back). */}
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
          {/* View → Edit gate. Default View shows Edit (disabled while locked);
              editing flips into draft mode and the button becomes the single
              "Save" that commits the whole draft. Back (top-left) discards. */}
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

      {/* ── Supplier / dates / reason / notes ───────────────────── */}
      {/* In View the card renders read-only text; in Edit it shows inputs bound
          to the draft (committed by the single top Save). */}
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
                {/* Actions column only in Edit mode — View is read-only. A return
                    has NO discount / delivery, so no Disc / Delivery columns. */}
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
                const d = lineOf(it);
                /* T12 — identity + variants are editable only on non-sourced lines
                   (no grn_item_id); from-GRN lines stay read-only. */
                const editableIdentity = !it.grn_item_id;
                const showVariantEditor =
                  isEditing && editableIdentity && !isLocked &&
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
                    {/* Per-line ship-from warehouse (Agent D, TASK #32): the same
                        warehouse the PR OUT pulls stock from. Display-only. */}
                    <td className={styles.muted}>{(it.warehouse_code as string | null) ?? '—'}</td>

                    {/* Qty(returned) / Unit are inline-editable in Edit mode (no
                        per-line modal). */}
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
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                        <td className={styles.priceCell}>{fmtRm(lineTotalOf(it))}</td>
                      </>
                    )}
                  </tr>
                  {/* T12 — expanded editor row (Edit mode, non-sourced lines): an
                      editable Description + the per-category variant editor. A
                      from-GRN line gets no editor — its identity stays read-only. */}
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
                                  {/* Total Height auto-computed (see setVariant). */}
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

      {/* ── Totals ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          {/* Refund computed LIVE from the visible line items (incl. unsaved
              draft edits) so it can never drift. A return is qty × unit price —
              no tax / discount. */}
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
   Supplier / header card — controlled by the page's draft (mirror PO/GRN/PI).
   In View it renders read-only InfoCells; in Edit it shows inputs bound to the
   page draft (committed by the single top Save).
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  pr, draft, onField, locked, isEditing = true,
}: {
  pr: any;
  /** Draft header values (page-owned). In View these mirror the saved PR. */
  draft: HeaderDraft;
  /** Update a single header field on the page draft. */
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  /** View → Edit gate. When false the card renders read-only display text. */
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  // In Edit follow the draft's picked supplier; in View follow the saved PR.
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
          /* View mode — read-only display text sourced from the saved PR. */
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

        {/* Supplier-info auto-fill card. Read-only display from /suppliers/:id. */}
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

/* Read-only label/value cell for the supplier auto-fill card. */
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
