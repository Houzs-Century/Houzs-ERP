// PR-G — Sales Order list page rebuild (AutoCount data-grid style).
//
// 2026-05-27 HOUZS chrome-strip (so-list-houzs-chrome) — drop the Office-style
// toolbar (New / Edit / View / Find / Preview / Print / Listing / Print
// Listing PDF / Delete / Refresh) and DataGrid's "drag column header here to
// group by that column" banner. Replace with the Houzs modern flat layout:
//   - Title "Sales Orders" + subtitle ("AutoCount-style ledger view · N
//     total · drag :: to reorder columns")
//   - Top-right CTA: single `+ New Consignment Order` button (every Edit / View /
//     Issue DO / Issue SI / Cancel / Delete affordance now lives on the
//     per-row context menu, gated by current status)
//   - 4 KPI tiles (Total Orders · Revenue · Outstanding · Paid) scoped to
//     the currently visible rows so narrowing the filter row re-scopes
//     the headline numbers (matches the Houzs interactive feel)
//   - Horizontal filter row (Filter icon · search · All Brands ▼ ·
//     All Agents ▼ · All Venues ▼ · date from – to)
//   - <DataGrid groupBanner={false}> hides the "drag column header here to
//     group by that column" banner
//
// 2026-05-27 HOUZS port (so-list-houzs-port): re-ordered columns to match
// HOUZS SO Listing — Doc.No (bold burnt + status pill inline) · Date · Debtor
// Name · Agent · Location · Reference · Branding pill · Venue · Local Total ·
// Mattress/Sofa subtotal (orange) · Bedframe subtotal (green). Added inline
// expand chevron showing per-line breakdown (DataGrid expandable API).
// Action buttons (Issue DO / Issue SI / Cancel / Delete) appear in the
// per-row context menu gated by current status.

import { useEffect, useMemo, useState } from 'react';
import { canViewScmCosting } from "../../auth/salesAccess";
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, X, Search } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ListingPickerDialog, type ListingChoice } from '../../vendor/scm/components/ListingPickerDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, fmtDateOrDash, fmtQty } from '@2990s/shared';
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
import { generateSalesOrderPdf } from '../../vendor/scm/lib/sales-order-pdf';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import { soStatusDisplay, type DeliveryState, type SoLifecycle } from '../../vendor/scm/lib/so-status';
import { useAuth } from '../../auth/AuthContext';
import styles from './MfgSalesOrdersList.module.css';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import soDetailStyles from './SalesOrderDetail.module.css';
import { retryUnlessClientError } from '../../lib/retryPolicy';

/* Local payments hook — lazy-loaded per expanded SO row alongside the detail
   query. Kept local to this page (not exported to flow-queries.ts) because
   the drill-down is the only consumer today; the SO Detail page has its own
   PaymentsTable wiring. TanStack cache key matches the detail query so a
   future refactor can dedupe.*/
type SoPaymentRow = {
  id: string;
  so_doc_no: string;
  paid_at: string | null;
  method: string | null;
  approval_code: string | null;
  amount_centi: number | null;
};
const useSoPaymentsForDrilldown = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-payments', docNo],
  // HOUZS VENDOR: repointed off the supabase session → the vendored authedFetch
  // (→ /api/scm). Same endpoint + shape.
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
  /* HOUZS port — `agent` (text on header) + `sales_location` (warehouse
     short code: KL / PG / etc) are populated for HOUZS-style B2B SOs.
     For 2990's POS-origin SOs they may be null; the column accessors
     fall back to a dash so the grid still reads cleanly. */
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  salesperson_id: string | null;
  customer_so_no: string | null;
  /* HOUZS Reference column wants the customer's PO doc number too. The
     SO header carries it as `po_doc_no` (mfg_sales_orders column added
     in PR-G; populated by SO New form's "Customer PO #" field). */
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
  /* The Processing Date — the ONE internal date, distinct from the
     customer-facing customer_delivery_date. Hidden by default; coordinator
     reveals via right-click. Was `internal_expected_dd` until mig 0284 settled
     the column on the name everyone already says; the dead legacy
     `processing_date` this row type used to ALSO carry (never written by
     anything) went with it. */
  processing_date: string | null;
  /* PR #46 — POS handover target_date (Marketing-side "Target Date" stamp). */
  target_date: string | null;
  /* PR #143 — Header-level payment method (cash | transfer | merchant) +
     installment plan / merchant provider. Populated when the SO carries a
     single-shot deposit; per-payment ledger lives in mfg_sales_order_payments. */
  payment_method: string | null;
  installment_months: number | null;
  merchant_provider: string | null;
  /* #19 (Commander 2026-05-29) — distinct payment methods drawn from the
     mfg_sales_order_payments ledger, joined with " + " (e.g. "Cash + Card").
     '' when no receipts logged yet; the column falls back to the header
     payment_method field in that case. Computed server-side in the SO list GET. */
  payment_methods_summary?: string;
  note: string | null;
  local_total_centi: number;
  /* Live balance + paid total come from mfg_sales_orders_with_payment_totals
     view (migration 0076). Fall back to legacy balance_centi → (local_total
     − paid_centi) when the view isn't surfaced. */
  balance_centi: number;
  balance_centi_live?: number | null;
  paid_total_centi?: number | null;
  paid_centi: number;
  /* FINANCE-gated (in CO_FINANCE_KEYS server-side, mirroring the SO list where
     #574 ruled Deposit a finance column) — OMITTED for a non-finance caller,
     hence optional. Only the canFinance-gated Deposit column reads it. */
  deposit_centi?: number | null;
  status: string;
  currency: string;
  /* Task #114 — Per-category REVENUE + COST + overall cost/margin from the
     SO header. All four cost columns added in migration 0079; pre-existing
     rows backfill on next item mutation (recomputeTotals). Optional on the
     row type so the list still renders if the API hasn't been redeployed —
     AND because the server now strips them for a non-finance caller
     (CO_FINANCE_KEYS / canViewScmFinance). */
  mattress_sofa_centi?: number;
  bedframe_centi?: number;
  accessories_centi?: number;
  others_centi?: number;
  mattress_sofa_cost_centi?: number;
  bedframe_cost_centi?: number;
  accessories_cost_centi?: number;
  others_cost_centi?: number;
  total_cost_centi?: number;
  total_margin_centi?: number;
  margin_pct_basis?: number;
  /* PR — Commander 2026-05-28: Stock Status chip.
     Computed server-side from mfg_sales_order_items.stock_status grouped
     by item_group. ready_categories = list of categories where ALL items
     are READY (e.g. ['MATTRESS','BEDFRAME']). is_fully_ready = every line
     is READY (column shows "READY" pill). */
  ready_categories?: string[];
  is_fully_ready?: boolean;
  /* stock_remark names what is MISSING (owner 2026-08-16): "" for an SO with no
     lines, "READY" when everything that must be allocated is, else
     "SHORT: <categories>". It never reads READY while something is short — the
     old vocabulary ("READY (PARTIAL)" / "BEDFRAME" / "MATTRESS/ACC") stated what
     was READY and so labelled an accessory-only order READY (PARTIAL) while it
     could not ship. is_main_ready is true once every MAIN (sofa/bedframe/
     mattress) line is in stock — and VACUOUSLY true when the SO has no main
     line, so never label off it. Derived in the SO list GET via
     summariseReadiness. */
  stock_remark?: string;
  is_main_ready?: boolean;
  /* Branding auto-derive (Commander 2026-05-28): distinct normalized product
     categories present on the SO's non-cancelled lines — one of
     'SOFA' | 'MATTRESS' | 'BEDFRAME' | 'ACCESSORY' | 'OTHERS'. Computed
     server-side in the SO list GET (mfg-sales-orders route) from the same
     per-line fetch that drives Stock Status. Lets the Branding column tell
     SOFA from MATTRESS even though they share one header revenue column. */
  item_categories?: string[];
  /* Branding refinement (Commander PR #266): the Branding column now follows
     the SO's FIRST line item rather than collapsing to "Mixed". The API hands
     back the earliest-created line's normalized category + its own branding:
       · first_item_category  — 'SOFA' | 'MATTRESS' | 'BEDFRAME' | 'ACCESSORY' | 'OTHERS'
       · first_item_branding  — the line's branding text (mattress brand, e.g.
                                "HAPPISLEEP" / "CARRES"); falls back server-side
                                to mfg_products.branding when the line is blank. */
  first_item_category?: string;
  first_item_branding?: string | null;
  /* Tier 2 downstream-lock — list endpoint stamps this flag when the SO has
     ANY non-cancelled DO / SI. Hides Edit + Cancel from the context menu;
     Convert-to-DO stays available (partial delivery). */
  has_children?: boolean;
  /* List endpoint stamps this when the SO still has at least one line that can
     be delivered (remaining = qty − delivered + returned > 0), recomputed live
     so it re-opens after a DO is cancelled / a DO line is deleted. Drives the
     "Issue Delivery Order" menu entry instead of a status-only gate. */
  has_undelivered?: boolean;
  /* Live delivery progress — 'none' before the first DO, 'partial' once some
     qty has shipped but a balance remains, 'full' once nothing remains. Drives
     the "Partially Delivered" / "Delivered" status badge. */
  delivery_state?: DeliveryState;
  /* Document-driven status (latest event wins) — 'delivered' | 'invoiced' |
     'returned', else 'none' before any downstream document exists. */
  lifecycle_state?: SoLifecycle;
  /* Current document — the number of the furthest-forward document the flow has
     reached (DO / SI / DR), falling back to this SO's own number when nothing
     downstream exists yet. Same "latest event wins" order as the status badge. */
  current_doc_no?: string | null;
};

