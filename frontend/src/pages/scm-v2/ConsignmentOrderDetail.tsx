// ----------------------------------------------------------------------------
// ConsignmentOrderDetail — full-page route at /scm/consignment-orders/:docNo.
//
// Clone of SalesOrderDetail.tsx pointed at the consignment detail hook. Keeps
// the SAME section-card layout (Customer / Order Info / Emergency / Delivery
// Address cards), line-items table with variant pills, and a payments ledger.
// Reuses SoLineCard + PhoneInput UNCHANGED for the inline line editor.
//
// SO-specific actions are intentionally DROPPED here:
//   • Proceed-to-PO / status-flow strip + lock-override banner
//   • MRP coverage (Incoming PO / ETA) column + delivery breakdown
//   • Convert menus (Issue DO / Issue SI)
//   • History (audit-log) drawer + price-override modal
//
// The backend `/consignment-orders` route mirrors `/mfg-sales-orders` 1:1, so
// the detail shape (salesOrder header + items + payments) is identical.
//
// NOTE on payments: the shared <PaymentsTable> saved-mode is hardwired to the
// SO payment endpoints, so to keep this page pointed at /consignment-orders we
// render the payments ledger inline via the consignment payment hooks instead
// of reusing PaymentsTable in saved mode. (The New page DOES reuse PaymentsTable
// unchanged in draft mode.)
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, Printer, Save, X, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, fmtDateOrDash, fmtMoneyCenti, orderLineIdentity } from '@2990s/shared';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  useConsignmentOrderDetail,
  useUpdateConsignmentOrderHeader,
  useAddConsignmentOrderItem,
  useUpdateConsignmentOrderItem,
  useDeleteConsignmentOrderItem,
  useConsignmentDebtorSearch,
  useConsignmentOrderPayments,
  useUploadConsignmentItemPhoto,
  type DebtorSuggestion,
  type ConsignmentPayment,
} from '../../vendor/scm/lib/consignment-order-queries';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useLocalities,
  distinctStates,
  citiesInState,
  postcodesInCity,
  countryForState,
} from '../../vendor/scm/lib/localities-queries';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useVenues } from '../../vendor/scm/lib/venues-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const EMERGENCY_HEADER_NOTE_STYLE: CSSProperties = {
  fontSize: 'var(--fs-12)', color: 'var(--fg-muted)',
};
const DATES_XOR_WARN_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, #B8331F)',
  padding: '4px var(--space-2)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  marginTop: 'var(--space-2)',
};

type ConsignmentHeader = {
  doc_no: string;
  so_date: string;
  status: string;
  debtor_code: string | null;
  debtor_name: string;
  venue: string | null;
  venue_id: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  phone: string | null;
  local_total_centi: number;
  line_count: number;
  currency: string;
  note: string | null;
  customer_state: string | null;
  customer_country: string | null;
  customer_so_no: string | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | null;
  city: string | null;
  postcode: string | null;
  building_type: string | null;
  sales_location: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
};

type ConsignmentItem = {
  id: string;
  doc_no: string;
  item_group: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  total_centi: number;
  /* FINANCE-gated (CO_ITEM_FINANCE_KEYS server-side) — OMITTED from the detail
     payload for a non-finance caller (canViewScmFinance), hence optional. This
     page renders no cost/margin, so there is nothing to cut here. NOTE:
     draftFromItem below collapses a missing unit_cost_centi to 0 and the save
     echoes it back — safe because the CO line PATCH only takes an explicit cost
     when it is > 0 and otherwise falls through to the recompute / stored cost
     (#625's precedence chain; see consignment-orders.ts). */
  unit_cost_centi?: number;
  line_cost_centi?: number;
  line_margin_centi?: number;
  variants: Record<string, unknown> | null;
  remark: string | null;
  cancelled: boolean;
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean;
};

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

