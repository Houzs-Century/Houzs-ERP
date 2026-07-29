// ----------------------------------------------------------------------------
// ConsignmentNoteDetail — full-page route at /scm/consignment-notes/:id.
//
// Editable clone of DeliveryOrderDetail (itself an SO clone). View→Edit gate;
// editable Customer / Delivery Info / Emergency Contact / Delivery Address /
// Line Items, plus a read-only Payments ledger. Reuses the shared SoLineCard +
// PhoneInput + SalesOrderDetail.module.css UNCHANGED so the Note Detail reads
// identically to the DO Detail.
//
// The DO-specific Sales-Invoice / Delivery-Return convert actions are DROPPED.
// The backend `/consignment-notes` route mirrors `/delivery-orders-mfg` 1:1, so
// the detail shape (deliveryOrder header + items + payments) is identical.
//
// NOTE on payments: the shared <PaymentsTable> saved-mode is hardwired to the
// DO payment endpoints, so to keep this page pointed at /consignment-notes the
// payments ledger renders inline via the consignment-note payment hooks. (The
// New page DOES reuse PaymentsTable unchanged in draft mode.)
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  ArrowLeft, FileText, Pencil, Plus, Printer, Save, Ban, RotateCcw, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash, fmtMoneyCenti, orderLineIdentity } from '@2990s/shared';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import {
  useConsignmentNoteDetail,
  useUpdateConsignmentNoteHeader,
  useUpdateConsignmentNoteStatus,
  useAddConsignmentNoteItem,
  useUpdateConsignmentNoteItem,
  useDeleteConsignmentNoteItem,
  useConsignmentNotePayments,
  type ConsignmentNotePayment,
} from '../../vendor/scm/lib/consignment-note-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
} from '../../vendor/scm/lib/localities-queries';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_FLOW = ['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED'] as const;
type CnStatus = typeof STATUS_FLOW[number];

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

type CnHeader = {
  id: string;
  do_number: string;
  status: CnStatus;
  do_date: string;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  branding: string | null;
  venue: string | null;
  venue_id: string | null;
  ref: string | null;
  customer_so_no: string | null;
  sales_location: string | null;
  customer_state: string | null;
  customer_country: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  phone: string | null;
  note: string | null;
  driver_id: string | null;
  driver_name: string | null;
  vehicle: string | null;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  local_total_centi: number;
  line_count: number;
  currency: string;
};

type CnItem = {
  id: string;
  consignment_delivery_order_id: string;
  item_group: string | null;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  /* FINANCE-gated (CN_ITEM_FINANCE_KEYS server-side) — OMITTED from the detail
     payload for a non-finance caller (canViewScmFinance), hence optional. This
     page renders no cost/margin, so there is nothing to cut here. NOTE:
     draftFromItem below collapses a missing unit_cost_centi to 0 and the save
     echoes it back — the route's line PATCH therefore IGNORES a client cost
     from a non-finance caller and keeps the stored one, which is what stops the
     strip from wiping the line's cost basis (#632; see consignment-notes.ts). */
  unit_cost_centi?: number;
  line_cost_centi?: number;
  line_margin_centi?: number;
  variants: Record<string, unknown> | null;
  remark: string | null;
};

const draftFromItem = (it: CnItem): SoLineDraft => ({
  itemCode: it.item_code ?? '',
  itemGroup: it.item_group ?? 'others',
  description: it.description ?? '',
  uom: it.uom ?? 'UNIT',
  qty: it.qty ?? 1,
  unitPriceCenti: it.unit_price_centi ?? 0,
  discountCenti: it.discount_centi ?? 0,
  unitCostCenti: it.unit_cost_centi ?? 0,
  variants: (it.variants as Record<string, unknown>) ?? {},
  remark: it.remark ?? '',
});

