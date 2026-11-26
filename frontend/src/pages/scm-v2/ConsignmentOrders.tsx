
import { useEffect, useMemo, useState } from 'react';
import { canViewScmCosting } from "../../auth/salesAccess";
import { brandingLabel } from '../../vendor/shared/so-branding-label';
import { getBrandingCompanyCode } from '../../lib/branding';
import type { JSX, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, X, Search, ExternalLink, Edit3, Printer, Truck, RotateCcw } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { Button as DrawerButton } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { statusFor } from './so-list-status';
import { canCreateConsignmentNote } from './co-note-gate';
import { cn } from '../../lib/utils';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { ListingPickerDialog, type ListingChoice } from '../../vendor/scm/components/ListingPickerDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, fmtDateOrDash, fmtQty, fmtSen, orderLineIdentity } from '@2990s/shared';
import {
  useConsignmentOrdersPaged, useUpdateConsignmentOrderStatus,
  useConsignmentOrderDetail,
} from '../../vendor/scm/lib/consignment-order-queries';
import { SearchProgress } from '../../components/SearchProgress';
import {
  StockRemarkPill, stockRemarkSortFn, stockRemarkSearchValue, stockRemarkExportValue,
} from '../../components/StockRemarkPill';
import { ListPager } from '../../components/ListPager';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useDebouncedSearchTerm, useSearchResultTransition } from '../../hooks/useServerSearch';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { CONSIGNMENT_ORDER_PDF_OPTS, generateSalesOrderPdf } from '../../vendor/scm/lib/sales-order-pdf';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import { soStatusDisplay, type DeliveryState, type SoLifecycle } from '../../vendor/scm/lib/so-status';
import { useAuth } from '../../auth/AuthContext';
import styles from './MfgSalesOrdersList.module.css';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import soDetailStyles from './SalesOrderDetail.module.css';
import { retryUnlessClientError } from '../../lib/retryPolicy';
import { transferToColumnLabel } from "../../lib/convertScope";
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { customerRefOf } from '../../lib/customer-ref';