const fmtRm = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Compact date — "2026/04/21". Falls back to the raw ISO string when the
   source isn't a parseable date so legacy data still shows. */
const compactDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  // Accept either YYYY-MM-DD or a full ISO timestamp.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}/${m[2]}/${m[3]}`;
};

/* Follow-up #83 — Balance column source-of-truth chain:
   1. view's balance_centi_live (local_total − sum(payments))
   2. header.balance_centi (legacy stored value)
   3. local_total − header.paid_centi (last-resort derivation) */
const liveBalance = (r: SoRow): number => {
  if (typeof r.balance_centi_live === 'number') return r.balance_centi_live;
  if (typeof r.balance_centi === 'number') return r.balance_centi;
  return r.local_total_centi - (r.paid_centi ?? 0);
};

/* Branding auto-derive (Commander 2026-05-28, refined PR #266). The Branding
   column is derived per row — no longer stored free-text. It now FOLLOWS THE
   FIRST LINE ITEM rather than collapsing to "Mixed" when categories differ.
   The SO list API hands back the earliest-created line's normalized category
   (`first_item_category`) plus that line's own branding (`first_item_branding`,
   the mattress brand). Rules:
     · first item SOFA      → "2990 Sofa"
     · first item BEDFRAME  → "Bedframe"
     · first item MATTRESS  → the mattress's OWN brand (e.g. "HAPPISLEEP" /
                              "CARRES" / "2990" / "MyMattress"); falls back to
                              "2990 Mattress" when the brand is blank
     · first item ACCESSORY / OTHERS → "2990" (no dedicated furniture brand)
     · no items             → "" (column renders "—")
   Sortable + groupable + filterable via the same derived string. */
