// ----------------------------------------------------------------------------
// ConsignmentReturnDetail — full-page route at /scm/consignment-returns/:id.
//
// Editable clone of DeliveryReturnDetail (itself an SO/DO clone). View→Edit
// gate; editable Customer / Return Info / Emergency Contact / Delivery Address /
// Line Items + a Totals · Margin card. Reuses the shared SoLineCard + PhoneInput
// + SalesOrderDetail.module.css UNCHANGED so the Consignment Return Detail reads
// identically to the DR Detail. There is no payments ledger on a return.
//
// The DR-specific "From Delivery Order" action, the Relationship Map button, the
// Print PDF button, and the per-line restock-warehouse column are intentionally
// DROPPED — a consignment return is free-entry. The backend
// `/consignment-returns` route mirrors `/delivery-returns` 1:1.
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { canViewScmCosting } from "../../auth/salesAccess";
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  ArrowLeft, Pencil, Plus, Printer, Save, ChevronDown, Ban, RotateCcw,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import {
  useConsignmentReturnDetail,
  useUpdateConsignmentReturnHeader,
  useUpdateConsignmentReturnStatus,
  useAddConsignmentReturnItem,
  useUpdateConsignmentReturnItem,
  useDeleteConsignmentReturnItem,
} from '../../vendor/scm/lib/consignment-return-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { buildVariantSummary, fmtDateOrDash, fmtMoneySen, orderLineIdentity } from '@2990s/shared';
import { useAuth } from '../../auth/AuthContext';
import { useLocalities } from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_FLOW = ['PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED'] as const;
type CrnStatus = typeof STATUS_FLOW[number];

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const TOTALS_KPI_GRID_STYLE: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)', paddingBottom: 'var(--space-3)', borderBottom: '1px solid var(--line)',
};
const TOTALS_KPI_VALUE_STYLE: CSSProperties = { fontSize: 'var(--fs-15, 15px)' };

type CrnHeader = {
  id: string;
  return_number: string;
  status: CrnStatus;
  return_date: string;
  reason: string | null;
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
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  /* FINANCE-gated (CRN_FINANCE_KEYS server-side) — the detail payload OMITS
     every one of these for a non-finance caller (canViewScmFinance), so they
     are optional on the wire. Only the finance-gated TotalsCard reads them.
     local_total_sen is NOT finance: the returned value is shown to everyone. */
  mattress_sofa_sen?: number;
  bedframe_sen?: number;
  accessories_sen?: number;
  others_sen?: number;
  mattress_sofa_cost_sen?: number;
  bedframe_cost_sen?: number;
  accessories_cost_sen?: number;
  others_cost_sen?: number;
  local_total_sen: number;
  total_cost_sen?: number;
  total_margin_sen?: number;
  margin_pct_basis?: number;
  line_count: number;
  currency: string;
};

type CrnItem = {
  id: string;
  consignment_delivery_return_id: string;
  item_group: string | null;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty_returned: number;
  condition: string | null;
  unit_price_sen: number;
  discount_sen: number;
  line_total_sen: number;
  /* FINANCE-gated (CRN_ITEM_FINANCE_KEYS server-side) — OMITTED from the detail
     payload for a non-finance caller, hence optional. NOTE: draftFromItem
     collapses a missing unit_cost_sen to 0 and the save echoes it back — the
     route's line PATCH therefore IGNORES a client cost from a non-finance
     caller and keeps the stored one (#632's trap; see consignment-returns.ts). */
  unit_cost_sen?: number;
  line_cost_sen?: number;
  line_margin_sen?: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
};

const draftFromItem = (it: CrnItem): SoLineDraft => ({
  itemCode: it.item_code ?? '',
  itemGroup: it.item_group ?? 'others',
  description: it.description ?? '',
  uom: it.uom ?? 'UNIT',
  qty: it.qty_returned ?? 1,
  unitPriceSen: it.unit_price_sen ?? 0,
  discountSen: it.discount_sen ?? 0,
  unitCostSen: it.unit_cost_sen ?? 0,
  variants: (it.variants as Record<string, unknown>) ?? {},
  remark: it.notes ?? '',
});