type SoPaymentRow = {
  id: string;
  so_doc_no: string;
  paid_at: string | null;
  method: string | null;
  approval_code: string | null;
  amount_sen: number | null;
};
const useSoPaymentsForDrilldown = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-payments', docNo],
  queryFn: () => authedFetch<{ payments: SoPaymentRow[] }>(`/consignment-orders/${docNo}/payments`),
  enabled: Boolean(docNo),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* Commander 2026-05-27: "SO 的那些 column 是根据我们的 column 去添加的
   没有的你不要跟 autocount". Align columns to ACTUAL 2990 schema (no
   HOOKKA-legacy columns like `agent` / `sales_location` / `ref` that
   2990 doesn't populate). Address line 3/4 dropped — `city` + `postcode`
   are now proper columns (PR #46 POS handover). Salesperson, customer
   code, email, customer type, building type, state added — all are
   populated for trading SOs. */
type SoRow = {
  doc_no: string;
  so_date: string;
  branding: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  salesperson_id: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  address1: string | null;
  address2: string | null;
  customer_state: string | null;
  customer_country: string | null;
  city: string | null;
  postcode: string | null;
  customer_delivery_date: string | null;
  processing_date: string | null;
  target_date: string | null;
  payment_method: string | null;
  installment_months: number | null;
  merchant_provider: string | null;
  payment_methods_summary?: string;
  note: string | null;
  local_total_sen: number;
  balance_sen: number;
  balance_sen_live?: number | null;
  paid_total_sen?: number | null;
  paid_sen: number;
  deposit_sen?: number | null;
  status: string;
  currency: string;
  mattress_sofa_sen?: number;
  bedframe_sen?: number;
  accessories_sen?: number;
  others_sen?: number;
  mattress_sofa_cost_sen?: number;
  bedframe_cost_sen?: number;
  accessories_cost_sen?: number;
  others_cost_sen?: number;
  total_cost_sen?: number;
  total_margin_sen?: number;
  margin_pct_basis?: number;
  ready_categories?: string[];
  is_fully_ready?: boolean;
  /* stock_remark names what IS ready (owner 2026-08-16, the warehouse's
     "Remark 2" vocabulary): "" when nothing is ready yet, "READY" when
     everything that must be allocated is, "PARTIAL" when every MAIN line is in
     and an accessory is not, else the "/"-joined list of groups that ARE in
     ("BEDFRAME", "MATTRESS/ACC"). It never reads READY while something is short
     — "PARTIAL" carries no "READY " prefix, which is what makes an
     accessory-only order with a short accessory read BLANK rather than claim a
     readiness it does not have. is_main_ready is true once every MAIN
     (sofa/bedframe/mattress) line is in stock — and VACUOUSLY true when the SO
     has no main line, so never label off it. Derived in the SO list GET via
     summariseReadiness. */
  stock_remark?: string;
  is_main_ready?: boolean;
  item_categories?: string[];
  first_item_category?: string;
  first_item_branding?: string | null;
  has_children?: boolean;
  has_undelivered?: boolean;
  delivery_state?: DeliveryState;
  lifecycle_state?: SoLifecycle;
  current_doc_no?: string | null;
};

const liveBalance = (r: SoRow): number => {
  if (typeof r.balance_sen_live === 'number') return r.balance_sen_live;
  if (typeof r.balance_sen === 'number') return r.balance_sen;
  return r.local_total_sen - (r.paid_sen ?? 0);
};

/* Branding auto-derive (Commander 2026-05-28, refined PR #266). The Branding
   column is derived per row — no longer stored free-text. It FOLLOWS THE FIRST
   LINE ITEM rather than collapsing to "Mixed" when categories differ. The SO
   list API hands back the earliest-created line's normalized category
   (`first_item_category`) plus that line's own branding (`first_item_branding`,
   the mattress brand).

   THE RULE IS NO LONGER WRITTEN HERE. It was, and the copy that used to sit in
   this spot was the second of two — the backend's
   scm/lib/so-display-branding.ts held the other, and its comment said this one
   was "behaviourally identical today, verified 2026-08-15", which is a date,
   not a guarantee. Both now come from the mirrored shared module, which
   check-shared-mirrors.mjs --strict keeps identical across the two trees in CI.

   The comment that used to be here also promised `ACCESSORY / OTHERS → "2990"`
   while the code below it returned "". Owner 2026-08-17: there should be no
   blank branding — a service order still says "Service". The shared rule can
   no longer return "" for any input.

   Sortable + groupable + filterable via the same derived string. */
const deriveBranding = (r: SoRow): string =>
  brandingLabel(r.first_item_category, r.first_item_branding, getBrandingCompanyCode());

const STATUS_CLASS: Record<string, string> = {
  CONFIRMED:      soDetailStyles.statusConfirmed ?? '',
  IN_PRODUCTION:  soDetailStyles.statusInProd ?? '',
  READY_TO_SHIP:  soDetailStyles.statusReady ?? '',
  SHIPPED:        soDetailStyles.statusShipped ?? '',
  DELIVERED:      soDetailStyles.statusDelivered ?? '',
  INVOICED:       soDetailStyles.statusInvoiced ?? '',
  CLOSED:         soDetailStyles.statusClosed ?? '',
  CANCELLED:      soDetailStyles.statusCancelled ?? '',
  RETURNED:       soDetailStyles.statusReturned ?? '',
};

/* Commander 2026-05-28: relabel the status enum to the 6-stage flow
   used in commander's vocabulary. Underlying enum values stay (no schema
   migration) — only the display label maps. Mapping:
     CONFIRMED      → Confirmed   (订单已经 Confirm)
     IN_PRODUCTION  → Proceed     (已经 Proceed — Processing Date set, i.e.
                                   internal_expected_dd, the one storage this
                                   concept has; NOT the retired processing_date
                                   column)
     READY_TO_SHIP  → Stock Ready (stock 已经 ready)
     SHIPPED        → Arranged    (已经安排送货)
     DELIVERED      → Delivered   (已经 deliver)
     INVOICED       → Invoiced    (已经 invoice)
     CLOSED         → Closed
     ON_HOLD        → On Hold
     CANCELLED      → Cancelled */
const STATUS_LABEL: Record<string, string> = {
  CONFIRMED:     'Confirmed',
  IN_PRODUCTION: 'Proceed',
  READY_TO_SHIP: 'Stock Ready',
  SHIPPED:       'Arranged',
  DELIVERED:     'Delivered',
  INVOICED:      'Invoiced',
  CLOSED:        'Closed',
  ON_HOLD:       'On Hold',
  CANCELLED:     'Cancelled',
};

const StatusPill = ({ status, deliveryState, lifecycleState }: { status: string; deliveryState?: DeliveryState; lifecycleState?: SoLifecycle }) => {
  const eff = soStatusDisplay(status, deliveryState, lifecycleState);
  return (
    <span className={`${soDetailStyles.statusPill} ${STATUS_CLASS[eff.classKey] ?? ''}`}>
      {eff.label ?? STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
    </span>
  );
};

type SoItem = {
  id: string;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  uom: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  unit_cost_sen: number | null;
  line_cost_sen: number | null;
  line_margin_sen: number | null;
  total_sen: number | null;
  stock_status: string | null;
  cancelled: boolean | null;
  deliveries?: { doNumber: string; qty: number; status: string }[];
  delivered_qty?: number;
  remaining_qty?: number;
  coverage_po?: string | null;
  coverage_eta?: string | null;
  stock_state?: 'stock' | 'po' | 'shortage' | null;
};

const CategoryPill = ({ group }: { group: string | null | undefined }) => {
  const spec = badgeFor(group);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 8px', borderRadius: 999,
      background: spec.bg, color: spec.fg,
      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {spec.label}
    </span>
  );
};

const lineCostOf = (it: SoItem): number =>
  it.line_cost_sen != null
    ? Number(it.line_cost_sen)
    : Number(it.qty ?? 0) * Number(it.unit_cost_sen ?? 0);
const lineMarginOf = (it: SoItem): number =>
  it.line_margin_sen != null
    ? Number(it.line_margin_sen)
    : Number(it.total_sen ?? 0) - lineCostOf(it);
const stockLabelOf = (it: SoItem): string => {
  const delivered = Number(it.delivered_qty ?? 0);
  const remaining = Number(it.remaining_qty ?? it.qty ?? 0);
  if (delivered > 0 && remaining <= 0) return 'DELIVERED';
  const state = it.stock_state ?? (it.stock_status === 'READY' ? 'stock' : 'shortage');
  return state === 'stock' ? 'STOCK' : 'PENDING';
};

/* Drill-down columns — display-only DataGridColumn specs so the SO drill-down
   gets the SAME add/remove · drag-reorder · resize · right-click as the main
   list grids (it used to be a hand-built fixed <table> that couldn't). Shared
   layout key (`so-drilldown-grid.v1`) so the operator's column prefs persist
   across every SO they expand, not per-document. `paymentRefs` is order-level
   (identical on every row), threaded in from the component.

   The delivery column is labelled "Status" — Wei Siang 2026-05-31: "delivered
   就是 status 的意思", so the header reads "Status" while the cell shows which
   DO took how much + the live balance (which IS the delivery status).

   canFinance — the finance-viewer gate (auth/me = isFinanceViewer, the same
   signal the SO/DO/SI/DR surfaces use, #574/#589). The cost/margin columns are
   only DECLARED for a finance-viewer: off, not hidden — no column, no "—", no
   RM 0.00. The backend also omits the keys from the payload
   (canViewScmFinance), so rendering them for a non-finance user could only ever
   print zeros. */
const buildDrilldownColumns = (paymentRefs: string, canFinance: boolean): GridColumn<SoItem>[] => [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--hz-c-primary)' }}>{it.item_code ?? '—'}</span>,
    searchValue: (it) => it.item_code ?? '',
    sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group, it.variants)}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
  {
    key: 'uom', label: 'UOM', width: 70,
    accessor: (it) => it.uom || 'UNIT',
    searchValue: (it) => it.uom || 'UNIT',
  },
  {
    key: 'qty', label: 'Qty', width: 60, align: 'right',
    accessor: (it) => fmtQty(it.qty ?? 0),
    exportValue: (it) => Number(it.qty ?? 0),
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    key: 'delivered', label: transferToColumnLabel('do'), width: 130,
    accessor: (it) => {
      const hasDeliveries = it.deliveries && it.deliveries.length > 0;
      if (!hasDeliveries) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return (
        <div>
          {it.deliveries!.map((d, di) => (
            <div key={di} style={{ fontWeight: 600, color: 'var(--hz-c-primary)', whiteSpace: 'nowrap' }}>
              {d.doNumber} <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>×{fmtQty(d.qty)}</span>
            </div>
          ))}
          {typeof it.remaining_qty === 'number' && (
            <div style={{
              fontSize: 'var(--fs-10)', marginTop: 1,
              color: it.remaining_qty > 0 ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-secondary-a, #2F5D4F)',
            }}>
              {it.remaining_qty > 0 ? `Balance ${fmtQty(it.remaining_qty)}` : 'Fully delivered'}
            </div>
          )}
        </div>
      );
    },
    searchValue: (it) => (it.deliveries ?? []).map((d) => d.doNumber).join(' '),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtSen(Number(it.unit_price_sen ?? 0)),
    exportValue: (it) => Number(it.unit_price_sen ?? 0) / 100,
    exportFormat: 'rate',
    searchValue: (it) => String(it.unit_price_sen ?? 0),
    sortFn: (a, b) => Number(a.unit_price_sen ?? 0) - Number(b.unit_price_sen ?? 0),
  },
  {
    key: 'total', label: 'Total', width: 100, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--hz-c-primary)' }}>{fmtSen(Number(it.total_sen ?? 0))}</span>,
    exportValue: (it) => Number(it.total_sen ?? 0) / 100,
    exportFormat: 'money',
    searchValue: (it) => String(it.total_sen ?? 0),
    sortFn: (a, b) => Number(a.total_sen ?? 0) - Number(b.total_sen ?? 0),
  },
  ...(canFinance
    ? ([
        {
          key: 'unit_cost', label: 'Unit Cost', width: 100, align: 'right',
          accessor: (it) => fmtSen(Number(it.unit_cost_sen ?? 0)),
          exportValue: (it) => Number(it.unit_cost_sen ?? 0) / 100,
          exportFormat: 'rate',
          searchValue: (it) => String(it.unit_cost_sen ?? 0),
          sortFn: (a, b) => Number(a.unit_cost_sen ?? 0) - Number(b.unit_cost_sen ?? 0),
        },
        {
          key: 'line_cost', label: 'Line Cost', width: 100, align: 'right',
          accessor: (it) => fmtSen(lineCostOf(it)),
          exportValue: (it) => lineCostOf(it) / 100,
          exportFormat: 'money',
          searchValue: (it) => String(lineCostOf(it)),
          sortFn: (a, b) => lineCostOf(a) - lineCostOf(b),
        },
        {
          key: 'margin', label: 'Margin', width: 100, align: 'right',
          accessor: (it) => {
            const m = lineMarginOf(it);
            const c = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
            return <span style={{ color: c, fontWeight: 600 }}>{fmtSen(m)}</span>;
          },
          exportValue: (it) => lineMarginOf(it) / 100,
          exportFormat: 'money',
          searchValue: (it) => String(lineMarginOf(it)),
          sortFn: (a, b) => lineMarginOf(a) - lineMarginOf(b),
        },
      ] as GridColumn<SoItem>[])
    : []),
  {
    key: 'stock', label: 'Stock', width: 100, groupable: true,
    accessor: (it) => {
      const label = stockLabelOf(it);
      const green = label === 'STOCK' || label === 'DELIVERED';
      return (
        <span style={{
          fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
          fontWeight: 700, letterSpacing: 0.5, padding: '2px 8px', borderRadius: 999,
          color: green ? 'var(--c-secondary-a, var(--hz-dk-secondary-a, #2F5D4F))' : 'var(--fg-muted)',
          background: green ? 'rgba(47,93,79,0.12)' : 'rgba(34,31,32,0.06)',
        }}>{label}</span>
      );
    },
    searchValue: (it) => stockLabelOf(it),
    groupValue: (it) => stockLabelOf(it),
  },
  {
    key: 'coverage', label: 'Incoming PO', width: 150,
    accessor: (it) => {
      if (!it.coverage_po) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return (
        <span style={{ fontSize: 'var(--fs-10)', fontWeight: 600, color: 'var(--hz-c-primary)', whiteSpace: 'nowrap' }}>
          {it.coverage_po}{it.coverage_eta ? ` · ETA ${fmtDateOrDash(it.coverage_eta)}` : ''}
        </span>
      );
    },
    searchValue: (it) => `${it.coverage_po ?? ''} ${it.coverage_eta ?? ''}`.trim(),
  },
  {
    key: 'payment', label: 'Payment', width: 160,
    accessor: () => <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-10)' }}>{paymentRefs || '—'}</span>,
    searchValue: () => paymentRefs,
  },
];