const deriveBranding = (r: SoRow): string => {
  const cat = r.first_item_category;
  if (!cat) return '';                       // no items → "—"
  if (cat === 'SOFA')     return '2990 Sofa';
  if (cat === 'BEDFRAME') return 'Bedframe';
  if (cat === 'MATTRESS') {
    // Mattress brand follows the product's own branding. The 2990 house
    // brand (stored as "2990" / "2990's") displays as "2990 Mattress";
    // other brands (HAPPISLEEP, CARRES, MyMattress…) show as-is.
    // (Commander 2026-05-28: "2990 mattress 而不是 2990".)
    const b = (r.first_item_branding ?? '').trim();
    if (!b || /^2990('?s)?$/i.test(b)) return '2990 Mattress';
    return b;
  }
  return '';                                 // accessory / others → none ("—")  (Commander 2026-05-28)
};

const STATUS_CLASS: Record<string, string> = {
  // DRAFT removed in migration 0078 — SOs start at CONFIRMED.
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

/* HOUZS expand-chevron drill-down. Renders the per-line breakdown for a
   single SO inline under its parent row. Lazy-fetches the SO detail (header
   + items) via useConsignmentOrderDetail — TanStack caches it so re-expanding
   the same row is instant. Designed to render INSIDE a single <td colSpan>
   provided by DataGrid.expandable.

   Columns match the Houzs reference shot (commander 2026-05-27):
     GROUP · ITEM CODE · DESCRIPTION · UOM · QTY · UNIT PRICE · TOTAL
       · UNIT COST · LINE COST · MARGIN · PAYMENT
   Plus a Subtotal footer row summing TOTAL / LINE COST / MARGIN.

   Cancelled lines are filtered client-side — the existing detail endpoint
   does not apply a `cancelled = false` filter. */
type SoItem = {
  id: string;
  /* snake_case off the Supabase REST response — matches the rest of the
     fields surfaced by `ITEM` in apps/api/src/routes/mfg-sales-orders.ts.
     Earlier camelCase typing here was wrong (the API never transforms). */
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  /* Per-line variant bag — fed to buildVariantSummary so the drill-down's
     Description cell renders the SAME live summary as the SO detail page +
     report ("BF-01 / SEAT 24 / LEG 6\""). Computed live rather than read from
     the stored `description2` snapshot, which drifts: older rows still carry
     the retired " · " seat·leg separator, so reading the snapshot showed mixed
     "/" and "·" within one order (Commander 2026-05-29). */
  variants: Record<string, unknown> | null;
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  total_centi: number | null;
  stock_status: string | null;
  cancelled: boolean | null;
  /* Delivery breakdown stamped by the SO detail endpoint — which DO took how
     much off this line, plus the live balance still deliverable. Drives the
     drill-down's "Delivered" column. */
  deliveries?: { doNumber: string; qty: number; status: string }[];
  delivered_qty?: number;
  remaining_qty?: number;
  /* Incoming-stock coverage — the PO this line's goods were raised into +
     earliest ETA, shown when the line hasn't shipped yet. null when no PO. */
  coverage_po?: string | null;
  coverage_eta?: string | null;
  stock_state?: 'stock' | 'po' | 'shortage' | null;
};

/* Inline `CategoryPill` re-uses the shared `badgeFor` palette so the pill
   colours stay in lockstep with the SO list's category subtotal columns +
   the per-row Mattress/Sofa/Bedframe/Acc swatches. Kept as a local thin
   wrapper because `ItemGroupPill` already exists for the legacy 7-column
   drill-down; renaming-in-place would risk diverging callers. */
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

/* Per-line cost/margin/stock derivations — shared by the drill-down's column
   accessors AND its sort comparators so a sorted cell always agrees with the
   value it sorted by. Mirror the SO detail page's fallbacks (older rows lack
   the stored line_cost/line_margin snapshots). */
const lineCostOf = (it: SoItem): number =>
  it.line_cost_centi != null
    ? Number(it.line_cost_centi)
    : Number(it.qty ?? 0) * Number(it.unit_cost_centi ?? 0);
const lineMarginOf = (it: SoItem): number =>
  it.line_margin_centi != null
    ? Number(it.line_margin_centi)
    : Number(it.total_centi ?? 0) - lineCostOf(it);
/* Stock readiness label — STOCK (on hand) / PENDING (not yet) / DELIVERED
   (fully shipped). The incoming-PO + ETA coverage hint that used to sit here
   was removed (Wei Siang 2026-05-31): it's an MRP-side reminder, redundant in
   the SO drill-down. */
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
const buildDrilldownColumns = (paymentRefs: string, canFinance: boolean): DataGridColumn<SoItem>[] => [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{it.item_code ?? '—'}</span>,
    searchValue: (it) => it.item_code ?? '',
    sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      /* Main description only — the variant summary now lives in its own
         "Description 2" column. Bare "—" only when description is empty and
         no variant exists to fall back on. */
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
    accessor: (it) => it.qty ?? 0,
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    key: 'delivered', label: 'Transfer To (DO)', width: 130,
    accessor: (it) => {
      const hasDeliveries = it.deliveries && it.deliveries.length > 0;
      if (!hasDeliveries) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return (
        <div>
          {it.deliveries!.map((d, di) => (
            <div key={di} style={{ fontWeight: 600, color: '#16695f', whiteSpace: 'nowrap' }}>
              {d.doNumber} <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>×{d.qty}</span>
            </div>
          ))}
          {typeof it.remaining_qty === 'number' && (
            <div style={{
              fontSize: 'var(--fs-10)', marginTop: 1,
              color: it.remaining_qty > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
            }}>
              {it.remaining_qty > 0 ? `Balance ${it.remaining_qty}` : 'Fully delivered'}
            </div>
          )}
        </div>
      );
    },
    searchValue: (it) => (it.deliveries ?? []).map((d) => d.doNumber).join(' '),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtRm(Number(it.unit_price_centi ?? 0)),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'total', label: 'Total', width: 100, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{fmtRm(Number(it.total_centi ?? 0))}</span>,
    searchValue: (it) => String(it.total_centi ?? 0),
    sortFn: (a, b) => Number(a.total_centi ?? 0) - Number(b.total_centi ?? 0),
  },
  ...(canFinance
    ? ([
        {
          key: 'unit_cost', label: 'Unit Cost', width: 100, align: 'right',
          accessor: (it) => fmtRm(Number(it.unit_cost_centi ?? 0)),
          searchValue: (it) => String(it.unit_cost_centi ?? 0),
          sortFn: (a, b) => Number(a.unit_cost_centi ?? 0) - Number(b.unit_cost_centi ?? 0),
        },
        {
          key: 'line_cost', label: 'Line Cost', width: 100, align: 'right',
          accessor: (it) => fmtRm(lineCostOf(it)),
          searchValue: (it) => String(lineCostOf(it)),
          sortFn: (a, b) => lineCostOf(a) - lineCostOf(b),
        },
        {
          key: 'margin', label: 'Margin', width: 100, align: 'right',
          accessor: (it) => {
            const m = lineMarginOf(it);
            const c = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
            return <span style={{ color: c, fontWeight: 600 }}>{fmtRm(m)}</span>;
          },
          searchValue: (it) => String(lineMarginOf(it)),
          sortFn: (a, b) => lineMarginOf(a) - lineMarginOf(b),
        },
      ] as DataGridColumn<SoItem>[])
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
          color: green ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--fg-muted)',
          background: green ? 'rgba(47,93,79,0.12)' : 'rgba(34,31,32,0.06)',
        }}>{label}</span>
      );
    },
    searchValue: (it) => stockLabelOf(it),
    groupValue: (it) => stockLabelOf(it),
  },
  {
    /* Incoming-PO coverage (PO# + ETA), from the MRP allocation. Lifted out
       of the Stock cell — crammed in there it read as an auxiliary hint, but
       it's real content (which PO covers this line + when it lands), so it
       gets its own normal, shown-by-default column (Wei Siang 2026-05-31).
       The operator can still hide it via the Columns menu like any column. */
    key: 'coverage', label: 'Incoming PO', width: 150,
    accessor: (it) => {
      if (!it.coverage_po) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return (
        <span style={{ fontSize: 'var(--fs-10)', fontWeight: 600, color: '#16695f', whiteSpace: 'nowrap' }}>
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
  /* Parallel payments fetch — Houzs PAYMENT column shows
     `(approvalCode/customer_so_ref)` per receipt. Failure is non-fatal:
     the column falls back to a dash if the request errors. */
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
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const allItems = (q.data?.items ?? []) as SoItem[];
  /* Filter out cancelled lines client-side — the existing detail endpoint
     returns them too (used by the SO Detail page's cancelled-line audit
     panel). Houzs drill-down only shows live lines. */
  const items = allItems.filter((it) => !it.cancelled);
  /* Customer-side SO ref (HC10883 etc.) — used as the second token in the
     Houzs payment ref string `(approval/HCref)`. Falls back to the
     header's `ref` text when customer_so_no is empty. */
  const soHeader = (q.data?.salesOrder ?? null) as { customer_so_no?: string | null; ref?: string | null } | null;
  const customerSoRef = soHeader?.customer_so_no || soHeader?.ref || '';
  /* Houzs joins payment refs as `(approval/HCref)(approval/HCref)…` —
     newest-first per the API's order(paid_at desc). Empty when no payments. */
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

  /* Subtotal/margin/cost rollups — drive the Houzs Subtotal footer row.
     Mirrors the per-line accessors so the totals always agree with the
     visible cells (no rounding drift from sub-cent math). */
  let totalCenti = 0;
  let costCenti  = 0;
  for (const it of items) {
    totalCenti += Number(it.total_centi ?? 0);
    costCenti  += Number(it.line_cost_centi ?? 0);
  }
  const marginCenti = totalCenti - costCenti;
  const marginColor = marginCenti > 0
    ? 'var(--c-secondary-a, #2F5D4F)'
    : marginCenti < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';

  const columns = buildDrilldownColumns(paymentRefs, canFinance);

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3) var(--space-2) 40px',
      background: 'var(--c-cream)',
    }}>
      {/* The drill-down is now the SAME configurable grid as the main list
          (add/remove · drag-reorder · resize · right-click header), in compact
          `embedded` mode (no search box / footer chrome). Layout persists under
          one shared key so the operator's column choices follow them into every
          SO they expand. */}
      <DataGrid<SoItem>
        rows={items}
        columns={columns}
        storageKey="so-drilldown-grid.v1"
        rowKey={(it) => it.id}
        embedded
        groupBanner={false}
      />
      {/* Subtotal — a compact summary line under the grid rather than a
          column-aligned footer row, which can't survive columns being
          reordered / hidden now that they're configurable. */}
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
        <span>Total <strong style={{ color: '#16695f' }}>{fmtRm(totalCenti)}</strong></span>
        {canFinance && <span>Line Cost <strong style={{ color: 'var(--c-ink)' }}>{fmtRm(costCenti)}</strong></span>}
        {canFinance && <span>Margin <strong style={{ color: marginColor }}>{fmtRm(marginCenti)}</strong></span>}
      </div>
    </div>
  );
};