export const ConsignmentReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const askConfirm = useConfirm();
  const notify = useNotify();
  /* Finance-viewer gate — cost / margin (the line columns AND the whole
     Totals·Margin card) must never render for a non-finance user. Same rule as
     DeliveryReturnDetailV2 (#589); canViewScmFinance strips them server-side. */
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);
  const [searchParams] = useSearchParams();
  const detail = useConsignmentReturnDetail(id ?? null);
  const updateHeader = useUpdateConsignmentReturnHeader();
  const updateStatus = useUpdateConsignmentReturnStatus();
  const addItem = useAddConsignmentReturnItem();
  const updateItem = useUpdateConsignmentReturnItem();
  const deleteItem = useDeleteConsignmentReturnItem();

  const header = (detail.data?.deliveryReturn as CrnHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as CrnItem[] | undefined) ?? [], [detail.data]);

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const [addingDraft, setAddingDraft] = useState<SoLineDraft | null>(null);

  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  const lockedStatuses: CrnStatus[] = ['REFUNDED', 'CREDIT_NOTED', 'CANCELLED'];

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
            title: `Remove ${it.item_code} from this return?`,
            confirmLabel: 'Remove',
            danger: true,
          })) {
            deleteItem.mutate(
              { id: it.consignment_delivery_return_id, itemId: it.id },
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
      uom: d.uom, qtyReturned: d.qty, unitPriceSen: d.unitPriceSen, discountSen: d.discountSen,
      unitCostSen: d.unitCostSen, variants: d.variants, notes: d.remark,
    });

  const commitAddLine = (d: SoLineDraft) =>
    addItem.mutateAsync({
      id: header!.id,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qtyReturned: d.qty, unitPriceSen: d.unitPriceSen, discountSen: d.discountSen,
      unitCostSen: d.unitCostSen, variants: d.variants, notes: d.remark,
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

  /* HOOKS MUST ALL BE ABOVE THE GUARDS BELOW. usePrintPreview sat under them
     until 2026-08-17, so the loading render called fewer hooks than the loaded
     one and React threw #310 ("rendered more hooks than during the previous
     render") the moment the query resolved — a blank "Something went wrong
     loading this page." on a direct URL / refresh. Arriving from the list hid
     it: react-query already had the detail cached, so the isPending branch
     never rendered first. `deliverPrintPdf` therefore has to tolerate a null
     header; it can only ever be CALLED from the preview dialog, which does not
     exist until the record has loaded. */
  const deliverPrintPdf = (action: PdfAction) => {
    if (!header) return;
    // A consignment return has no money refund — show the goods value instead.
    const pdfHeader = { ...header, refund_sen: header.local_total_sen };
    const pdfItems = items.map((it) => ({ ...it, refund_sen: it.line_total_sen }));
    return import('../../vendor/scm/lib/delivery-return-pdf')
      .then(({ generateDeliveryReturnPdf }) =>
        generateDeliveryReturnPdf(pdfHeader as never, pdfItems as never, {
          docTitle: 'CONSIGNMENT RETURN', docNoLabel: 'CR No',
          amountLabel: 'Value', totalLabel: 'TOTAL VALUE', action,
        }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }));
  };
  const print = usePrintPreview(deliverPrintPdf);

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className="space-y-4">
        <Link to="/scm/consignment-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Consignment return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const isLocked = lockedStatuses.includes(header.status);
  const isCancelled = header.status === 'CANCELLED';

  const handleCancel = async () => {
    if (!(await askConfirm({
      title: `Cancel ${header.return_number}?`,
      body: 'This sets status = CANCELLED.',
      confirmLabel: 'Cancel return',
      danger: true,
    }))) return;
    updateStatus.mutate({ id: header.id, status: 'CANCELLED' });
  };
  const handleReopen = async () => {
    if (!(await askConfirm({
      title: `Reopen ${header.return_number} back to RECEIVED?`,
      confirmLabel: 'Reopen',
    }))) return;
    updateStatus.mutate({ id: header.id, status: 'RECEIVED' });
  };

  return (
    <div className="space-y-4" style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header ── */}
      <PageHeader back
        eyebrow="Supply Chain"
        title={`${header.return_number} — ${header.debtor_name}`}
        description={`Return date ${fmtDateOrDash(header.return_date)} · ${header.line_count} ${header.line_count === 1 ? 'line' : 'lines'}${header.customer_so_no ? ` · Customer Ref ${header.customer_so_no}` : ''}`}
        actions={
          <>
          <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Returned</span>
            <span className={styles.totalRailValue}>{fmtRm(header.local_total_sen, header.currency)}</span>
          </div>
          <StatusPill docType="dr" status={header.status} />
          <RelationshipMapButton type="cdr" id={id} />
          <Button variant="ghost" size="md" onClick={print.openPreview}>
            <Printer size={15} strokeWidth={1.75} /><span>Print PDF</span>
          </Button>
          <PrintPreviewModal
            open={print.open}
            onClose={print.close}
            docTitle="Consignment Return"
            docNo={header.return_number}
            rows={[
              { label: 'Consignee', value: header.debtor_name || '—' },
              { label: 'Return date', value: fmtDateOrDash(header.return_date) },
              { label: 'Items', value: `${header.line_count} line${header.line_count === 1 ? '' : 's'}` },
              { label: 'Goods value', value: fmtRm(header.local_total_sen, header.currency) },
            ]}
            {...print.handlers}
          />
          {isCancelled ? (
            <Button variant="primary" size="md" onClick={handleReopen} disabled={updateStatus.isPending}>
              <RotateCcw {...ICON} /><span>Reopen Return</span>
            </Button>
          ) : !isEditing ? (
            <Button variant="ghost" size="md" onClick={handleCancel} disabled={updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Ban {...ICON} /><span>Cancel Return</span>
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

      {/* ── Customer / Return Info / Emergency / Address cards ── */}
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
          <h2 className={styles.cardTitle}>Returned Items ({items.length})</h2>
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
                              /* Downstream document: the items were already specified on the
                              originating order and their variants ride in with them, so they
                              are NOT re-required here. Same rule DeliveryOrderNewV2 states
                              for the DO. Verified 2026-08-13: this document's server does no
                              variant enforcement at all (findIncompleteVariantLines appears
                              0 times in its route), so the default `= true` was pure
                              client-side invention - a red ring and a ` *` for a field the
                              backend never asked for. */
                              variantsRequired={false}
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
                              variantsRequired={false}
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
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                {/* Cost / Margin columns are CUT for a non-finance viewer (off,
                    not hidden — no column, no "—"). The server also strips
                    unit_cost_sen / line_cost_sen / line_margin_sen from
                    the detail payload for such a caller (canViewScmFinance). */}
                {canFinance && <th className={styles.tableRight}>Unit Cost</th>}
                {canFinance && <th className={styles.tableRight}>Line Cost</th>}
                {canFinance && <th className={styles.tableRight}>Margin</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    {/* Item CODE first, then the variant subtitle; description
                        dropped (owner 2026-07-24) — the shared order-line rule
                        (vendor/shared/line-identity.ts). Unlike its Note/Order
                        siblings this table has no "Description 2" column, so the
                        variant IS this cell's second line. */}
                    {(() => {
                      const { primary, secondary } = orderLineIdentity({
                        code: it.item_code,
                        description: it.description,
                        variant: buildVariantSummary(it.item_group, it.variants),
                      });
                      return (
                        <>
                          <div className={styles.codeCell}>{primary || '—'}</div>
                          {secondary && <div className={styles.muted}>{secondary}</div>}
                        </>
                      );
                    })()}
                    {it.condition && <div className={styles.muted}>Condition: {it.condition}</div>}
                  </td>
                  <td className={styles.tableRight}>{it.qty_returned}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_sen, header.currency)}</td>
                  <td className={styles.tableRight}>{it.discount_sen > 0 ? fmtRm(it.discount_sen, header.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_sen, header.currency)}</td>
                  {canFinance && (
                    <td className={styles.tableRight}>
                      <span className={styles.muted}>{(it.unit_cost_sen ?? 0) > 0 ? fmtRm(it.unit_cost_sen ?? 0, header.currency) : '—'}</span>
                    </td>
                  )}
                  {canFinance && (
                    <td className={styles.tableRight}>
                      <span className={styles.muted}>{(it.line_cost_sen ?? 0) > 0 ? fmtRm(it.line_cost_sen ?? 0, header.currency) : '—'}</span>
                    </td>
                  )}
                  {canFinance && (
                    <td className={styles.tableRight}>
                      {it.line_total_sen > 0 ? (
                        <span className={(it.line_margin_sen ?? 0) > 0 ? styles.marginGood : (it.line_margin_sen ?? 0) < 0 ? styles.marginBad : styles.muted}
                          style={{ fontWeight: 600 }}>
                          {fmtRm(it.line_margin_sen ?? 0, header.currency)}
                        </span>
                      ) : <span className={styles.muted}>—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canFinance && <TotalsCard header={header} />}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer / Return Info / Emergency / Delivery Address — editable cards.
   Mirrors DeliveryReturnDetail's CustomerCard (adapted to CRN fields).
   ════════════════════════════════════════════════════════════════════════ */

type CustomerCardHandle = {
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
};

type CustomerCardProps = {
  header: CrnHeader;
  onSave: (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => void;
  locked?: boolean;
  isEditing?: boolean;
};

const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header, onSave, locked = false, isEditing = false,
}, ref) => {
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  /* `include` carries the salesperson already ON this document, so someone the
     onlySales narrowing hides is still named. "(former staff)" below is then
     only reachable for a row that genuinely is gone. */
  const staffQ = usePickableStaff({ onlySales: true, include: [header.salesperson_id] });
  const staffList = (staffQ.data ?? []).filter((s) => s.active);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  const initialFormFor = (h: CrnHeader) => ({
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    venue: h.venue ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? '',
    postcode: h.postcode ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    returnDate: h.return_date ?? '',
    reason: h.reason ?? '',
    note: h.note ?? h.notes ?? '',
    salesLocation: h.sales_location ?? '',
  });

  const [form, setForm] = useState(() => initialFormFor(header));

  useEffect(() => {
    setForm(initialFormFor(header));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  /* Shared address cascade, BOTH directions (address-cascade.ts). One setForm
     per pick so the value just chosen survives — the State picker's own handler
     resets the cascade, so a back-filled State must not route through it. */
  const { cities, postcodes } = useAddressCascade(localityRows, form.state, form.city);
  const onCityPick = (next: string) =>
    setForm((s) => ({ ...s, ...pickCity(localityRows, s, next) }));
  const onPostcodePick = (next: string) =>
    setForm((s) => ({ ...s, ...pickPostcode(localityRows, s, next) }));

  const buildPayload = () => ({
    debtorCode: form.customerCode,
    debtorName: form.customerName,
    customerSoNo: form.customerSoNo || null,
    email: form.email,
    customerType: form.customerType,
    salespersonId: form.salespersonId || null,
    buildingType: form.buildingType,
    venue: form.venue,
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
    returnDate: form.returnDate || null,
    reason: form.reason,
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
                <SearchableSelect
                  className={styles.fieldSelect}
                  ariaLabel="Salesperson"
                  placeholder="— Pick staff —"
                  value={form.salespersonId}
                  onChange={(v) => set('salespersonId', v)}
                  disabled={inputsDisabled}
                  options={[
                    ...sortByText(staffList).map((s) => ({ value: s.id, label: `${s.name} (${s.staffCode})` })),
                    ...(form.salespersonId && !staffList.some((s) => s.id === form.salespersonId)
                      ? [{ value: form.salespersonId, label: '(former staff)' }]
                      : []),
                  ]}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── RETURN INFO (date / reason / note) ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Return Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <DateField
                fullWidth
                className={styles.fieldInput}
                value={form.returnDate}
                disabled={inputsDisabled}
                onChange={(iso) => set('returnDate', iso)}
              />
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
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={form.reason}
                placeholder="Why is this being returned?" disabled={inputsDisabled}
                onChange={(e) => set('reason', e.target.value)} />
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
            Used only if we cannot reach the customer on collection day
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
                onChange={(next) => setForm((s) => ({ ...s, ...pickState(next) }))}
                disabled={inputsDisabled}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={form.city}
                  onChange={onCityPick}
                  disabled={inputsDisabled}
                  placeholder={cityPlaceholder(form.state)}
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
                  onChange={onPostcodePick}
                  disabled={inputsDisabled}
                  placeholder={postcodePlaceholder(form.state, form.city)}
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
CustomerCardInner.displayName = 'ConsignmentReturnCustomerCardInner';
const CustomerCard = memo(CustomerCardInner) as typeof CustomerCardInner;

/* ════════════════════════════════════════════════════════════════════════
   Totals card (mirror of DeliveryReturnDetail's TotalsCard) — FINANCE-GATED.
   Cost / margin never render for a non-finance viewer: the caller gates the
   WHOLE card behind user.project_finance_viewer, exactly as
   DeliveryReturnDetailV2 does (#589). The card is Cost/Margin end-to-end —
   there is no non-finance half worth keeping, so it is cut whole (off, not
   hidden). The server also strips every key it reads (canViewScmFinance).
   ════════════════════════════════════════════════════════════════════════ */
const TotalsCard = ({ header }: { header: CrnHeader }) => {
  const totalCost = header.total_cost_sen ?? 0;
  const totalMargin = header.total_margin_sen ?? 0;
  const marginPct = (header.margin_pct_basis ?? 0) / 100;
  const marginCls =
    totalMargin <= 0 ? styles.marginBad
    : marginPct >= 30 ? styles.marginGood
    : marginPct >= 15 ? styles.marginWarn
    : styles.marginBad;

  const categories: Array<{ label: string; rev: number; cost: number }> = [
    { label: 'Mattress / Sofa', rev: header.mattress_sofa_sen ?? 0, cost: header.mattress_sofa_cost_sen ?? 0 },
    { label: 'Bedframe',        rev: header.bedframe_sen      ?? 0, cost: header.bedframe_cost_sen      ?? 0 },
    { label: 'Accessories',     rev: header.accessories_sen   ?? 0, cost: header.accessories_cost_sen   ?? 0 },
    { label: 'Others',          rev: header.others_sen        ?? 0, cost: header.others_cost_sen        ?? 0 },
  ];

  const fmtMarginClass = (rev: number, marginSen: number) => {
    if (rev <= 0) return styles.muted;
    if (marginSen > 0) return styles.marginGood;
    if (marginSen < 0) return styles.marginBad;
    return styles.muted;
  };

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Totals · Margin</h2></header>
      <div className={styles.cardBody}>
        <div style={TOTALS_KPI_GRID_STYLE}>
          <div>
            <div className={styles.totalLabel}>Returned Value</div>
            <div className={styles.grandTotal} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(header.local_total_sen, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Cost</div>
            <div className={styles.totalValue} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(totalCost, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin</div>
            <div className={`${styles.totalValue} ${marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(totalMargin, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin %</div>
            <div className={`${styles.totalValue} ${marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>
              {header.local_total_sen > 0 ? `${marginPct.toFixed(1)}%` : '—'}
            </div>
          </div>
        </div>
        <div className={styles.totalLabel} style={{ marginBottom: 'var(--space-2)' }}>By Category</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {categories.filter((c) => c.rev > 0 || c.cost > 0).map(({ label, rev, cost }) => {
            const margin = rev - cost;
            return (
              <div key={label} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 'var(--space-3)', alignItems: 'baseline' }}>
                <div className={styles.totalLabel} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 'var(--fs-13)' }}>{label}</div>
                <div className={styles.totalValue}>Value {fmtRm(rev, header.currency)}</div>
                <div className={styles.totalValue} style={{ color: 'var(--fg-muted)' }}>Cost {fmtRm(cost, header.currency)}</div>
                <div className={`${styles.totalValue} ${fmtMarginClass(rev, margin)}`}>Margin {fmtRm(margin, header.currency)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