const ExpandedSoLines = ({ docNo, canFinance }: { docNo: string; canFinance: boolean }) => {
  const q = useConsignmentOrderDetail(docNo);
  const pq = useSoPaymentsForDrilldown(docNo);
  if (q.isLoading) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
        Loading lines for {docNo}…
      </div>
    );
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const allItems = (q.data?.items ?? []) as SoItem[];
  const items = allItems.filter((it) => !it.cancelled);
  const soHeader = (q.data?.salesOrder ?? null) as { customer_so_no?: string | null; ref?: string | null } | null;
  const customerSoRef = customerRefOf(soHeader);
  const payments = (pq.data?.payments ?? []) as SoPaymentRow[];
  const paymentRefs = payments
    .map((p) => {
      const left = (p.approval_code ?? '').trim();
      if (!left && !customerSoRef) return '';
      return customerSoRef ? `(${left || '—'}/${customerSoRef})` : `(${left || '—'})`;
    })
    .filter(Boolean)
    .join('');

  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
        No line items.
      </div>
    );
  }

  let totalSen = 0;
  let costSen  = 0;
  for (const it of items) {
    totalSen += Number(it.total_sen ?? 0);
    costSen  += Number(it.line_cost_sen ?? 0);
  }
  const marginSen = totalSen - costSen;
  const marginColor = marginSen > 0
    ? 'var(--c-secondary-a, #2F5D4F)'
    : marginSen < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';

  const columns = buildDrilldownColumns(paymentRefs, canFinance);

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3) var(--space-2) 40px',
      background: 'var(--c-cream)',
    }}>
      <DataGridCompat<SoItem>
        rows={items}
        columns={columns}
        storageKey="so-drilldown-grid.v1"
        rowKey={(it) => it.id}
        embedded
        groupBanner={false}
      />
      <div style={{
        display: 'flex', gap: 'var(--space-4)', justifyContent: 'flex-end',
        alignItems: 'baseline', padding: '8px 8px 2px',
        fontSize: 'var(--fs-11)', fontVariantNumeric: 'tabular-nums',
        color: 'var(--fg-muted)',
      }}>
        <span style={{
          fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Subtotal</span>
        <span>Total <strong style={{ color: 'var(--hz-c-primary)' }}>{fmtSen(totalSen)}</strong></span>
        {canFinance && <span>Line Cost <strong style={{ color: 'var(--c-ink)' }}>{fmtSen(costSen)}</strong></span>}
        {canFinance && <span>Margin <strong style={{ color: marginColor }}>{fmtSen(marginSen)}</strong></span>}
      </div>
    </div>
  );
};