export const ConsignmentOrders = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  /* Finance-viewer gate — same signal the SO/DO/SI/DR surfaces use
     (auth/me = isFinanceViewer, #574 / #589). Consignment never got this gate. */
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);
  const [searchParams, setSearchParams] = useSearchParams();
  /* Task #120 — Outstanding filter overlay. `?outstanding=1` narrows the list
     to rows with live balance > 0; now applied SERVER-SIDE (so it stays correct
     across pages, and the total + aggregate agree). Clear-chip restores. */
  const outstandingOnly = searchParams.get('outstanding') === '1';

  const [pageSize, setPageSize] = useLocalStorage<number>('scm:perpage:consignment-orders', 50);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  // Debounce the search box so each keystroke doesn't fire a server round-trip.
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  /* Server-side pagination + search + outstanding overlay (mirrors Suppliers.tsx).
     Reset to page 0 whenever a server-query input changes so we never strand the
     operator on an out-of-range page. */
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

  /* Server page rows + grand total. The outstanding overlay + free-text search
     are resolved server-side; the DataGrid's own per-column funnel filters +
     grouping now operate on the LOADED PAGE only (documented reduction). The KPI
     tiles below stay FULL-SET via `aggregates`, so page-scoped funnels never
     distort the headline money. */
  const baseRows = useMemo<SoRow[]>(() => (data?.salesOrders ?? []) as SoRow[], [data]);
  const total = data?.total ?? 0;
  // Row-click multi-select (mirrors the SO / DO / GRN lists) — ticks the row;
  // the ▸ chevron still drills down via its own stopPropagation handler.
  const [sel, setSel] = useState<Set<string>>(new Set());
  /* Clear the selection whenever the visible row set shifts (page / overlay /
     search) — a lingering selection would act on rows no longer on screen. */
  useEffect(() => { setSel(new Set()); }, [page, outstandingOnly, debouncedSearch]);

  const clearOutstanding = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('outstanding');
    setSearchParams(next, { replace: true });
  };

  /* 4 KPI tiles — FULL-SET via the server `aggregates` (Revenue / Outstanding /
     Paid summed over the same search + outstanding filters as the page).
     Defensive fallback: if aggregates is absent (old backend / mid-deploy) sum
     the loaded page — labelled the same, the money is just page-scoped then. */
  const kpis = useMemo(() => {
    const agg = data?.aggregates;
    if (agg) return { revenue: agg.revenueCenti, outstanding: agg.outstandingCenti, paid: agg.paidCenti };
    let revenue = 0, outstanding = 0, paid = 0;
    for (const r of baseRows) {
      revenue += r.local_total_centi ?? 0;
      paid    += r.paid_total_centi ?? r.paid_centi ?? 0;
      const bal = liveBalance(r);
      if (bal > 0) outstanding += bal;
    }
    return { revenue, outstanding, paid };
  }, [data?.aggregates, baseRows]);

  /* The Listing picker dialog (Listing / Outstanding-only / Detail Listing /
     Outstanding Detail Listing) is no longer surfaced in the chrome — the
     outstanding toggle now flows in via ?outstanding=1 from the sidebar
     and the detail listing has its own /reports/sales-order-detail-listing
     route. Dialog kept dormant in case a future menu wants to reopen it. */
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

  /* Salesperson column → look up staff name from salesperson_id. Stable
     map memoized off the staff list so DataGrid's column memo only
     invalidates when staff actually changes. */
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

  // ── Row handlers (no toolbar — every action lives on the row's
  //    right-click context menu, gated by status). ───────────────────
  const onNew = () => navigate('/scm/consignment-orders/new');
  const openDetail = (row: SoRow, edit = false) =>
    navigate(`/scm/consignment-orders/${row.doc_no}${edit ? '?edit=1' : ''}`);

  const renderPdf = async (row: SoRow, action: 'save' | 'print' | 'preview') => {
    // One-shot fetch when the toolbar button fires — avoids holding a
    // TanStack query open for every list selection.
    // Followup #81: parallel-fetch payments from the ledger alongside the
    // SO detail. HOUZS VENDOR: both reads repointed off the supabase session →
    // the vendored authedFetch (→ /api/scm). Same endpoints + shapes.
    let json: { salesOrder: unknown; items: unknown[]; pwpCodes?: unknown[] };
    try {
      json = await authedFetch<{ salesOrder: unknown; items: unknown[]; pwpCodes?: unknown[] }>(
        `/consignment-orders/${row.doc_no}`,
      );
    } catch {
      notify({ title: `Failed to load SO ${row.doc_no}`, tone: 'error' }); return;
    }
    /* Payments used to be "best-effort" — a failed read left the array empty so
       the PDF "still renders". But this document LEAVES THE BUILDING: it is what
       the customer is handed. Printing it with an empty Payments table does not
       degrade gracefully, it states a FALSE FACT — that the customer has paid
       nothing and owes the full total. "The read failed" became "nothing was
       paid". Same class as the SO list PDF fixed on 2026-07-19.

       A failed payments read now stops the print and says so. Not printing is
       recoverable; handing a customer a wrong statement of what they owe is not. */
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
    /* Follow-up #83 — action routes the PDF to doc.save() / hidden iframe
       print / blob preview, instead of always downloading and asking the
       user to find the file. Payments arg from #81 is threaded through. */
    await generateSalesOrderPdf(
      json.salesOrder as never, json.items as never, payments as never, action,
      (json.pwpCodes ?? []) as never,
      { docTitle: 'CONSIGNMENT ORDER', docNoLabel: 'CO No', docNoun: 'consignment order' },
    );
  };

  /* Soft-delete a SO row (sets status=CANCELLED). Fired from the row
     context menu — the toolbar Delete button is gone. */
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

  /* Issue Delivery Order — navigate to the full Create-DO screen prefilled
     from this SO (debtor, sales agent, address, phone, line items with
     variants + prices, AND payment records). The operator reviews/edits and
     Saves to create the DO. Replaces the old window.confirm() + convert
     endpoint, which silently dropped the sales agent + payments. */
  const convertToDo = (row: SoRow) => {
    // Commander 2026-05-30 — "Issue Delivery Order" is ALWAYS shown in the menu
    // (so the operator never thinks the feature vanished). When there's nothing
    // left to deliver, tell them plainly instead of silently doing nothing.
    if (!row.has_undelivered || ['CANCELLED', 'CLOSED', 'ON_HOLD'].includes(row.status)) {
      notify({
        title: 'Nothing to be converted',
        body: 'Every line on this Consignment Order is already on a note (or the order is closed / cancelled / on hold).',
      });
      return;
    }
    navigate(`/scm/consignment-notes/new?fromConsignmentOrder=${encodeURIComponent(row.doc_no)}`);
  };

  /* Copy to new SO: hand the source doc number to the New SO page, which
     fetches it and pre-fills customer + line items (dates/payments excluded). */
  const copyToNewSo = (row: SoRow) => {
    navigate(`/scm/consignment-orders/new?copyFrom=${encodeURIComponent(row.doc_no)}`);
  };

  // ── Columns (23 reference + 1 status pill) ──────────────────────
  // Order matches the AutoCount reference layout the commander provided.
  // Customer Name = debtor_name (Commander PR #46 rename in flight).
  // Customer SO Ref + Delivery Date inserted into the AutoCount layout.

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
          border: '1px solid #16695f',
          borderRadius: 'var(--radius-pill)',
          color: '#16695f',
          fontFamily: 'var(--font-button)',
          fontSize: 'var(--fs-12)',
          fontWeight: 600,
          width: 'fit-content',
        }}>
          <span>Outstanding only · balance &gt; 0</span>
          <button type="button" onClick={clearOutstanding} aria-label="Clear outstanding filter"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, padding: 0, background: 'transparent', border: 'none',
              color: '#16695f', cursor: 'pointer', borderRadius: '50%' }}>
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
          value={`RM ${fmtRm(kpis.revenue)}`}
          subtitle="All matching orders"
          rail="bg-accent"
        />
        <StatCard
          pending={isLoading}
          label="Outstanding"
          value={`RM ${fmtRm(kpis.outstanding)}`}
          subtitle="Balance due"
          tone={kpis.outstanding > 0 ? 'error' : 'default'}
          rail={kpis.outstanding > 0 ? 'bg-err' : 'bg-border-strong'}
        />
        <StatCard
          pending={isLoading}
          label="Paid"
          value={`RM ${fmtRm(kpis.paid)}`}
          subtitle="Receipts to date"
          tone={kpis.paid > 0 ? 'success' : 'default'}
          rail="bg-synced"
        />
      </div>

      {/* Page-level search — drives the SERVER query (the DataGrid's own search
          is hidden via `hideSearch` so it can't silently filter just the loaded
          page). Searches CO no + customer name server-side. */}
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: 'fit-content' }}>
        <Search size={14} strokeWidth={1.75} style={{ position: 'absolute', left: 10, color: 'var(--fg-muted)' }} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search CO no / customer…"
          style={{
            height: 32, padding: '0 12px 0 30px', width: 288,
            borderRadius: 6, border: '1px solid #d6d9d2',
            background: '#ffffff', color: 'var(--c-ink)', fontSize: 12,
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

      <DataGrid<SoRow>
        rows={searchTransition.resultsAreStale ? [] : baseRows}
        columns={COLUMNS}
        storageKey={STORAGE_KEY}
        exportName="Consignment Orders"
        searchPlaceholder="Search doc no, customer, PO no, reference…"
        rowKey={(r) => r.doc_no}
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        /* Search is driven server-side from the page-level input above; hide the
           grid's own box so it can't filter just the loaded page. */
        hideSearch
        /* Houzs chrome — kill the "drag column header here to group by
           that column" banner; the page-level filter row replaces it. */
        groupBanner={false}
        onRowDoubleClick={(r) => openDetail(r)}
        /* Commander 2026-05-29 — cancelled SOs grey out in the list so they
           read as dead/inactive (they no longer proceed). */
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
          // Issue DO — ALWAYS shown (Commander 2026-05-30) so the operator never
          // thinks the action disappeared. convertToDo decides at click time
          // whether there's anything to deliver (has_undelivered is recomputed
          // live: qty − delivered + returned > 0) and otherwise shows a plain
          // "Nothing to be converted" message.
          items.push({ label: 'Create Consignment Note', onClick: () => convertToDo(row) });
          // Consignment has no Sales Invoice step (settlement deferred), so no
          // "Issue Sales Invoice" action here.
          items.push({ label: 'Copy to new Consignment Order', onClick: () => copyToNewSo(row) });
          items.push({ divider: true as const });
          // Cancel — soft-delete (status → CANCELLED). Hidden once already
          // cancelled / closed / downstream-locked so the menu doesn't offer
          // a no-op.
          if (!['CANCELLED', 'CLOSED'].includes(status) && !hasChildren) {
            items.push({ label: 'Cancel Order', danger: true, onClick: () => doDelete(row) });
          }
          // Reopen — bring a cancelled SO back to CONFIRMED so it proceeds
          // again (Commander 2026-05-29).
          if (status === 'CANCELLED') {
            items.push({
              label: 'Reopen SO',
              onClick: async () => {
                if (!(await askConfirm({
                  title: `Reopen ${row.doc_no} back to CONFIRMED so it can proceed again?`,
                  confirmLabel: 'Reopen',
                }))) return;
                updateStatus.mutate({ docNo: row.doc_no, status: 'CONFIRMED' });
              },
            });
          }
          // Hard delete — only after a SO has been CANCELLED, matching the
          // PO Cancel/Delete pattern. Today the DELETE endpoint is gated
          // server-side so this is just the UI affordance.
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
    </div>
  );
};