export const ConsignmentNoteDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const detail = useConsignmentNoteDetail(id ?? null);
  const updateHeader = useUpdateConsignmentNoteHeader();
  const updateStatus = useUpdateConsignmentNoteStatus();
  const addItem = useAddConsignmentNoteItem();
  const updateItem = useUpdateConsignmentNoteItem();
  const deleteItem = useDeleteConsignmentNoteItem();

  const header = (detail.data?.deliveryOrder as CnHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as CnItem[] | undefined) ?? [], [detail.data]);

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const [addingDraft, setAddingDraft] = useState<SoLineDraft | null>(null);

  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  const lockedStatuses: CnStatus[] = ['INVOICED', 'CANCELLED'];

  const enterEdit = () => { setSaveError(null); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    setSaveError(null);
    setIsEditing(false);
  };

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

  const stableId = id ?? '';
  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
      updateHeader.mutate(
        { id: stableId, ...patch },
        {
          onSuccess: () => cb?.onSuccess?.(),
          onError: (e) => cb?.onError?.(e instanceof Error ? e.message : 'Something went wrong.'),
        },
      );
    },
    [stableId, updateHeader],
  );

  const patchEditingDraft = useCallback((lineId: string, patch: Partial<SoLineDraft>) => {
    setEditingDrafts((prev) => {
      const cur = prev[lineId];
      if (!cur) return prev;
      return { ...prev, [lineId]: { ...cur, ...patch } };
    });
  }, []);

  const removeEditingLine = useCallback((lineId: string) => {
    setEditingDrafts((prev) => {
      if (!(lineId in prev)) return prev;
      const { [lineId]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const rowCallbacks = useMemo(() => {
    const map = new Map<string, { onChange: (patch: Partial<SoLineDraft>) => void; onRemove: () => void }>();
    for (const it of items) {
      map.set(it.id, {
        onChange: (patch) => patchEditingDraft(it.id, patch),
        onRemove: async () => {
          if (await askConfirm({
            title: `Remove ${it.item_code} from this consignment note?`,
            confirmLabel: 'Remove',
            danger: true,
          })) {
            deleteItem.mutate(
              { id: it.consignment_delivery_order_id, itemId: it.id },
              { onSuccess: () => removeEditingLine(it.id) },
            );
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, deleteItem, askConfirm]);

  const startAddLine = () => setAddingDraft({ ...emptySoLine() });
  const cancelAddLine = useCallback(() => setAddingDraft(null), []);
  const patchAddingDraft = useCallback(
    (patch: Partial<SoLineDraft>) => setAddingDraft((prev) => prev ? { ...prev, ...patch } : prev),
    [],
  );

  const commitEditingDraft = (lineId: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      id: header!.id, itemId: lineId,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, remark: d.remark,
    });

  const commitAddLine = (d: SoLineDraft) =>
    addItem.mutateAsync({
      id: header!.id,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, remark: d.remark,
    });

  const saveEdit = () => {
    const handle = customerCardRef.current;
    if (!handle || !header || savingOrder) return;
    setSaveError(null);

    if (addingDraft && !addingDraft.itemCode.trim()) {
      setSaveError('Pick a product for the new line, or remove it before saving.');
      return;
    }
    const blankLine = Object.values(editingDrafts).find((d) => !d.itemCode.trim());
    if (blankLine) {
      setSaveError('Every line must have a product selected before saving.');
      return;
    }

    setSavingOrder(true);
    const lineEntries = Object.entries(editingDrafts);
    const pendingAdd = addingDraft;

    handle.save({
      onSuccess: () => {
        Promise.all(lineEntries.map(([lineId, d]) => commitEditingDraft(lineId, d)))
          .then(async () => { if (pendingAdd) await commitAddLine(pendingAdd); })
          .then(() => { setSavingOrder(false); setIsEditing(false); })
          .catch((e) => {
            setSavingOrder(false);
            setSaveError(`Lines failed to save: ${e instanceof Error ? e.message : 'Something went wrong.'}`);
          });
      },
      onError: (msg) => { setSavingOrder(false); setSaveError(msg); },
    });
  };

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className="space-y-4">
        <Link to="/scm/consignment-notes" className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Consignment note not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const isLocked = lockedStatuses.includes(header.status);
  const isCancelled = header.status === 'CANCELLED';

  const handlePrint = () => {
    import('../../vendor/scm/lib/delivery-order-pdf')
      .then(({ generateDeliveryOrderPdf }) =>
        generateDeliveryOrderPdf(header as never, items as never, { docTitle: 'CONSIGNMENT NOTE', docNoLabel: 'CN No', showPicking: false }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }));
  };

  const handleCancel = async () => {
    if (!(await askConfirm({
      title: `Cancel ${header.do_number}?`,
      body: 'This sets status = CANCELLED.',
      confirmLabel: 'Cancel note',
      danger: true,
    }))) return;
    updateStatus.mutate({ id: header.id, status: 'CANCELLED' });
  };
  const handleReopen = async () => {
    if (!(await askConfirm({
      title: `Reopen ${header.do_number} back to LOADED?`,
      confirmLabel: 'Reopen',
    }))) return;
    updateStatus.mutate({ id: header.id, status: 'LOADED' });
  };

  return (
    <div className="space-y-4" style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header ── */}
      <PageHeader back
        eyebrow="Supply Chain"
        title={`${header.do_number} — ${header.debtor_name}`}
        description={`Date ${fmtDateOrDash(header.do_date)} · ${header.line_count} ${header.line_count === 1 ? 'line' : 'lines'}${header.customer_so_no ? ` · Customer Ref ${header.customer_so_no}` : ''}`}
        actions={
          <>
          <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(header.local_total_centi, header.currency)}</span>
          </div>
          <StatusPill docType="do" status={header.status} />
          <RelationshipMapButton type="cdo" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer size={15} strokeWidth={1.75} /><span>Print PDF</span>
          </Button>
          {!isCancelled && !isEditing && (
            <Button variant="ghost" size="md"
              onClick={() => navigate(`/scm/consignment-returns/new?fromConsignmentNote=${id}`)}>
              <FileText {...ICON} /><span>Create Consignment Return</span>
            </Button>
          )}
          {isCancelled ? (
            <Button variant="primary" size="md" onClick={handleReopen} disabled={updateStatus.isPending}>
              <RotateCcw {...ICON} /><span>Reopen Note</span>
            </Button>
          ) : !isEditing ? (
            <Button variant="ghost" size="md" onClick={handleCancel} disabled={updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Ban {...ICON} /><span>Cancel Note</span>
            </Button>
          ) : null}
          {!isEditing ? (
            <Button variant="primary" size="md" onClick={enterEdit} disabled={isLocked}>
              <Pencil {...ICON} /><span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="md" onClick={cancelEdit} disabled={updateHeader.isPending || savingOrder}>
                <span>Cancel</span>
              </Button>
              <Button variant="primary" size="md" onClick={saveEdit} disabled={updateHeader.isPending || savingOrder}>
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

      {/* ── Customer / Delivery Info / Emergency / Address cards ── */}
      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        locked={isLocked}
        isEditing={isEditing}
      />

      {/* ── Line items ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
          {isEditing && !addingDraft && (
            <Button variant="primary" size="sm" onClick={startAddLine} disabled={isLocked}>
              <Plus {...ICON} /><span>Add Line Item</span>
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
                  canRemove={!isLocked}
                />
              );
            })}
            {addingDraft && (
              <SoLineCard
                index={items.length}
                draft={addingDraft}
                onChange={patchAddingDraft}
                onRemove={cancelAddLine}
                canRemove={true}
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
                <th className={styles.tableRight}>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    {/* Item CODE (owner 2026-07-24, orderLineIdentity) — the
                        shared order-line rule (vendor/shared/line-identity.ts),
                        same shape as SO/DO/DR/SI detail. Description dropped; the
                        variant rides its OWN "Description 2" column below. */}
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
                      return desc2 ? <span>{desc2}</span> : <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, header.currency)}</td>
                  <td className={styles.tableRight}>{it.discount_centi > 0 ? fmtRm(it.discount_centi, header.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_centi, header.currency)}</td>
                </tr>
              ))}
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
   Customer / Delivery Info / Emergency / Delivery Address — editable cards.
   Mirrors DeliveryOrderDetail's CustomerCard (adapted to CN fields).
   ════════════════════════════════════════════════════════════════════════ */

type CustomerCardHandle = {
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
};

type CustomerCardProps = {
  header: CnHeader;
  onSave: (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => void;
  locked?: boolean;
  isEditing?: boolean;
};

const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header, onSave, locked = false, isEditing = false,
}, ref) => {
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  const staffQ = usePickableStaff({ onlySales: true });
  const staffList = (staffQ.data ?? []).filter((s) => s.active);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  const initialFormFor = (h: CnHeader) => ({
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    venue: h.venue ?? '',
    vehicle: h.vehicle ?? '',
    driverName: h.driver_name ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? '',
    postcode: h.postcode ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    doDate: h.do_date ?? '',
    expectedDeliveryAt: h.expected_delivery_at ?? '',
    customerDeliveryDate: h.customer_delivery_date ?? '',
    note: h.note ?? '',
    salesLocation: h.sales_location ?? '',
  });

  const [form, setForm] = useState(() => initialFormFor(header));

  useEffect(() => {
    setForm(initialFormFor(header));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  const states = useMemo(() => distinctStates(localityRows), [localityRows]);
  const cities = useMemo(() => (form.state ? citiesInState(localityRows, form.state) : []), [localityRows, form.state]);
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );

  const buildPayload = () => ({
    debtorCode: form.customerCode,
    debtorName: form.customerName,
    customerSoNo: form.customerSoNo || null,
    email: form.email,
    customerType: form.customerType,
    salespersonId: form.salespersonId || null,
    buildingType: form.buildingType,
    venue: form.venue,
    vehicle: form.vehicle,
    driverName: form.driverName,
    phone: form.phone,
    address1: form.address1,
    address2: form.address2,
    city: form.city,
    postcode: form.postcode,
    customerState: form.state,
    state: form.state,
    emergencyContactName: form.emergencyContactName,
    emergencyContactPhone: form.emergencyContactPhone,
    emergencyContactRelationship: form.emergencyContactRelationship,
    doDate: form.doDate || null,
    expectedDeliveryAt: form.expectedDeliveryAt || null,
    customerDeliveryDate: form.customerDeliveryDate || null,
    note: form.note,
    salesLocation: form.salesLocation || null,
  });

  useImperativeHandle(ref, () => ({
    save: (cb) => onSave(buildPayload(), cb),
    reset: () => setForm(initialFormFor(header)),
  }));

  const inputsDisabled = !isEditing || locked;

  return (
    <>
      {/* ── CUSTOMER ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input className={styles.fieldInput} value={form.customerName}
                disabled={inputsDisabled} onChange={(e) => set('customerName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Ref</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / order number" disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <PhoneInput className={styles.fieldInput} value={form.phone} disabled={inputsDisabled} onChange={(v) => set('phone', v)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={inputsDisabled} onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={inputsDisabled} onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
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
                  disabled={inputsDisabled} onChange={(e) => set('salespersonId', e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
                  {form.salespersonId && !staffList.some((s) => s.id === form.salespersonId) && (
                    <option value={form.salespersonId}>(former staff)</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY INFO ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Note Date</span>
              <input type="date" className={styles.fieldInput} value={form.doDate}
                disabled={inputsDisabled} onChange={(e) => set('doDate', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Driver</span>
              <input className={styles.fieldInput} value={form.driverName}
                disabled={inputsDisabled} onChange={(e) => set('driverName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Vehicle</span>
              <input className={styles.fieldInput} value={form.vehicle}
                disabled={inputsDisabled} onChange={(e) => set('vehicle', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled} onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
                  {form.buildingType && !buildingTypeOpts.some((b) => b.value === form.buildingType) && (
                    <option value={form.buildingType}>{form.buildingType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={form.venue}
                disabled={inputsDisabled} onChange={(e) => set('venue', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Delivery</span>
              <input type="date" className={styles.fieldInput} value={form.expectedDeliveryAt}
                disabled={inputsDisabled} onChange={(e) => set('expectedDeliveryAt', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Delivery Date</span>
              <input type="date" className={styles.fieldInput} value={form.customerDeliveryDate}
                disabled={inputsDisabled} onChange={(e) => set('customerDeliveryDate', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={inputsDisabled} onChange={(e) => set('note', e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Used only if we cannot reach the customer on delivery day
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={form.emergencyContactName}
                placeholder="e.g. Lim Mei Hua" disabled={inputsDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={inputsDisabled} onChange={(e) => set('emergencyContactRelationship', e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
                  {form.emergencyContactRelationship && !relationshipOpts.some((r) => r.value === form.emergencyContactRelationship) && (
                    <option value={form.emergencyContactRelationship}>{form.emergencyContactRelationship}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={form.emergencyContactPhone}
                disabled={inputsDisabled} onChange={(v) => set('emergencyContactPhone', v)} />
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY ADDRESS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Address</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={form.address1}
                placeholder="Unit, street, area" disabled={inputsDisabled}
                onChange={(e) => set('address1', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={form.address2}
                placeholder="Apt, floor, building (optional)" disabled={inputsDisabled}
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
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{ display: 'inline-flex', alignItems: 'center', height: 26, color: 'var(--fg-muted)' }}>
                {form.salesLocation || header.sales_location || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
});
CustomerCardInner.displayName = 'ConsignmentNoteCustomerCardInner';
const CustomerCard = memo(CustomerCardInner) as typeof CustomerCardInner;