function ConsignmentOrderDrawer({
  row,
  canFinance,
  salespersonName,
  onClose,
  onOpenFull,
  onEdit,
  onPrint,
  onCreateNote,
  onReopen,
}: {
  row: SoRow | null;
  canFinance: boolean;
  salespersonName: string;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onCreateNote: () => void;
  onReopen: () => void;
}) {
  const detailQ = useConsignmentOrderDetail(row?.doc_no ?? null);
  const items = ((detailQ.data?.items ?? []) as SoItem[]).filter((it) => !it.cancelled);
  const open = Boolean(row);
  const st = row ? statusFor(row.status) : null;
  const eff = row ? soStatusDisplay(row.status, row.delivery_state, row.lifecycle_state) : null;
  const statusLabel = row ? (eff?.label ?? (STATUS_LABEL[row.status] || row.status.replace(/_/g, ' '))) : '';

  const subtotalSen = items.length > 0
    ? items.reduce((sum, l) => sum + Number(l.total_sen ?? Number(l.qty ?? 0) * Number(l.unit_price_sen ?? 0)), 0)
    : row?.local_total_sen ?? 0;
  const paidSen = row?.paid_total_sen ?? row?.paid_sen ?? 0;
  const outstandingSen = subtotalSen - paidSen;

  const status = row?.status ?? '';
  const hasChildren = Boolean(row?.has_children);
  const canCreateNote = row ? canCreateConsignmentNote(row) : false;
  const brand = row ? deriveBranding(row) : '';

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Consignment order ${row.doc_no}` : 'Consignment order details'}
    >
      {row && st && (
        <>
          <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
            <button
              type="button"
              onClick={onClose}
              className="text-sidebar-ink-muted hover:text-sidebar-ink"
              aria-label="Close details"
            >
              <X size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[14px] font-bold tracking-wide">{row.doc_no}</div>
              <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Consignment Order</div>
            </div>
            <button
              type="button"
              onClick={onOpenFull}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
            >
              Open full page <ExternalLink size={12} />
            </button>
            <Badge tone={st.tone} variant="solid" size="xs">{statusLabel}</Badge>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="text-[19px] font-bold text-ink">{row.debtor_name || '—'}</div>
            <div className="mt-1.5 flex items-center gap-2.5">
              {brand ? <BrandingPill branding={brand} /> : null}
              <span className="text-[12.5px] text-ink-muted">Ordered {fmtDateOrDash(row.so_date)}</span>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
              <DrawerMeta k="Salesperson" v={salespersonName} />
              <DrawerMeta k="Location" v={row.sales_location || '—'} />
              <DrawerMeta k="Ref No." v={customerRefOf(row) || '—'} mono />
              <DrawerMeta k="Branding" v={brand || '—'} />
              <DrawerMeta k="Order date" v={fmtDateOrDash(row.so_date)} />
              <DrawerMeta k="Processing" v={fmtDateOrDash(row.processing_date)} />
              <DrawerMeta k="Delivery" v={fmtDateOrDash(row.customer_delivery_date)} />
              <DrawerMeta k="Current doc" v={row.current_doc_no ?? row.doc_no} mono />
              <DrawerMeta k="Venue" v={row.venue || '—'} />
              <DrawerMeta k="Payment" v={row.payment_methods_summary || row.payment_method || '—'} />
            </dl>

            <DrawerSection>Customer &amp; delivery</DrawerSection>
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
                  {(row.debtor_name || 'C').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || 'C'}
                </span>
                <div className="min-w-0">
                  <div className="text-[14px] font-bold text-ink">{row.debtor_name}</div>
                  {row.debtor_code && (
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">{row.debtor_code}</div>
                  )}
                </div>
              </div>
              <DrawerKV k="Phone" v={formatPhone(row.phone) || '—'} />
              <DrawerKV k="Email" v={row.email || '—'} />
              <DrawerKV
                k="Address"
                v={[row.address1, row.address2, row.city, row.postcode, row.customer_state].filter(Boolean).join(', ') || '—'}
              />
            </div>

            <DrawerSection>Order lines</DrawerSection>
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-[minmax(0,1fr)_30px_92px_76px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                <span>Item</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Amount</span>
                <span>Stock</span>
              </div>
              {detailQ.isLoading && (
                <div className="px-4 py-8 text-center text-[12px] text-ink-muted">Loading lines…</div>
              )}
              {detailQ.isError && (
                <div className="px-4 py-8 text-center text-[12px] text-err">
                  {detailQ.error instanceof Error ? detailQ.error.message : 'Failed to load lines'}
                </div>
              )}
              {!detailQ.isLoading && !detailQ.isError && items.length === 0 && (
                <div className="px-4 py-8 text-center text-[12px] text-ink-muted">No lines</div>
              )}
              {items.map((l) => {
                const amt = Number(l.total_sen ?? Number(l.qty ?? 0) * Number(l.unit_price_sen ?? 0));
                const { primary, secondary } = orderLineIdentity({
                  code: l.item_code,
                  description: l.description,
                  variant: buildVariantSummary(l.item_group ?? '', l.variants ?? null),
                });
                const stock = stockLabelOf(l);
                return (
                  <div
                    key={l.id}
                    className="grid grid-cols-[minmax(0,1fr)_30px_92px_76px] items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <CategoryPill group={l.item_group} />
                        <span className="text-[12.5px] font-medium leading-snug text-ink">{primary || '—'}</span>
                      </div>
                      {secondary && (
                        <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{secondary}</div>
                      )}
                    </div>
                    <span className="text-right font-money text-[12.5px] text-ink-secondary">{fmtQty(Number(l.qty ?? 0))}</span>
                    <span className="text-right font-money text-[12.5px] font-semibold text-ink">{fmtSen(amt)}</span>
                    <span className={cn(
                      'text-[11px] font-semibold',
                      stock === 'STOCK' && 'text-synced',
                      stock === 'DELIVERED' && 'text-ink-muted',
                      stock === 'PENDING' && 'text-warning-text',
                    )}>{stock}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
              <DrawerTotal k="Subtotal" v={fmtSen(subtotalSen)} />
              <DrawerTotal k="Total" v={fmtSen(subtotalSen)} strong />
              {paidSen > 0 ? <DrawerTotal k="Paid" v={fmtSen(paidSen)} tone="success" /> : null}
              {outstandingSen !== 0 ? (
                <DrawerTotal k={outstandingSen < 0 ? 'Over-collected' : 'Outstanding'} v={fmtSen(outstandingSen)} tone="error" />
              ) : null}
              {canFinance && row.total_margin_sen != null ? (
                <DrawerTotal k="Margin" v={fmtSen(row.total_margin_sen)} />
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
            {!hasChildren && (
              <DrawerButton variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>Edit</DrawerButton>
            )}
            <DrawerButton variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>Print</DrawerButton>
            <div className="flex-1" />
            {status === 'CANCELLED' ? (
              <DrawerButton variant="primary" icon={<RotateCcw size={14} />} onClick={onReopen}>Reopen</DrawerButton>
            ) : canCreateNote ? (
              <DrawerButton variant="primary" icon={<Truck size={14} />} onClick={onCreateNote}>Create Consignment Note</DrawerButton>
            ) : null}
          </div>
        </>
      )}
    </ResizableDetailDrawer>
  );
}

function DrawerMeta({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className={cn('mt-0.5 text-[13px] font-semibold text-ink', mono && 'font-mono')}>{v}</dd>
    </div>
  );
}

function DrawerSection({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{children}</div>
  );
}

function DrawerKV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
      <span className="w-20 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</span>
      <span className="flex-1 text-[13px] font-semibold leading-relaxed text-ink">{v}</span>
    </div>
  );
}

function DrawerTotal({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'success' | 'error' }) {
  return (
    <div className={cn('flex items-center justify-between py-1.5', strong && 'border-t border-border-subtle pt-2.5 mt-1')}>
      <span className={cn('text-[12px] text-ink-muted', strong && 'text-[13px] font-semibold text-ink')}>{k}</span>
      <span className={cn(
        'font-money text-[13px] font-semibold',
        strong && 'text-[15px] font-bold text-ink',
        tone === 'success' && 'text-synced',
        tone === 'error' && 'text-err',
      )}>{v}</span>
    </div>
  );
}

export const ConsignmentOrders = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);
  const [searchParams, setSearchParams] = useSearchParams();
  const outstandingOnly = searchParams.get('outstanding') === '1';

  const [pageSize, setPageSize] = useLocalStorage<number>('scm:perpage:consignment-orders', 50);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  useEffect(() => { setPage(0); }, [outstandingOnly, debouncedSearch]);

  const { data, isLoading, isFetching, isPlaceholderData, error } = useConsignmentOrdersPaged({
    page,
    pageSize: pageSize,
    q: debouncedSearch.trim() || undefined,
    outstanding: outstandingOnly || undefined,
  });
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: debouncedSearch,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const listLoading = isLoading || searchTransition.isSearching;

  const baseRows = useMemo<SoRow[]>(() => (data?.salesOrders ?? []) as SoRow[], [data]);
  const total = data?.total ?? 0;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SoRow | null>(null);
  useEffect(() => { setSel(new Set()); }, [page, outstandingOnly, debouncedSearch]);

  const clearOutstanding = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('outstanding');
    setSearchParams(next, { replace: true });
  };

  const kpis = useMemo(() => {
    const agg = data?.aggregates;
    if (agg) return { revenue: agg.revenueSen, outstanding: agg.outstandingSen, paid: agg.paidSen };
    let revenue = 0, outstanding = 0, paid = 0;
    for (const r of baseRows) {
      revenue += r.local_total_sen ?? 0;
      paid    += r.paid_total_sen ?? r.paid_sen ?? 0;
      const bal = liveBalance(r);
      if (bal > 0) outstanding += bal;
    }
    return { revenue, outstanding, paid };
  }, [data?.aggregates, baseRows]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const onPickListing = (choice: ListingChoice) => {
    const next = new URLSearchParams(searchParams);
    if (choice === 'listing') {
      next.delete('outstanding');
      setSearchParams(next, { replace: true });
    } else if (choice === 'outstanding-listing') {
      next.set('outstanding', '1');
      setSearchParams(next, { replace: true });
    } else if (choice === 'detail-listing') {
      navigate('/scm/reports/sales-order-detail-listing');
    } else if (choice === 'outstanding-detail-listing') {
      navigate('/scm/reports/sales-order-detail-listing?outstanding=1');
    }
  };

  const staffQ = useStaff();
  const staffById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (staffQ.data ?? [])) {
      if (s.id) m.set(s.id, s.name ?? s.staffCode ?? s.id);
    }
    return m;
  }, [staffQ.data]);
  const COLUMNS = useMemo(() => buildColumns(staffById, canFinance), [staffById, canFinance]);

  const updateStatus = useUpdateConsignmentOrderStatus();

  const onNew = () => navigate('/scm/consignment-orders/new');
  const openDetail = (row: SoRow, edit = false) =>
    navigate(`/scm/consignment-orders/${row.doc_no}${edit ? '?edit=1' : ''}`);

  const renderPdf = async (row: SoRow, action: 'save' | 'print' | 'preview') => {
    let json: { salesOrder: unknown; items: unknown[]; pwpCodes?: unknown[] };
    try {
      json = await authedFetch<{ salesOrder: unknown; items: unknown[]; pwpCodes?: unknown[] }>(
        `/consignment-orders/${row.doc_no}`,
      );
    } catch {
      notify({ title: `Failed to load SO ${row.doc_no}`, tone: 'error' }); return;
    }
    let payments: unknown[] = [];
    try {
      const pj = await authedFetch<{ payments?: unknown[] }>(`/consignment-orders/${row.doc_no}/payments`);
      payments = pj.payments ?? [];
    } catch {
      notify({
        title: `Cannot print CO ${row.doc_no} — payments could not be loaded`,
        body: "We couldn't read the payments for this order. Printing now would show the customer an empty Payments table. Please refresh and try again.",
        tone: 'error',
      });
      return;
    }
    await generateSalesOrderPdf(
      json.salesOrder as never, json.items as never, payments as never, action,
      (json.pwpCodes ?? []) as never,
      CONSIGNMENT_ORDER_PDF_OPTS,
    );
  };

  const doDelete = async (row: SoRow) => {
    if (!(await askConfirm({
      title: `Cancel SO ${row.doc_no}?`,
      body: 'This sets status = CANCELLED (soft delete).',
      confirmLabel: 'Cancel order',
      danger: true,
    }))) return;
    updateStatus.mutate(
      { docNo: row.doc_no, status: 'CANCELLED' },
      {
        onError: (e) => notify({ title: 'Failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  const convertToDo = (row: SoRow) => {
    if (!canCreateConsignmentNote(row)) {
      notify({
        title: 'Nothing to be converted',
        body: 'Every line on this Consignment Order is already on a note (or the order is closed / cancelled / on hold).',
      });
      return;
    }
    navigate(`/scm/consignment-notes/new?fromConsignmentOrder=${encodeURIComponent(row.doc_no)}`);
  };

  const copyToNewSo = (row: SoRow) => {
    navigate(`/scm/consignment-orders/new?copyFrom=${encodeURIComponent(row.doc_no)}`);
  };

  const doReopen = async (row: SoRow) => {
    if (!(await askConfirm({
      title: `Reopen ${row.doc_no} back to CONFIRMED so it can proceed again?`,
      confirmLabel: 'Reopen',
    }))) return;
    updateStatus.mutate(
      { docNo: row.doc_no, status: 'CONFIRMED' },
      {
        onSuccess: () => setSelected(null),
        onError: (e) => notify({ title: 'Failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };


  /* KPI tiles are the shared <StatCard/> now (owner 2026-07-26) — the old
     inline kpiTile helper is gone with them. */

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Supply Chain"
        title={`Consignment Orders${outstandingOnly ? ' · Outstanding only' : ''}`}
        actions={
          <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={onNew}>
              <Plus size={14} strokeWidth={1.75} />
              <span>New Consignment Order</span>
            </Button>
          </div>
        }
      />

      {outstandingOnly && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: 'var(--space-1) var(--space-3)',
          background: 'rgba(22, 105, 95, 0.10)',
          border: '1px solid var(--hz-c-primary)',
          borderRadius: 'var(--radius-pill)',
          color: 'var(--hz-c-primary)',
          fontFamily: 'var(--font-button)',
          fontSize: 'var(--fs-12)',
          fontWeight: 600,
          width: 'fit-content',
        }}>
          <span>Outstanding only · balance &gt; 0</span>
          <button type="button" onClick={clearOutstanding} aria-label="Clear outstanding filter"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, padding: 0, background: 'transparent', border: 'none',
              color: 'var(--hz-c-primary)', cursor: 'pointer', borderRadius: '50%' }}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/* ── 4 KPI cards — the SO page's StatCard family (owner 2026-07-26,
          red-box comparison: the flat paper tiles must become the sample's
          white cards with colour rails + toned values). Same mapping as the
          SO strip: Total(primary rail, active) · Revenue(accent) ·
          Outstanding(err, error tone when due) · Paid(synced, success). */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          pending={isLoading}
          label="Total Orders"
          value={fmtQty(total)}
          subtitle="All matching orders"
          rail="bg-primary"
          active
        />
        <StatCard
          pending={isLoading}
          label="Revenue"
          value={fmtSen(kpis.revenue)}
          subtitle="All matching orders"
          rail="bg-accent"
        />
        <StatCard
          pending={isLoading}
          label="Outstanding"
          value={fmtSen(kpis.outstanding)}
          subtitle="Balance due"
          tone={kpis.outstanding > 0 ? 'error' : 'default'}
          rail={kpis.outstanding > 0 ? 'bg-err' : 'bg-border-strong'}
        />
        <StatCard
          pending={isLoading}
          label="Paid"
          value={fmtSen(kpis.paid)}
          subtitle="Receipts to date"
          tone={kpis.paid > 0 ? 'success' : 'default'}
          rail="bg-synced"
        />
      </div>

      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: 'fit-content' }}>
        <Search size={14} strokeWidth={1.75} style={{ position: 'absolute', left: 10, color: 'var(--fg-muted)' }} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search CO no / customer…"
          style={{
            height: 32, padding: '0 12px 0 30px', width: 288,
            borderRadius: 6, border: '1px solid var(--hz-c-border)',
            background: 'var(--hz-c-surface)', color: 'var(--c-ink)', fontSize: 12,
          }}
        />
        <SearchProgress active={searchTransition.isSearching} className="ml-2" />
      </div>

      <ListingPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onChoose={onPickListing}
        detailListingAvailable={true}
        initial={outstandingOnly ? 'outstanding-listing' : 'listing'}
      />

      <DataGridCompat<SoRow>
        rows={searchTransition.resultsAreStale ? [] : baseRows}
        columns={COLUMNS}
        storageKey={STORAGE_KEY}
        exportName="Consignment Orders"
        searchPlaceholder="Search doc no, customer, PO no, reference…"
        rowKey={(r) => r.doc_no}
        getRowClassName={(r) => cancelledRowClass(r.status)}
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        hideSearch
        groupBanner={false}
        onRowClick={(r) => setSelected(r)}
        onRowDoubleClick={(r) => openDetail(r)}
        rowStyle={(r) => r.status === 'CANCELLED'
          ? { opacity: 0.55, filter: 'grayscale(0.6)' }
          : undefined}
        isLoading={listLoading}
        emptyMessage='No consignment orders yet — click "+ New Consignment Order" to start.'
        expandable={{
          renderExpansion: (row) => <ExpandedSoLines docNo={row.doc_no} canFinance={canFinance} />,
          rowExpansionKey: (row) => row.doc_no,
        }}
        contextMenu={(row) => {
          /* HOUZS status-flow actions — Issue DO appears when the SO is
             confirmed/ready (commander's 开单 button), Issue SI appears
             post-delivery. Delete is only allowed once the SO is
             CANCELLED (matches the PO Cancel/Delete pattern from PR #169).
             Tier 2 downstream-lock — hide Edit + Cancel once any non-cancelled
             DO / SI references this SO; Issue DO (partial delivery) stays. */
          const status = row.status;
          const hasChildren = Boolean(row.has_children);
          const items: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [];
          if (!hasChildren) {
            items.push({ label: 'Edit', onClick: () => openDetail(row, true) });
          }
          items.push({ label: 'View',    onClick: () => openDetail(row) });
          items.push({ label: 'Preview', onClick: () => void renderPdf(row, 'preview') });
          items.push({ label: 'Print',   onClick: () => void renderPdf(row, 'print') });
          items.push({ divider: true as const });
          items.push({ label: 'Create Consignment Note', onClick: () => convertToDo(row) });
          items.push({ label: 'Copy to new Consignment Order', onClick: () => copyToNewSo(row) });
          items.push({ divider: true as const });
          if (!['CANCELLED', 'CLOSED'].includes(status) && !hasChildren) {
            items.push({ label: 'Cancel Order', danger: true, onClick: () => doDelete(row) });
          }
          if (status === 'CANCELLED') {
            items.push({ label: 'Reopen SO', onClick: () => void doReopen(row) });
          }
          if (status === 'CANCELLED') {
            items.push({
              label: 'Delete permanently',
              danger: true,
              onClick: async () => {
                if (!(await askConfirm({
                  title: `Permanently delete ${row.doc_no}?`,
                  body: 'This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                }))) return;
                notify({ title: 'Hard delete is not implemented yet', body: 'The SO will stay CANCELLED.', tone: 'error' });
              },
            });
          }
          return items;
        }}
      />

      {!searchTransition.resultsAreStale && <ListPager
        page={page}
        pageSize={pageSize}
        total={total}
        noun="consignment orders"
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
      />}

      <ConsignmentOrderDrawer
        row={selected}
        canFinance={canFinance}
        salespersonName={selected?.salesperson_id ? staffById.get(selected.salesperson_id) ?? '—' : '—'}
        onClose={() => setSelected(null)}
        onOpenFull={() => selected && openDetail(selected)}
        onEdit={() => selected && openDetail(selected, true)}
        onPrint={() => selected && void renderPdf(selected, 'print')}
        onCreateNote={() => selected && convertToDo(selected)}
        onReopen={() => selected && void doReopen(selected)}
      />
    </div>
  );
};

const STORAGE_KEY = 'pr-g.so-list.layout.v1';

const CO_FINANCE_COL_KEYS = new Set<string>([
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis', 'deposit_sen',
]);

const buildAllColumns = (
  staffById: Map<string, string>,
): GridColumn<SoRow>[] => [
  {
    key: 'doc_no', label: 'Doc. No.', width: 160, sortable: true, groupable: false,
    accessor: (r) => (
      <span style={{
        fontWeight: 700, color: 'var(--hz-c-primary)',
        fontVariantNumeric: 'tabular-nums',
      }} className={cancelledDocNoClass(r.status)}>{r.doc_no}</span>
    ),
    searchValue: (r) => `${r.doc_no} ${r.status ?? ''}`,
    filterValue: (r) => r.doc_no,
    filterType: 'numbering',
  },
  {
    key: 'current_doc_no', label: 'Current', width: 150, sortable: true, groupable: true,
    accessor: (r) => (
      <span style={{ fontWeight: 600, color: 'var(--hz-c-primary)', whiteSpace: 'nowrap' }}>
        {r.current_doc_no ?? r.doc_no}
      </span>
    ),
    searchValue: (r) => r.current_doc_no ?? r.doc_no ?? '',
    filterValue: (r) => r.current_doc_no ?? r.doc_no ?? '—',
  },
  {
    key: 'so_date', label: 'Date', width: 110, sortable: true,
    accessor: (r) => fmtDateOrDash(r.so_date),
    searchValue: (r) => `${r.so_date ?? ''} ${fmtDateOrDash(r.so_date)}`,
    filterValue: (r) => fmtDateOrDash(r.so_date),
    sortFn: (a, b) => (a.so_date ?? '').localeCompare(b.so_date ?? ''),
    filterType: 'date', dateValue: (r) => r.so_date,
  },
  {
    key: 'debtor_name', label: 'Customer', width: 220, sortable: true, groupable: true,
    accessor: (r) => r.debtor_name,
    searchValue: (r) => r.debtor_name,
  },
  {
    key: 'salesperson_id', label: 'Salesperson', width: 140, sortable: true, groupable: true,
    accessor: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '—' : '—'),
    searchValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '' : ''),
    groupValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '(none)' : '(none)'),
  },
  {
    key: 'sales_location', label: 'Location', width: 80, sortable: true, groupable: true,
    accessor: (r) => r.sales_location ?? '—',
    searchValue: (r) => r.sales_location ?? '',
    groupValue: (r) => r.sales_location ?? '(none)',
  },
  {
    key: 'customer_so_no', label: 'Ref No.', width: 130, sortable: true,
    accessor: (r) => r.customer_so_no ?? r.po_doc_no ?? r.ref ?? '—',
    searchValue: (r) => `${r.customer_so_no ?? ''} ${r.po_doc_no ?? ''} ${r.ref ?? ''}`,
    filterValue: (r) => r.customer_so_no ?? r.po_doc_no ?? r.ref ?? '—',
    sortFn: (a, b) =>
      (a.customer_so_no ?? a.po_doc_no ?? a.ref ?? '')
        .localeCompare(b.customer_so_no ?? b.po_doc_no ?? b.ref ?? ''),
  },
  {
    /* Branding — AUTO-DERIVED from the SO's FIRST line item (Commander PR
       #266). See `brandingLabel` (owner 2026-08-18): first SOFA → the company's
       house sofa brand ("2990s Sofa" here, "ZANOTTI" under Houzs), first
       BEDFRAME → "Bedframe", first MATTRESS → the SKU's brand falling back to
       "Mattress", first accessory/service/other → its category noun, no
       readable line → "No Items". The rule can no longer return blank, so the
       old "—" case is gone. Rendered as the muted BrandingPill; sortable +
       groupable on the derived label. */
    key: 'branding', label: 'Branding', width: 130, sortable: true, groupable: true,
    accessor: (r) => {
      const b = deriveBranding(r);
      return b ? <BrandingPill branding={b} /> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (r) => deriveBranding(r),
    exportValue: (r) => deriveBranding(r),
    groupValue: (r) => deriveBranding(r) || '(none)',
    sortFn: (a, b) => deriveBranding(a).localeCompare(deriveBranding(b)),
  },
  {
    key: 'venue', label: 'Venue', width: 180, sortable: true, groupable: true,
    accessor: (r) => r.venue ?? '—',
    searchValue: (r) => r.venue ?? '',
    groupValue: (r) => r.venue ?? '(none)',
  },
  {
    key: 'local_total_sen', label: 'Local Total', width: 120, sortable: true, align: 'right', groupable: false,
    accessor: (r) => (
      <span style={{
        fontWeight: 700, color: 'var(--c-ink)',
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtSen(r.local_total_sen)}</span>
    ),
    searchValue: (r) => fmtSen(r.local_total_sen),
    exportValue: (r) => (r.local_total_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => a.local_total_sen - b.local_total_sen,
    filterType: 'number', numberValue: (r) => r.local_total_sen,
  },
  {
    /* Stock Status column. The label names what IS ready (owner 2026-08-16):
         · "READY"                 — green pill, nothing left to allocate
         · "PARTIAL" / "BEDFRAME"  — amber WARNING pill: some of it is in
           / "MATTRESS/ACC"          and the rest is not
         · ""                      — nothing ready yet, or no items
       There is no "READY (PARTIAL)" any more. The state it named — every MAIN
       line in, an accessory short — is now the bare word "PARTIAL", and the
       accessory-only order it used to be printed on (nothing in, cannot ship)
       renders as blank. The branch is `remark !== 'READY'` rather than a match
       on the label text, so a new token inherits the amber slot instead of
       silently falling through to the neutral one. */
    key: 'stock_status', label: 'Stock Status', width: 220, sortable: true, groupable: false,
    /* The pill, the sort, the search and the export come from
       components/StockRemarkPill.tsx (2026-08-17). This column is the DESIGN OF
       RECORD and is unchanged on screen — including #2334's vocabulary and its
       negative branch; what moved is that the SO list and the delivery-planning
       board now render THIS instead of two paler imitations of it. */
    accessor: (r) => <StockRemarkPill remark={r.stock_remark} />,
    searchValue: (r) => stockRemarkSearchValue(r.stock_remark),
    exportValue: (r) => stockRemarkExportValue(r.stock_remark),
    sortFn: (a, b) => stockRemarkSortFn(a.stock_remark, b.stock_remark),
  },
  {
    key: 'mattress_sofa_sen', label: 'Mattress/Sofa', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => {
      const v = r.mattress_sofa_sen ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{
        fontWeight: 600, color: badgeFor('sofa').fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtSen(v)}</span>;
    },
    searchValue: (r) => fmtSen(r.mattress_sofa_sen ?? 0),
    exportValue: (r) => (r.mattress_sofa_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.mattress_sofa_sen ?? 0) - (b.mattress_sofa_sen ?? 0),
  },
  {
    key: 'bedframe_sen', label: 'Bedframe', width: 120, sortable: true, align: 'right', groupable: false,
    accessor: (r) => {
      const v = r.bedframe_sen ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{
        fontWeight: 600, color: badgeFor('bedframe').fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtSen(v)}</span>;
    },
    searchValue: (r) => fmtSen(r.bedframe_sen ?? 0),
    exportValue: (r) => (r.bedframe_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.bedframe_sen ?? 0) - (b.bedframe_sen ?? 0),
  },
  {
    key: 'accessories_sen', label: 'Accessories', width: 120, sortable: true, align: 'right', groupable: false,
    accessor: (r) => {
      const v = r.accessories_sen ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{
        fontWeight: 600, color: badgeFor('accessory').fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtSen(v)}</span>;
    },
    searchValue: (r) => fmtSen(r.accessories_sen ?? 0),
    exportValue: (r) => (r.accessories_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.accessories_sen ?? 0) - (b.accessories_sen ?? 0),
  },
  {
    key: 'mattress_sofa_cost_sen', label: 'Mattress/Sofa Cost', width: 140, sortable: true, align: 'right', groupable: false,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.mattress_sofa_cost_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.mattress_sofa_cost_sen ?? 0),
    exportValue: (r) => (r.mattress_sofa_cost_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.mattress_sofa_cost_sen ?? 0) - (b.mattress_sofa_cost_sen ?? 0),
  },
  {
    key: 'bedframe_cost_sen', label: 'Bedframe Cost', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.bedframe_cost_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.bedframe_cost_sen ?? 0),
    exportValue: (r) => (r.bedframe_cost_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.bedframe_cost_sen ?? 0) - (b.bedframe_cost_sen ?? 0),
  },
  {
    key: 'accessories_cost_sen', label: 'Accessories Cost', width: 140, sortable: true, align: 'right', groupable: false,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.accessories_cost_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.accessories_cost_sen ?? 0),
    exportValue: (r) => (r.accessories_cost_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.accessories_cost_sen ?? 0) - (b.accessories_cost_sen ?? 0),
  },
  {
    key: 'phone', label: 'Phone', width: 130, sortable: true,
    accessor: (r) => formatPhone(r.phone) || '',
    searchValue: (r) => `${r.phone ?? ''} ${formatPhone(r.phone) ?? ''}`,
    filterValue: (r) => formatPhone(r.phone) || '—',
  },
  {
    key: 'address1', label: 'Address 1', width: 180, sortable: true,
    accessor: (r) => r.address1 ?? '',
    searchValue: (r) => r.address1 ?? '',
  },
  {
    key: 'po_doc_no', label: 'PO Doc No.', width: 130, sortable: true,
    accessor: (r) => r.po_doc_no ?? '',
    searchValue: (r) => r.po_doc_no ?? '',
  },
  {
    key: 'debtor_code', label: 'Customer Code', width: 120, sortable: true,
    defaultHidden: true,
    accessor: (r) => r.debtor_code ?? '',
    searchValue: (r) => r.debtor_code ?? '',
  },
  {
    key: 'email', label: 'Email', width: 180, sortable: true,
    defaultHidden: true,
    accessor: (r) => r.email ?? '',
    searchValue: (r) => r.email ?? '',
  },
  {
    key: 'customer_type', label: 'Customer Type', width: 120, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => r.customer_type ?? '',
    searchValue: (r) => r.customer_type ?? '',
  },
  {
    key: 'building_type', label: 'Building Type', width: 120, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => r.building_type ?? '',
    searchValue: (r) => r.building_type ?? '',
  },
  {
    key: 'address2', label: 'Address 2', width: 180, sortable: true,
    defaultHidden: true,
    accessor: (r) => r.address2 ?? '',
    searchValue: (r) => r.address2 ?? '',
  },
  {
    key: 'customer_state', label: 'State', width: 130, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => r.customer_state ?? '',
    searchValue: (r) => r.customer_state ?? '',
  },
  {
    key: 'customer_country', label: 'Country', width: 110, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => r.customer_country ?? '',
    searchValue: (r) => r.customer_country ?? '',
    groupValue: (r) => r.customer_country ?? '(none)',
  },
  {
    key: 'city', label: 'City', width: 130, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => r.city ?? '',
    searchValue: (r) => r.city ?? '',
  },
  {
    key: 'postcode', label: 'Postcode', width: 100, sortable: true,
    defaultHidden: true,
    accessor: (r) => r.postcode ?? '',
    searchValue: (r) => r.postcode ?? '',
  },
  {
    key: 'processing_date', label: 'Processing Date', width: 130, sortable: true,
    defaultHidden: true,
    accessor: (r) => fmtDateOrDash(r.processing_date),
    searchValue: (r) => `${r.processing_date ?? ''} ${fmtDateOrDash(r.processing_date)}`,
    filterType: 'date', dateValue: (r) => r.processing_date,
  },
  {
    key: 'customer_delivery_date', label: 'Delivery Date', width: 130, sortable: true,
    defaultHidden: true,
    accessor: (r) => fmtDateOrDash(r.customer_delivery_date),
    searchValue: (r) => `${r.customer_delivery_date ?? ''} ${fmtDateOrDash(r.customer_delivery_date)}`,
    filterType: 'date', dateValue: (r) => r.customer_delivery_date,
  },
  {
    key: 'payment_method', label: 'Payment Method', width: 150, sortable: true, groupable: true,
    accessor: (r) => {
      if (r.payment_methods_summary) return r.payment_methods_summary;
      if (!r.payment_method) return '';
      const base = r.payment_method.toUpperCase();
      if (r.payment_method === 'merchant') {
        const parts = [r.merchant_provider, r.installment_months ? `${r.installment_months}m` : null]
          .filter(Boolean).join(' · ');
        return parts ? `${base} · ${parts}` : base;
      }
      return base;
    },
    searchValue: (r) => `${r.payment_methods_summary ?? ''} ${r.payment_method ?? ''} ${r.merchant_provider ?? ''}`,
    groupValue: (r) => r.payment_methods_summary || r.payment_method || '(none)',
  },
  {
    key: 'note', label: 'Note', width: 200, sortable: true,
    defaultHidden: true,
    accessor: (r) => r.note ?? '',
    searchValue: (r) => r.note ?? '',
  },
  {
    key: 'others_sen', label: 'Others', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.others_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.others_sen ?? 0),
    exportValue: (r) => (r.others_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.others_sen ?? 0) - (b.others_sen ?? 0),
  },
  {
    key: 'others_cost_sen', label: 'Others Cost', width: 120, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.others_cost_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.others_cost_sen ?? 0),
    exportValue: (r) => (r.others_cost_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.others_cost_sen ?? 0) - (b.others_cost_sen ?? 0),
  },
  {
    key: 'total_cost_sen', label: 'Cost Total', width: 120, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.total_cost_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.total_cost_sen ?? 0),
    exportValue: (r) => (r.total_cost_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.total_cost_sen ?? 0) - (b.total_cost_sen ?? 0),
  },
  {
    key: 'total_margin_sen', label: 'Margin', width: 120, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => {
      const m = r.total_margin_sen ?? 0;
      if ((r.local_total_sen ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      const color = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
      return <span className={styles.money} style={{ color, fontWeight: 600 }}>{fmtSen(m)}</span>;
    },
    searchValue: (r) => fmtSen(r.total_margin_sen ?? 0),
    exportValue: (r) => (r.total_margin_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.total_margin_sen ?? 0) - (b.total_margin_sen ?? 0),
  },
  {
    key: 'margin_pct_basis', label: 'Margin %', width: 100, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => {
      if ((r.local_total_sen ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      const pct = (r.margin_pct_basis ?? 0) / 100;
      const color = pct >= 50 ? 'var(--c-secondary-a, #2F5D4F)'
        : pct >= 30 ? 'var(--c-festive-a, #C77F3E)'
        : pct > 0   ? '#16695f'
        : 'var(--c-festive-b, #B8331F)';
      return <span style={{
        color, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
      }}>{pct.toFixed(1)}%</span>;
    },
    searchValue: (r) => `${((r.margin_pct_basis ?? 0) / 100).toFixed(1)}%`,
    exportValue: (r) => Number(((r.margin_pct_basis ?? 0) / 100).toFixed(1)),
    sortFn: (a, b) => (a.margin_pct_basis ?? 0) - (b.margin_pct_basis ?? 0),
  },
  {
    key: 'deposit_sen', label: 'Deposit', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.deposit_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.deposit_sen ?? 0),
    exportValue: (r) => (r.deposit_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.deposit_sen ?? 0) - (b.deposit_sen ?? 0),
  },
  {
    key: 'paid_total_sen', label: 'Paid', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtSen(r.paid_total_sen ?? r.paid_sen ?? 0)}</span>,
    searchValue: (r) => fmtSen(r.paid_total_sen ?? r.paid_sen ?? 0),
    exportValue: (r) => (r.paid_total_sen ?? r.paid_sen ?? 0) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => (a.paid_total_sen ?? a.paid_sen ?? 0) - (b.paid_total_sen ?? b.paid_sen ?? 0),
  },
  {
    key: 'balance_sen', label: 'Balance', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtSen(liveBalance(r))}</span>,
    searchValue: (r) => fmtSen(liveBalance(r)),
    exportValue: (r) => liveBalance(r) / 100,
    exportFormat: 'money',
    sortFn: (a, b) => liveBalance(a) - liveBalance(b),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => <StatusPill status={r.status} deliveryState={r.delivery_state} lifecycleState={r.lifecycle_state} />,
    searchValue: (r) => r.status,
    exportValue: (r) => {
      const eff = soStatusDisplay(r.status, r.delivery_state, r.lifecycle_state);
      return eff.label ?? STATUS_LABEL[r.status] ?? r.status.replace(/_/g, ' ');
    },
    groupValue: (r) => r.status,
    sortFn: (a, b) => (a.status ?? '').localeCompare(b.status ?? ''),
  },
];

const buildColumns = (
  staffById: Map<string, string>,
  canFinance: boolean,
): GridColumn<SoRow>[] =>
  buildAllColumns(staffById).filter((col) => canFinance || !CO_FINANCE_COL_KEYS.has(col.key));