const STORAGE_KEY = 'pr-g.so-list.layout.v1';

/* buildColumns — declared as a function so the component can pass a fresh
   `staffById` map every render (memoized inside the component to avoid
   invalidating DataGrid's column memo on every keystroke).

   2026-05-27 HOUZS port v2 — reordered to match the Houzs SO Listing
   reference exactly. The 18 default-visible columns mirror Houzs's
   header-level listing (cherry-picking the 18 of 19 that 2990's schema
   actually populates — `Account Sheet` is finance-side and not on the
   SO header today). Long-tail columns retained but hidden by default
   via `defaultHidden: true` — user reveals them via right-click
   "Show column".

   Houzs default 19 columns:
     1. Doc.No  2. Date  3. Debtor Name  4. Agent  5. Location
     6. Reference (= customer_so_no or ref)  7. Branding  8. Venue
     9. Local Total  10. Mattress/Sofa subtotal  11. Bedframe subtotal
     12. Accessories subtotal  13. Mattress/Sofa Cost  14. Bedframe Cost
     15. Accessories Cost  16. Phone  17. Address 1  18. PO Doc No.
     19. (Account Sheet — not in our schema; omitted) */
/* FINANCE column keys — the exact CO_FINANCE_KEYS the server strips for a
   non-finance caller (consignment-orders.ts). Unlike the SO list's contiguous
   finance block, these are interleaved with non-finance columns here, so
   buildColumns filters by this set rather than spreading a conditional block —
   same outcome: the column is never DECLARED, so the column chooser never lists
   an always-empty finance column (off, not hidden). Keep in sync with
   CO_FINANCE_KEYS. */