const draftFromItem = (it: ConsignmentItem): SoLineDraft => ({
  itemCode:       it.item_code ?? '',
  itemGroup:      it.item_group ?? 'others',
  description:    it.description ?? '',
  uom:            it.uom ?? 'UNIT',
  qty:            it.qty ?? 1,
  unitPriceCenti: it.unit_price_centi ?? 0,
  discountCenti:  it.discount_centi ?? 0,
  unitCostCenti:  it.unit_cost_centi ?? 0,
  variants:       (it.variants as Record<string, unknown>) ?? {},
  remark:         it.remark ?? '',
  lineDeliveryDate:           it.line_delivery_date ?? null,
  lineDeliveryDateOverridden: it.line_delivery_date_overridden ?? false,
});

export const ConsignmentOrderDetail = () => {
  const { docNo } = useParams<{ docNo: string }>();
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const detail = useConsignmentOrderDetail(docNo ?? null);
  const updateHeader = useUpdateConsignmentOrderHeader();
  const addItem = useAddConsignmentOrderItem();
  const updateItem = useUpdateConsignmentOrderItem();
  const deleteItem = useDeleteConsignmentOrderItem();
  const uploadPhoto = useUploadConsignmentItemPhoto();

  const header = (detail.data?.salesOrder as ConsignmentHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as ConsignmentItem[] | undefined) ?? [], [detail.data]);

  /* Per-line "Delivered" drill-down — which Consignment Note shipped how much
     (backend attaches `deliveries` per item via coLineDeliveries). */
  const renderDelivered = (it: ConsignmentItem) => {
    const deliveries = (it as ConsignmentItem & {
      deliveries?: Array<{ noNumber: string; qty: number; status: string }>;
    }).deliveries ?? [];
    if (deliveries.length === 0) return <span className={styles.muted}>—</span>;
    const shipped = deliveries.reduce((s, d) => s + d.qty, 0);
    const remaining = Math.max(0, (it.qty ?? 0) - shipped);
    return (
      <div>
        {deliveries.map((d, di) => (
          <div key={di} style={{ fontWeight: 600, whiteSpace: 'nowrap', fontSize: 'var(--fs-12)' }}>
            {d.noNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{d.qty}</span>
          </div>
        ))}
        <div style={{
          fontSize: 'var(--fs-11)', marginTop: 1,
          color: remaining > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
        }}>
          {remaining > 0 ? `Balance ${remaining}` : 'Fully delivered'}
        </div>
      </div>
    );
  };

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const [addingDraft, setAddingDraft] = useState<SoLineDraft | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  const enterEdit  = () => { setSaveError(null); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    setSaveError(null);
    setIsEditing(false);
  };

  const [savingOrder, setSavingOrder] = useState(false);
  const saveEdit = () => {
    const handle = customerCardRef.current;
    if (!handle || !header) return;
    if (savingOrder) return;
    setSaveError(null);

    if (!handle.getPhone().trim()) {
      notify({ title: 'Phone number is required', body: 'Every consignment order must have a contact number.', tone: 'error' });
      return;
    }
    if (addingDraft && !addingDraft.itemCode.trim()) {
      setSaveError('Pick a product for the new line, or remove it before saving.');
      return;
    }
    const blankLine = Object.values(editingDrafts).find((d) => !d.itemCode.trim());
    if (blankLine) {
      setSaveError('Every line must have a product selected before saving.');
      return;
    }
    if (header?.internal_expected_dd) {
      const variantGaps = [
        ...Object.values(editingDrafts),
        ...(addingDraft ? [addingDraft] : []),
      ]
        .filter((d) => d.itemCode.trim())
        .map((d) => ({ code: d.itemCode, miss: missingRequiredVariants(d.itemGroup, d.variants) }))
        .filter((x) => x.miss.length > 0);
      if (variantGaps.length > 0) {
        setSaveError(
          'Complete all variant selections before saving — '
          + variantGaps.map((x) => `${x.code}: ${x.miss.join(', ')}`).join('; ') + '.',
        );
        return;
      }
    }

    const headerErr = handle.validate();
    if (headerErr) {
      setSaveError(headerErr);
      return;
    }

    setSavingOrder(true);
    const lineEntries = Object.entries(editingDrafts);
    const pendingAdd = addingDraft;

    Promise.all(lineEntries.map(([id, d]) => commitEditingDraft(id, d)))
      .then(() => (pendingAdd ? commitAddLine(pendingAdd) : Promise.resolve()))
      .then(() => new Promise<void>((resolve, rejectSave) => {
        handle.save({
          onSuccess: () => resolve(),
          onError: (msg) => rejectSave(new Error(msg)),
        });
      }))
      .then(() => {
        setSavingOrder(false);
        setIsEditing(false);
      })
      .catch((e) => {
        setSavingOrder(false);
        setSaveError(e instanceof Error ? e.message : 'Something went wrong.');
      });
  };

  const stableDocNo = docNo ?? '';
  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
      updateHeader.mutate(
        { docNo: stableDocNo, ...patch },
        {
          onSuccess: () => cb?.onSuccess?.(),
          onError:   (e) => cb?.onError?.(e instanceof Error ? e.message : 'Something went wrong.'),
        },
      );
    },
    [stableDocNo, updateHeader],
  );

  const patchEditingDraft = useCallback((id: string, patch: Partial<SoLineDraft>) => {
    setEditingDrafts((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  const cascadeDeliveryDateToLines = useCallback((date: string) => {
    const next = date || null;
    setEditingDrafts((prev) => {
      let changed = false;
      const out: Record<string, SoLineDraft> = {};
      for (const [id, d] of Object.entries(prev)) {
        if (!d.lineDeliveryDateOverridden && d.lineDeliveryDate !== next) {
          out[id] = { ...d, lineDeliveryDate: next };
          changed = true;
        } else {
          out[id] = d;
        }
      }
      return changed ? out : prev;
    });
    setAddingDraft((prev) =>
      prev && !prev.lineDeliveryDateOverridden && prev.lineDeliveryDate !== next
        ? { ...prev, lineDeliveryDate: next }
        : prev,
    );
  }, []);

  const removeEditingLine = useCallback((id: string) => {
    setEditingDrafts((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  useEffect(() => {
    if (!isEditing) {
      setEditingDrafts({});
      setAddingDraft(null);
      return;
    }
    setEditingDrafts(() => {
      const next: Record<string, SoLineDraft> = {};
      for (const it of items) next[it.id] = draftFromItem(it);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

  const rowCallbacks = useMemo(() => {
    const map = new Map<string, {
      onChange: (patch: Partial<SoLineDraft>) => void;
      onRemove: () => void;
    }>();
    for (const it of items) {
      map.set(it.id, {
        onChange: (patch) => patchEditingDraft(it.id, patch),
        onRemove: async () => {
          if (await askConfirm({ title: `Remove ${it.item_code} from this consignment order?`, confirmLabel: 'Remove', danger: true })) {
            deleteItem.mutate(
              { docNo: it.doc_no, itemId: it.id },
              { onSuccess: () => removeEditingLine(it.id) },
            );
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, deleteItem, askConfirm]);

  const startAddLine = () => {
    if (!header) return;
    setAddingDraft({
      ...emptySoLine(),
      lineDeliveryDate: header.customer_delivery_date ?? null,
      lineDeliveryDateOverridden: false,
    });
  };

  const cancelAddLine = useCallback(() => setAddingDraft(null), []);

  const patchAddingDraft = useCallback(
    (patch: Partial<SoLineDraft>) =>
      setAddingDraft((prev) => prev ? { ...prev, ...patch } : prev),
    [],
  );

  const commitEditingDraft = (id: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      docNo: header!.doc_no,
      itemId: id,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceCenti: d.unitPriceCenti,
      discountCenti:  d.discountCenti,
      unitCostCenti:  d.unitCostCenti,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate:           d.lineDeliveryDate ?? null,
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });

  const commitAddLine = async (d: SoLineDraft) => {
    const pendingFiles = d.pendingPhotoFiles ?? [];
    const res = await addItem.mutateAsync({
      docNo: header!.doc_no,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceCenti: d.unitPriceCenti,
      discountCenti:  d.discountCenti,
      unitCostCenti:  d.unitCostCenti,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate:           d.lineDeliveryDate ?? null,
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });
    const newItemId = (res.item as { id?: string } | null)?.id;
    if (newItemId && pendingFiles.length > 0) {
      let failed = 0;
      for (const f of pendingFiles) {
        try {
          await uploadPhoto.mutateAsync({ docNo: header!.doc_no, itemId: newItemId, file: f });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[consignment-line-photos] add-line upload failed', { file: f.name, err });
          failed++;
        }
      }
      if (failed > 0) {
        notify({
          title: 'Photo upload failed',
          body: `Line added, but ${failed} staged photo${failed === 1 ? '' : 's'} ` +
            `failed to upload. Please re-attach on the row.`,
          tone: 'error',
        });
      }
    }
  };

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className="space-y-4">
        <Link to="/scm/consignment-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Consignment order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const handlePrint = () => {
    // The raw detail response carries the category-total fields the SO PDF
    // needs (the typed subset above omits them). Consignment has no payments.
    import('../../vendor/scm/lib/sales-order-pdf')
      .then(({ generateSalesOrderPdf }) =>
        generateSalesOrderPdf(header as never, items as never, [], 'save', [], {
          docTitle: 'CONSIGNMENT ORDER', docNoLabel: 'CO No', docNoun: 'consignment order',
        }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }));
  };

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────── */}
      <PageHeader back
        eyebrow="Supply Chain"
        title={`${header.doc_no} — ${header.debtor_name}`}
        description={`Date ${fmtDateOrDash(header.so_date)} · ${header.line_count} ${header.line_count === 1 ? 'line' : 'lines'}${header.customer_so_no ? ` · Customer Ref ${header.customer_so_no}` : ''}`}
        actions={
          <>
          <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>
              {fmtRm(header.local_total_centi, header.currency)}
            </span>
          </div>
          <RelationshipMapButton type="cso" id={header.doc_no} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} /><span>Print PDF</span>
          </Button>
          {!isEditing ? (
            <>
              <Button variant="ghost" size="md"
                onClick={() => navigate(`/scm/consignment-notes/new?fromConsignmentOrder=${encodeURIComponent(header.doc_no)}`)}>
                <FileText {...ICON} />
                <span>Create Consignment Note</span>
              </Button>
              <Button variant="primary" size="md" onClick={enterEdit}>
                <Pencil {...ICON} />
                <span>Edit</span>
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="md"
                onClick={cancelEdit} disabled={updateHeader.isPending || savingOrder}>
                <span>Cancel</span>
              </Button>
              <Button variant="primary" size="md"
                onClick={saveEdit} disabled={updateHeader.isPending || savingOrder}>
                <Save {...ICON} />
                <span>{updateHeader.isPending || savingOrder ? 'Saving…' : 'Save'}</span>
              </Button>
            </>
          )}
          </div>
          </>
        }
      />

      {saveError && (
        <div className={styles.bannerWarn}>
          <strong>Save failed.</strong>
          <span>{saveError}</span>
        </div>
      )}

      {/* ── Customer info ───────────────────────────────────────── */}
      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        saving={updateHeader.isPending}
        isEditing={isEditing}
        onDeliveryDateChange={cascadeDeliveryDateToLines}
      />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
          {isEditing && !addingDraft && (
            <Button variant="primary" size="sm" onClick={startAddLine}>
              <Plus {...ICON} />
              <span>Add Line Item</span>
            </Button>
          )}
        </header>

        {items.length === 0 && !isEditing ? (
          <p className={styles.emptyRow}>No items yet — click "Edit" then "Add Line Item" to begin.</p>
        ) : isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {items.map((it, idx) => {
              const editDraft = editingDrafts[it.id];
              if (!editDraft) return null;
              const cb = rowCallbacks.get(it.id);
              return (
                <SoLineCard
                  key={it.id}
                  index={idx}
                  draft={editDraft}
                  onChange={cb?.onChange ?? ((patch) => patchEditingDraft(it.id, patch))}
                  onRemove={cb?.onRemove ?? (() => removeEditingLine(it.id))}
                  canRemove
                  docNo={header.doc_no}
                  itemId={it.id}
                  isEditing
                />
              );
            })}

            {addingDraft && (
              <SoLineCard
                index={items.length}
                draft={addingDraft}
                onChange={patchAddingDraft}
                onRemove={cancelAddLine}
                canRemove
              />
            )}

            {items.length === 0 && !addingDraft && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add Line Item" above to begin.
              </p>
            )}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Description 2</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Delivery</th>
                <th className={styles.tableRight}>Total</th>
                <th>Delivered</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const displayDate = it.line_delivery_date
                  ?? (!it.line_delivery_date_overridden ? header.customer_delivery_date : null);
                const isAuto = !it.line_delivery_date_overridden;
                return (
                  <tr key={it.id}>
                    <td>
                      {/* Item CODE (owner 2026-07-24, orderLineIdentity) — the
                          shared order-line rule (vendor/shared/line-identity.ts),
                          same shape as SO/DO/DR/SI detail. Description dropped;
                          the variant rides its OWN "Description 2" column
                          below. */}
                      <div className={styles.codeCell}>
                        {orderLineIdentity({ code: it.item_code, description: it.description }).primary || '—'}
                      </div>
                    </td>
                    <td>
                      {(() => {
                        // Description 2 — live recompute first so detail matches list/PDF
                        // (Commander 2026-06-18). Stored is only a fallback.
                        const desc2 = buildVariantSummary(it.item_group, it.variants)
                          || (it.description2 && it.description2.trim()) || '';
                        return desc2
                          ? <span>{desc2}</span>
                          : <span className={styles.muted}>—</span>;
                      })()}
                    </td>
                    <td className={styles.tableRight}>{it.qty}</td>
                    <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, header.currency)}</td>
                    <td className={styles.tableRight}>{it.discount_centi > 0 ? fmtRm(it.discount_centi, header.currency) : '—'}</td>
                    <td className={styles.tableRight}>
                      {displayDate ? (
                        <span style={isAuto ? { color: 'var(--fg-muted)' } : undefined}>
                          {fmtDateOrDash(displayDate)}
                          {isAuto && (
                            <span style={{ marginLeft: 4, color: 'var(--c-orange)', fontSize: 'var(--fs-11)' }}>· auto</span>
                          )}
                        </span>
                      ) : '—'}
                    </td>
                    <td className={styles.priceCell}>{fmtRm(it.total_centi, header.currency)}</td>
                    <td>{renderDelivered(it)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* PAYMENTS removed (Wei Siang 2026-06-06): a consignment is goods placed
          on loan at the showroom, not a sale — no money is collected, so there
          is no payments ledger. */}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer info card — 4-card split (Customer / Order Info / Emergency /
   Delivery Address) with debtor autocomplete + locality cascades. Clone of
   SalesOrderDetail's CustomerCard, minus the SO-only Proceed Date / signature /
   slip cards.
   ════════════════════════════════════════════════════════════════════════ */
type CustomerCardHandle = {
  validate: () => string | null;
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
  getPhone: () => string;
};

type CustomerCardProps = {
  header: ConsignmentHeader;
  onSave: (
    patch: Record<string, unknown>,
    cb?: { onSuccess?: () => void; onError?: (msg: string) => void },
  ) => void;
  saving: boolean;
  isEditing?: boolean;
  onDeliveryDateChange?: (date: string) => void;
};

const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header,
  onSave,
  saving: _saving,
  isEditing = false,
  onDeliveryDateChange,
}, ref) => {
  const notify = useNotify();
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  const staffQ = usePickableStaff({ onlySales: true });
  const staffList = (staffQ.data ?? []).filter((s) => s.active);
  const { can } = useHouzsAuth();
  const venuesQ = useVenues();
  const stateWarehousesQ = useStateWarehouseMappings();
  // Houzs-flavoured: gate on the flat permission key `scm.so.attribute_other`
  // (the 2990 bridge always reports either super_admin or sales). Owner + IT
  // Admin pass via `*`; grant to other positions via Team > Positions.
  const canChangeSalesperson = can('scm.so.attribute_other');

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);

  const initialFormFor = (h: ConsignmentHeader) => ({
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    venue: h.venue ?? '',
    venueId: h.venue_id ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? h.address3 ?? '',
    postcode: h.postcode ?? h.address4 ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    processingDate: h.internal_expected_dd ?? '',
    customerDeliveryDate: h.customer_delivery_date ?? '',
    note: h.note ?? '',
    salesLocation: h.sales_location ?? '',
  });

  const [form, setForm] = useState(() => initialFormFor(header));
  const [showSuggest, setShowSuggest] = useState(false);
  const debouncedDebtorQ = useDebouncedValue(form.customerName, 200);
  const debtorQuery = useConsignmentDebtorSearch(debouncedDebtorQ);
  const suggestions = (debtorQuery.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? '').toLowerCase() !== form.customerName.trim().toLowerCase(),
  );

  useEffect(() => {
    setForm(initialFormFor(header));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!form.salespersonId) return;
    const picked = staffList.find((s) => s.id === form.salespersonId);
    const resolvedId = picked?.venueId ?? '';
    const resolvedName =
      (venuesQ.data ?? []).find((v) => v.id === resolvedId)?.name ?? '';
    if (resolvedId === form.venueId && resolvedName === form.venue) return;
    setForm((s) => ({ ...s, venueId: resolvedId, venue: resolvedName }));
  }, [form.salespersonId, staffList, venuesQ.data, form.venueId, form.venue]);

  useEffect(() => {
    if (!form.state) return;
    const list = stateWarehousesQ.data?.mappings ?? [];
    if (list.length === 0) return;
    const hit = list.find((m) => m.state === form.state);
    const code = hit?.warehouse?.code ?? hit?.warehouse?.name ?? null;
    if (!code) return;
    if (form.salesLocation === code) return;
    setForm((s) => ({ ...s, salesLocation: code }));
  }, [form.state, stateWarehousesQ.data, form.salesLocation]);

  const states = useMemo(() => distinctStates(localityRows), [localityRows]);
  const cities = useMemo(
    () => (form.state ? citiesInState(localityRows, form.state) : []),
    [localityRows, form.state],
  );
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );
  const country = useMemo<string>(() => {
    const headerCountry = (header.customer_country as string | null | undefined) ?? null;
    if (headerCountry) return headerCountry;
    const derived = form.state ? countryForState(localityRows, form.state) : null;
    return derived ?? 'Malaysia';
  }, [header, form.state, localityRows]);

  const applySuggestion = (d: DebtorSuggestion) => {
    setForm((s) => ({
      ...s,
      customerCode: d.debtor_code ?? s.customerCode,
      customerName: d.debtor_name ?? s.customerName,
      phone: d.phone ?? s.phone,
      address1: d.address1 ?? s.address1,
      address2: d.address2 ?? s.address2,
      city: d.address3 ?? s.city,
      postcode: d.address4 ?? s.postcode,
    }));
    setShowSuggest(false);
  };

  const buildPayload = () => ({
    debtorCode: form.customerCode,
    debtorName: form.customerName,
    customerSoNo: form.customerSoNo || null,
    email: form.email,
    customerType: form.customerType,
    salespersonId: form.salespersonId || null,
    buildingType: form.buildingType,
    venue: form.venue,
    venueId: form.venueId || null,
    phone: form.phone,
    address1: form.address1,
    address2: form.address2,
    city: form.city,
    postcode: form.postcode,
    customerState: form.state,
    emergencyContactName: form.emergencyContactName,
    emergencyContactPhone: form.emergencyContactPhone,
    emergencyContactRelationship: form.emergencyContactRelationship,
    internalExpectedDd: form.processingDate || null,
    customerDeliveryDate: form.customerDeliveryDate || null,
    note: form.note,
    salesLocation: form.salesLocation || null,
  });

  const datesXor =
    (form.processingDate.trim() !== '') !== (form.customerDeliveryDate.trim() !== '');
  const today = new Date().toLocaleDateString('en-CA');
  const originalProcessing = header.internal_expected_dd ?? '';
  const originalDelivery = header.customer_delivery_date ?? '';
  const processingLocked = originalProcessing !== '' && originalProcessing < today;

  const validateDates = (): string | null => {
    if (datesXor) {
      return 'Processing Date and Delivery Date must be set together.\n\n' +
        'Either fill in BOTH dates, or leave BOTH empty.';
    }
    if (form.processingDate && form.processingDate < today && form.processingDate !== originalProcessing) {
      return 'Processing Date cannot be in the past — pick today or a future date.';
    }
    if (form.customerDeliveryDate && form.customerDeliveryDate < today && form.customerDeliveryDate !== originalDelivery) {
      return 'Delivery Date cannot be in the past — pick today or a future date.';
    }
    if (form.processingDate && form.customerDeliveryDate && form.processingDate > form.customerDeliveryDate) {
      return 'Processing Date cannot be later than the Delivery Date.';
    }
    return null;
  };

  const trySave = (cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
    const err = validateDates();
    if (err) {
      if (cb?.onError) cb.onError(err);
      else notify({ title: 'Cannot save', body: err, tone: 'error' });
      return;
    }
    onSave(buildPayload(), cb);
  };

  useImperativeHandle(ref, () => ({
    validate: () => validateDates(),
    save: (cb) => trySave(cb),
    reset: () => setForm(initialFormFor(header)),
    getPhone: () => form.phone ?? '',
  }));

  const inputsDisabled = !isEditing;

  return (
    <>
      {/* ── CUSTOMER ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input
                className={styles.fieldInput}
                value={form.customerName}
                disabled={inputsDisabled}
                onChange={(e) => { set('customerName', e.target.value); setShowSuggest(true); }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              />
              {showSuggest && suggestions.length > 0 && !inputsDisabled && (
                <ul className={styles.suggestList}>
                  {suggestions.slice(0, 8).map((d, i) => (
                    <li
                      key={`${d.debtor_code ?? ''}-${i}`}
                      className={styles.suggestItem}
                      onMouseDown={() => applySuggestion(d)}
                    >
                      <div>{d.debtor_name}</div>
                      {(d.debtor_code || d.phone) && (
                        <div className={styles.suggestCode}>
                          {d.debtor_code ?? ''}{d.debtor_code && d.phone ? ' · ' : ''}{formatPhone(d.phone) || ''}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Ref</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / order number"
                disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <PhoneInput
                className={styles.fieldInput}
                value={form.phone}
                disabled={inputsDisabled}
                onChange={(v) => set('phone', v)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email *</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={inputsDisabled}
                onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={inputsDisabled}
                  onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => (
                    <option key={t.id} value={t.value}>{t.label}</option>
                  ))}
                  {form.customerType && !customerTypeOpts.some((t) => t.value === form.customerType) && (
                    <option value={form.customerType}>{form.customerType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.salespersonId}
                  disabled={inputsDisabled || !canChangeSalesperson}
                  onChange={(e) => set('salespersonId', e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>
                  ))}
                  {form.salespersonId
                    && !staffList.some((s) => s.id === form.salespersonId)
                    && (
                      <option value={form.salespersonId}>
                        (former staff)
                      </option>
                    )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── ORDER INFO ────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Info</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled}
                  onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => (
                    <option key={b.id} value={b.value}>{b.label}</option>
                  ))}
                  {form.buildingType && !buildingTypeOpts.some((b) => b.value === form.buildingType) && (
                    <option value={form.buildingType}>{form.buildingType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={form.venue || '—'}
                disabled readOnly
                aria-label="Venue (auto-set from salesperson)" />
              <span style={{
                fontSize: 'var(--fs-11)',
                color: 'var(--fg-muted)',
                marginTop: 2,
              }}>
                Auto-set from the salesperson's assigned venue. Contact admin to change.
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <input type="date" className={styles.fieldInput} value={form.processingDate}
                disabled={inputsDisabled || processingLocked}
                title={processingLocked ? 'Processing date has passed — locked.' : undefined}
                min={processingLocked ? undefined : today}
                onChange={(e) => set('processingDate', e.target.value)}
                style={datesXor && !form.processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <input type="date" className={styles.fieldInput} value={form.customerDeliveryDate}
                disabled={inputsDisabled}
                min={today}
                onChange={(e) => { set('customerDeliveryDate', e.target.value); onDeliveryDateChange?.(e.target.value); }}
                style={datesXor && !form.customerDeliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined} />
            </label>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={inputsDisabled}
                onChange={(e) => set('note', e.target.value)} />
            </label>
          </div>
          {datesXor && (
            <div style={DATES_XOR_WARN_STYLE}>
              ⚠ Processing Date and Delivery Date must be set together — Save is blocked.
            </div>
          )}
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ─────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={EMERGENCY_HEADER_NOTE_STYLE}>
            Used only if we cannot reach the customer on delivery day
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={form.emergencyContactName}
                placeholder="e.g. Lim Mei Hua"
                disabled={inputsDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={inputsDisabled}
                  onChange={(e) => set('emergencyContactRelationship', e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => (
                    <option key={r.id} value={r.value}>{r.label}</option>
                  ))}
                  {form.emergencyContactRelationship &&
                    !relationshipOpts.some((r) => r.value === form.emergencyContactRelationship) && (
                    <option value={form.emergencyContactRelationship}>
                      {form.emergencyContactRelationship}
                    </option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput
                className={styles.fieldInput}
                value={form.emergencyContactPhone}
                disabled={inputsDisabled}
                onChange={(v) => set('emergencyContactPhone', v)}
              />
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY ADDRESS ──────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={form.address1}
                placeholder="Unit, street, area"
                disabled={inputsDisabled}
                onChange={(e) => set('address1', e.target.value)} />
            </label>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={form.address2}
                placeholder="Apt, floor, building (optional)"
                disabled={inputsDisabled}
                onChange={(e) => set('address2', e.target.value)} />
            </label>
            {/* Owner spec 2026-07-23 — StatePicker (MY-default, click Others for CN/SG, Search). Same shared component as Warehouse / Supplier / Venue / MobileNewSO / SalesOrderNew / SalesOrderDetail. No `(legacy)` sneak-through, no free-text fallback. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={form.state}
                onChange={(next) => setForm((s) => ({ ...s, state: next, city: '', postcode: '' }))}
                disabled={inputsDisabled}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={form.city}
                  onChange={(v) => setForm((s) => ({ ...s, city: v, postcode: '' }))}
                  disabled={inputsDisabled || !form.state}
                  placeholder={form.state ? 'Pick city' : '— pick state first'}
                  options={sortByText(cities).map((c) => ({ value: c, label: c }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={form.postcode}
                  onChange={(v) => set('postcode', v)}
                  disabled={inputsDisabled || !form.city}
                  placeholder={form.city ? 'Pick postcode' : '— pick city first'}
                  options={sortByNumeric(postcodes).map((p) => ({ value: p, label: p }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Country</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}>
                {country}
              </span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}
                title={form.salesLocation
                  ? `Auto-set from State → Warehouse mapping for "${form.state}"`
                  : 'Pick a State above to auto-set'}
              >
                {form.salesLocation || header.sales_location || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
});
CustomerCardInner.displayName = 'ConsignmentCustomerCardInner';
const CustomerCard = memo(CustomerCardInner) as typeof CustomerCardInner;