const CO_FINANCE_COL_KEYS = new Set<string>([
  'mattress_sofa_centi', 'bedframe_centi', 'accessories_centi', 'others_centi',
  'mattress_sofa_cost_centi', 'bedframe_cost_centi', 'accessories_cost_centi', 'others_cost_centi',
  'total_cost_centi', 'total_margin_centi', 'margin_pct_basis', 'deposit_centi',
]);

const buildAllColumns = (
  staffById: Map<string, string>,
): DataGridColumn<SoRow>[] => [
  /* ── HOUZS default-visible 18 ─────────────────────────────────────── */
  {
    key: 'doc_no', label: 'Doc. No.', width: 160, sortable: true, groupable: false,
    /* HOUZS-style — burnt-bold doc number followed by a status pill so the
       user sees state without scrolling 20 columns right. */
    /* Status is shown in the dedicated Status column further right — don't
       duplicate it next to the doc number (Wei Siang 2026-05-30). */
    accessor: (r) => (
      <span style={{
        fontWeight: 700, color: '#16695f',
        fontVariantNumeric: 'tabular-nums',
      }}>{r.doc_no}</span>
    ),
    searchValue: (r) => `${r.doc_no} ${r.status ?? ''}`,
    filterValue: (r) => r.doc_no,
    filterType: 'numbering',
  },
  {
    /* Current — which document the flow has reached now (DO / SI / DR), or this
       SO's own number when nothing downstream exists yet. */
    key: 'current_doc_no', label: 'Current', width: 150, sortable: true, groupable: true,
    accessor: (r) => (
      <span style={{ fontWeight: 600, color: '#16695f', whiteSpace: 'nowrap' }}>
        {r.current_doc_no ?? r.doc_no}
      </span>
    ),
    searchValue: (r) => r.current_doc_no ?? r.doc_no ?? '',
    filterValue: (r) => r.current_doc_no ?? r.doc_no ?? '—',
  },
  {
    key: 'so_date', label: 'Date', width: 110, sortable: true,
    accessor: (r) => compactDate(r.so_date),
    searchValue: (r) => `${r.so_date ?? ''} ${compactDate(r.so_date)}`,
    filterValue: (r) => compactDate(r.so_date),
    sortFn: (a, b) => (a.so_date ?? '').localeCompare(b.so_date ?? ''),
    filterType: 'date', dateValue: (r) => r.so_date,
  },
  {
    key: 'debtor_name', label: 'Customer', width: 220, sortable: true, groupable: true,
    accessor: (r) => r.debtor_name,
    searchValue: (r) => r.debtor_name,
  },
  {
    /* Salesperson — the staff member who created the SO. Resolves the
       structured `salesperson_id` to staff.name via the injected lookup.
       Commander 2026-05-28: this replaced the dead free-text `agent` column
       (which returned "—" for every 2990 POS-origin SO). Visible by default.
       Falls back to a dash when no salesperson is stamped. */
    key: 'salesperson_id', label: 'Salesperson', width: 140, sortable: true, groupable: true,
    accessor: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '—' : '—'),
    searchValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '' : ''),
    groupValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '(none)' : '(none)'),
  },
  {
    /* HOUZS Location — warehouse short code (KL / PG / etc). */
    key: 'sales_location', label: 'Location', width: 80, sortable: true, groupable: true,
    accessor: (r) => r.sales_location ?? '—',
    searchValue: (r) => r.sales_location ?? '',
    groupValue: (r) => r.sales_location ?? '(none)',
  },
  {
    /* Reference — the customer's own reference. Commander 2026-05-28:
       customer_so_ref ?? po_doc_no. The SO header's structured customer SO
       ref column is `customer_so_no` (HC10867 etc.) — there is no separate
       `customer_so_ref` column in the 2990 schema, so customer_so_no IS that
       field. Falls back to the customer's PO doc number, then the legacy
       free-text ref, then "—" when all are empty. Sortable + searchable. */
    key: 'customer_so_no', label: 'Reference', width: 130, sortable: true,
    accessor: (r) => r.customer_so_no ?? r.po_doc_no ?? r.ref ?? '—',
    searchValue: (r) => `${r.customer_so_no ?? ''} ${r.po_doc_no ?? ''} ${r.ref ?? ''}`,
    filterValue: (r) => r.customer_so_no ?? r.po_doc_no ?? r.ref ?? '—',
    sortFn: (a, b) =>
      (a.customer_so_no ?? a.po_doc_no ?? a.ref ?? '')
        .localeCompare(b.customer_so_no ?? b.po_doc_no ?? b.ref ?? ''),
  },
  {
    /* Branding — AUTO-DERIVED from the SO's FIRST line item (Commander PR
       #266). See `deriveBranding`: first SOFA → "2990 Sofa", first BEDFRAME →
       "Bedframe", first MATTRESS → its own brand (fallback "2990 Mattress"),
       first accessory/other → "2990", none → "—". Rendered as the muted
       BrandingPill; sortable + groupable on the derived label. */
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
    /* HOUZS Local Total — bold ink. */
    key: 'local_total_centi', label: 'Local Total', width: 120, sortable: true, align: 'right', groupable: false,
    accessor: (r) => (
      <span style={{
        fontWeight: 700, color: 'var(--c-ink)',
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtRm(r.local_total_centi)}</span>
    ),
    searchValue: (r) => fmtRm(r.local_total_centi),
    /* Export the NUMBER in ringgit (not "1,234.00") so Excel can SUM it. */
    exportValue: (r) => (r.local_total_centi ?? 0) / 100,
    sortFn: (a, b) => a.local_total_centi - b.local_total_centi,
    filterType: 'number', numberValue: (r) => r.local_total_centi,
  },
  {
    /* Stock Status column. The label names what is MISSING (owner 2026-08-16):
         · "READY"              — green pill, nothing left to allocate
         · "SHORT: ACCESSORY"   — amber WARNING pill, and it says which category
         · ""                   — no items / empty
       There is no "READY (PARTIAL)" any more: the string it used to appear on
       was an accessory-only order that could NOT ship, so the amber slot now
       belongs to the SHORT labels — same hue, honest word. */
    key: 'stock_status', label: 'Stock Status', width: 220, sortable: true, groupable: false,
    /* The pill, the sort, the search and the export all come from
       components/StockRemarkPill.tsx now. This column was the DESIGN OF RECORD
       — it is unchanged on screen; what moved is that the SO list and the
       delivery-planning board render the same thing instead of two paler
       imitations of it (2026-08-17). */
    accessor: (r) => <StockRemarkPill remark={r.stock_remark} />,
    searchValue: (r) => stockRemarkSearchValue(r.stock_remark),
    exportValue: (r) => stockRemarkExportValue(r.stock_remark),
    sortFn: (a, b) => stockRemarkSortFn(a.stock_remark, b.stock_remark),
  },
  /* HOUZS category subtotals — Mattress/Sofa burnt, Bedframe green, Acc neutral.
     '—' when zero so commander's eye skims to filled cells. */
  {
    key: 'mattress_sofa_centi', label: 'Mattress/Sofa', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => {
      const v = r.mattress_sofa_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{
        fontWeight: 600, color: badgeFor('sofa').fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.mattress_sofa_centi ?? 0),
    exportValue: (r) => (r.mattress_sofa_centi ?? 0) / 100,
    sortFn: (a, b) => (a.mattress_sofa_centi ?? 0) - (b.mattress_sofa_centi ?? 0),
  },
  {
    key: 'bedframe_centi', label: 'Bedframe', width: 120, sortable: true, align: 'right', groupable: false,
    accessor: (r) => {
      const v = r.bedframe_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{
        fontWeight: 600, color: badgeFor('bedframe').fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.bedframe_centi ?? 0),
    exportValue: (r) => (r.bedframe_centi ?? 0) / 100,
    sortFn: (a, b) => (a.bedframe_centi ?? 0) - (b.bedframe_centi ?? 0),
  },
  {
    key: 'accessories_centi', label: 'Accessories', width: 120, sortable: true, align: 'right', groupable: false,
    accessor: (r) => {
      const v = r.accessories_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{
        fontWeight: 600, color: badgeFor('accessory').fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.accessories_centi ?? 0),
    exportValue: (r) => (r.accessories_centi ?? 0) / 100,
    sortFn: (a, b) => (a.accessories_centi ?? 0) - (b.accessories_centi ?? 0),
  },
  {
    key: 'mattress_sofa_cost_centi', label: 'Mattress/Sofa Cost', width: 140, sortable: true, align: 'right', groupable: false,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.mattress_sofa_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.mattress_sofa_cost_centi ?? 0),
    exportValue: (r) => (r.mattress_sofa_cost_centi ?? 0) / 100,
    sortFn: (a, b) => (a.mattress_sofa_cost_centi ?? 0) - (b.mattress_sofa_cost_centi ?? 0),
  },
  {
    key: 'bedframe_cost_centi', label: 'Bedframe Cost', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.bedframe_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.bedframe_cost_centi ?? 0),
    exportValue: (r) => (r.bedframe_cost_centi ?? 0) / 100,
    sortFn: (a, b) => (a.bedframe_cost_centi ?? 0) - (b.bedframe_cost_centi ?? 0),
  },
  {
    key: 'accessories_cost_centi', label: 'Accessories Cost', width: 140, sortable: true, align: 'right', groupable: false,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.accessories_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.accessories_cost_centi ?? 0),
    exportValue: (r) => (r.accessories_cost_centi ?? 0) / 100,
    sortFn: (a, b) => (a.accessories_cost_centi ?? 0) - (b.accessories_cost_centi ?? 0),
  },
  {
    /* Task #91 — display the pretty Malaysian format. searchValue keeps the
       raw stored value so a user can paste either form into Find and match. */
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
    /* HOUZS PO Doc No — the customer's purchase-order number we received
       against this SO. Stored on the SO header as po_doc_no. */
    key: 'po_doc_no', label: 'PO Doc No.', width: 130, sortable: true,
    accessor: (r) => r.po_doc_no ?? '',
    searchValue: (r) => r.po_doc_no ?? '',
  },
  /* ── Default-hidden long-tail (7 columns user reveals via right-click) ── */
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
    /* Task #121 — country snapshot, derived from customer_state via
       my_localities at SO create/PATCH (migration 0082). Always 'Malaysia'
       today; preserved as a separate column so a future MY/SG split surfaces
       without a backfill. */
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
    /* Label, column key and field are now the SAME word. This column used to
       be keyed 'processing_date' (a dead column nothing ever wrote) while
       reading `internal_expected_dd` under the "Processing Date" label — the
       key was kept only to preserve saved column layouts, and the mismatch is
       the whole reason mig 0284 settled the concept on one name. Saved layouts
       still match, because the key never changed. Duplicate "Internal DD"
       column removed, commander 2026-05-28. */
    key: 'processing_date', label: 'Processing Date', width: 130, sortable: true,
    defaultHidden: true,
    accessor: (r) => compactDate(r.processing_date),
    searchValue: (r) => `${r.processing_date ?? ''} ${compactDate(r.processing_date)}`,
    filterType: 'date', dateValue: (r) => r.processing_date,
  },
  {
    key: 'customer_delivery_date', label: 'Delivery Date', width: 130, sortable: true,
    defaultHidden: true,
    accessor: (r) => compactDate(r.customer_delivery_date),
    searchValue: (r) => `${r.customer_delivery_date ?? ''} ${compactDate(r.customer_delivery_date)}`,
    filterType: 'date', dateValue: (r) => r.customer_delivery_date,
  },
  {
    /* #19 (Commander 2026-05-29) — Payment Method summarises the per-receipt
       LEDGER (mfg_sales_order_payments), so an SO settled across several
       methods reads e.g. "Cash + Card" rather than only the header's single
       snapshot. Falls back to the header payment_method field (with merchant
       provider / installment detail) when no receipts are logged yet. */
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
    key: 'others_centi', label: 'Others', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.others_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.others_centi ?? 0),
    exportValue: (r) => (r.others_centi ?? 0) / 100,
    sortFn: (a, b) => (a.others_centi ?? 0) - (b.others_centi ?? 0),
  },
  {
    key: 'others_cost_centi', label: 'Others Cost', width: 120, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.others_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.others_cost_centi ?? 0),
    exportValue: (r) => (r.others_cost_centi ?? 0) / 100,
    sortFn: (a, b) => (a.others_cost_centi ?? 0) - (b.others_cost_centi ?? 0),
  },
  /* Task #114 — Overall cost / margin / margin% on the SO header. */
  {
    key: 'total_cost_centi', label: 'Cost Total', width: 120, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.total_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.total_cost_centi ?? 0),
    exportValue: (r) => (r.total_cost_centi ?? 0) / 100,
    sortFn: (a, b) => (a.total_cost_centi ?? 0) - (b.total_cost_centi ?? 0),
  },
  {
    key: 'total_margin_centi', label: 'Margin', width: 120, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => {
      const m = r.total_margin_centi ?? 0;
      if ((r.local_total_centi ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      const color = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
      return <span className={styles.money} style={{ color, fontWeight: 600 }}>{fmtRm(m)}</span>;
    },
    searchValue: (r) => fmtRm(r.total_margin_centi ?? 0),
    exportValue: (r) => (r.total_margin_centi ?? 0) / 100,
    sortFn: (a, b) => (a.total_margin_centi ?? 0) - (b.total_margin_centi ?? 0),
  },
  {
    key: 'margin_pct_basis', label: 'Margin %', width: 100, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => {
      if ((r.local_total_centi ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
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
    /* Export the percent as a NUMBER (e.g. 42.5) so Excel reads it numerically. */
    exportValue: (r) => Number(((r.margin_pct_basis ?? 0) / 100).toFixed(1)),
    sortFn: (a, b) => (a.margin_pct_basis ?? 0) - (b.margin_pct_basis ?? 0),
  },
  {
    key: 'deposit_centi', label: 'Deposit', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.deposit_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.deposit_centi ?? 0),
    exportValue: (r) => (r.deposit_centi ?? 0) / 100,
    sortFn: (a, b) => (a.deposit_centi ?? 0) - (b.deposit_centi ?? 0),
  },
  {
    key: 'paid_total_centi', label: 'Paid', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.paid_total_centi ?? r.paid_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.paid_total_centi ?? r.paid_centi ?? 0),
    exportValue: (r) => (r.paid_total_centi ?? r.paid_centi ?? 0) / 100,
    sortFn: (a, b) => (a.paid_total_centi ?? a.paid_centi ?? 0) - (b.paid_total_centi ?? b.paid_centi ?? 0),
  },
  {
    /* Follow-up #83 — prefer the view's live balance. */
    key: 'balance_centi', label: 'Balance', width: 110, sortable: true, align: 'right', groupable: false,
    defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(liveBalance(r))}</span>,
    searchValue: (r) => fmtRm(liveBalance(r)),
    exportValue: (r) => liveBalance(r) / 100,
    sortFn: (a, b) => liveBalance(a) - liveBalance(b),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    defaultHidden: true,
    accessor: (r) => <StatusPill status={r.status} deliveryState={r.delivery_state} lifecycleState={r.lifecycle_state} />,
    searchValue: (r) => r.status,
    /* Export the human-facing status label the pill shows (latest-event-wins),
       not the raw enum, so the sheet reads "Delivered" / "Confirmed" etc. */
    exportValue: (r) => {
      const eff = soStatusDisplay(r.status, r.delivery_state, r.lifecycle_state);
      return eff.label ?? STATUS_LABEL[r.status] ?? r.status.replace(/_/g, ' ');
    },
    groupValue: (r) => r.status,
    sortFn: (a, b) => (a.status ?? '').localeCompare(b.status ?? ''),
  },
];

/* Drop the finance columns entirely for a non-finance viewer — they are never
   DECLARED, so the column chooser never lists them (off, not hidden). */
const buildColumns = (
  staffById: Map<string, string>,
  canFinance: boolean,
): DataGridColumn<SoRow>[] =>
  buildAllColumns(staffById).filter((col) => canFinance || !CO_FINANCE_COL_KEYS.has(col.key));
