
import { useEffect, useMemo, useState } from 'react';
import { canViewScmCosting } from "../../auth/salesAccess";
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer, Plus } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { buildVariantSummary, fmtDateOrDash, fmtMoneySen, fmtQty, fmtSen } from '@2990s/shared';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { ItemGroupPill, BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import {
  useSalesOrderDetailListing,
  type SoDetailListingFilters,
  type SoDetailListingRow,
} from '../../vendor/scm/lib/reports-queries';
import { useAuth } from '../../auth/AuthContext';
import styles from './SalesOrderDetailListing.module.css';
import { customerRefOf } from '../../lib/customer-ref';
import { soExemptionExpiryOf } from '../../lib/so-exemption-expiry';
import { soListStatusWord } from '../../vendor/scm/lib/so-line-export-columns';

const STORAGE_KEY = 'so-detail-listing-grid.v2.houzs';

const rowMoney = (centi: number | null | undefined, currency: string | null | undefined): string =>
  !currency || currency === 'MYR' ? fmtSen(centi) : fmtMoneySen(centi, currency);

type PayState = 'Checked' | 'Unchecked' | 'Pending';
const PAY_BADGE: Record<PayState, { bg: string; fg: string }> = {
  Checked:   { bg: 'rgba(47, 93, 79, 0.12)',  fg: 'var(--c-secondary-a, #2F5D4F)' },
  Pending:   { bg: 'rgba(199, 127, 62, 0.16)', fg: 'var(--c-festive-a, #C77F3E)' },
  Unchecked: { bg: 'rgba(34, 31, 32, 0.08)',  fg: 'var(--fg-muted)' },
};
const payStateFor = (raw: string | null | undefined): PayState => {
  if (!raw) return 'Unchecked';
  const v = String(raw).toLowerCase();
  if (v === 'checked' || v === 'paid' || v === 'cleared') return 'Checked';
  if (v === 'pending' || v === 'partial') return 'Pending';
  return 'Unchecked';
};
const PaymentPill = ({ raw }: { raw: string | null | undefined }) => {
  const state = payStateFor(raw);
  const spec = PAY_BADGE[state];
  return (
    <span style={{
      display: 'inline-flex', padding: '1px 8px',
      borderRadius: 'var(--radius-pill, 999px)',
      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)', fontWeight: 700,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: spec.bg, color: spec.fg,
    }}>{state}</span>
  );
};

const formatSpecials = (raw: unknown): string => {
  if (!Array.isArray(raw)) return '';
  const parts = raw.map((el) => {
    if (el == null) return '';
    if (typeof el === 'string') return el;
    if (typeof el === 'object') {
      const o = el as Record<string, unknown>;
      const v = o.label ?? o.description ?? o.name ?? o.value;
      const label = typeof v === 'string' ? v : '';
      if (!label) return '';
      const sen = Number(o.surchargeSen ?? o.priceSen ?? 0);
      return sen > 0
        ? `${label} (+RM${(sen / 100).toLocaleString('en-MY', { maximumFractionDigits: 2 })} incl.)`
        : label;
    }
    return '';
  }).filter(Boolean);
  return parts.join(', ');
};

const fmtHeight = (v: number | string | null): string => {
  if (v == null || v === '') return '—';
  return typeof v === 'number' ? `${v}"` : String(v);
};
const heightSortValue = (v: number | string | null): number =>
  typeof v === 'number' ? v : v == null ? -Infinity : Infinity;

const buildColumns = (canFinance: boolean): GridColumn<SoDetailListingRow>[] => {
  const opt = (r: SoDetailListingRow, k: string): string => {
    const v = (r as Record<string, unknown>)[k];
    if (v == null || v === '') return '';
    return String(v);
  };

  return [
 {
      key: 'doc_no', label: 'Doc. No.', width: 120, sortable: true, groupable: false,
      accessor: (r) => <span className={styles.codeCell}>{r.doc_no}</span>,
      searchValue: (r) => r.doc_no,
      filterType: 'numbering', filterValue: (r) => r.doc_no,
    },
 {
      key: 'reference', label: 'Ref No.', width: 150, sortable: true,
      accessor: (r) => customerRefOf(r) || '—',
      searchValue: (r) => customerRefOf(r),
    },
 {
      key: 'so_date', label: 'Date', width: 110, sortable: true,
      accessor: (r) => fmtDateOrDash((r.so_date ?? r.line_date) as string | null),
      searchValue: (r) => String(r.so_date ?? r.line_date ?? ''),
      sortFn: (a, b) => String(a.so_date ?? a.line_date ?? '').localeCompare(String(b.so_date ?? b.line_date ?? '')),
      filterType: 'date', dateValue: (r) => (r.so_date ?? r.line_date) as string | null,
    },
 {
      key: 'debtor_name', label: 'Customer', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.debtor_name ?? '—',
      searchValue: (r) => r.debtor_name ?? '',
    },
 {
      key: 'agent', label: 'Agent', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.agent ?? '—',
      searchValue: (r) => r.agent ?? '',
      groupValue: (r) => r.agent ?? '(none)',
    },
 {
      key: 'item_group', label: 'Item Group', width: 110, sortable: true, groupable: true,
      accessor: (r) => <ItemGroupPill group={r.item_group} />,
      searchValue: (r) => r.item_group ?? '',
      groupValue: (r) => r.item_group ?? '(none)',
    },
 {
      key: 'item_code', label: 'Item Code', width: 120, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{r.item_code}</span>,
      searchValue: (r) => r.item_code ?? '',
    },
 {
      key: 'description', label: 'Description', width: 220, sortable: true,
      accessor: (r) => {
        const manual = (r.description ?? '').trim();
        if (manual) return <div>{manual}</div>;
        const variants = (r as Record<string, unknown>).variants as
          Record<string, unknown> | null | undefined;
        const summary = buildVariantSummary(r.item_group, variants);
        return <div>{summary || '—'}</div>;
      },
      searchValue: (r) => r.description ?? '',
    },
 {
      key: 'description2', label: 'Description 2', width: 220, sortable: true,
      accessor: (r) => {
        const variants = (r as Record<string, unknown>).variants as
          Record<string, unknown> | null | undefined;
        const summary = buildVariantSummary(r.item_group, variants);
        return summary ? <div>{summary}</div> : <span className={styles.muted}>—</span>;
      },
      searchValue: (r) => {
        const variants = (r as Record<string, unknown>).variants as
          Record<string, unknown> | null | undefined;
        return buildVariantSummary(r.item_group, variants);
      },
    },
 {
      key: 'location', label: 'Location', width: 80, sortable: true, groupable: true,
      accessor: (r) => r.location ?? '—',
      searchValue: (r) => r.location ?? '',
    },
 {
      key: 'qty', label: 'Qty', width: 60, align: 'right', sortable: true,
      accessor: (r) => fmtQty(r.qty ?? 0),
      exportValue: (r) => r.qty,
      searchValue: (r) => String(r.qty ?? 0),
      sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
    },
 {
      key: 'unit_price', label: 'Unit Price', width: 110, align: 'right', sortable: true,
      accessor: (r) => rowMoney(r.unit_price_sen, r.currency),
      exportValue: (r) => r.unit_price_sen / 100,
      exportFormat: 'rate',
      searchValue: (r) => rowMoney(r.unit_price_sen, r.currency),
      sortFn: (a, b) => (a.unit_price_sen ?? 0) - (b.unit_price_sen ?? 0),
    },
 {
      key: 'total', label: 'Total', width: 120, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{rowMoney(r.total_sen, r.currency)}</span>,
      exportValue: (r) => r.total_sen / 100,
      exportFormat: 'money',
      searchValue: (r) => rowMoney(r.total_sen, r.currency),
      sortFn: (a, b) => (a.total_sen ?? 0) - (b.total_sen ?? 0),
      filterType: 'number', numberValue: (r) => r.total_sen ?? 0,
    },
    ...(canFinance ? ([
 {
        key: 'line_cost', label: 'Line Cost', width: 110, align: 'right', sortable: true,
        accessor: (r) => (r.line_cost_sen ?? 0) > 0 ? rowMoney(r.line_cost_sen, r.currency) : <span style={{ color: 'var(--fg-muted)' }}>—</span>,
        exportValue: (r) => r.line_cost_sen / 100,
        exportFormat: 'money',
        searchValue: (r) => rowMoney(r.line_cost_sen ?? 0, r.currency),
        sortFn: (a, b) => (a.line_cost_sen ?? 0) - (b.line_cost_sen ?? 0),
      },
 {
        key: 'line_margin', label: 'Margin RM', width: 110, align: 'right', sortable: true,
        accessor: (r) => {
          const m = r.line_margin_sen ?? 0;
          if ((r.total_sen ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
          const color = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
          return <span style={{ color, fontWeight: 600 }}>{rowMoney(m, r.currency)}</span>;
        },
        exportValue: (r) => r.line_margin_sen / 100,
        exportFormat: 'money',
        searchValue: (r) => rowMoney(r.line_margin_sen ?? 0, r.currency),
        sortFn: (a, b) => (a.line_margin_sen ?? 0) - (b.line_margin_sen ?? 0),
      },
 {
        key: 'margin_pct', label: 'Margin %', width: 90, align: 'right', sortable: true,
        accessor: (r) => {
          const rev = r.total_sen ?? 0;
          if (rev <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
          const pct = ((r.line_margin_sen ?? 0) / rev) * 100;
          const color = pct >= 50 ? 'var(--c-secondary-a, #2F5D4F)'
            : pct >= 30 ? 'var(--c-festive-a, #C77F3E)'
            : pct > 0   ? 'var(--c-burnt)'
            : 'var(--c-festive-b, #B8331F)';
          return <span style={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(1)}%</span>;
        },
        searchValue: (r) => {
          const rev = r.total_sen ?? 0;
          if (rev <= 0) return '';
          return `${(((r.line_margin_sen ?? 0) / rev) * 100).toFixed(1)}%`;
        },
        sortFn: (a, b) => {
          const aPct = (a.total_sen ?? 0) > 0 ? (a.line_margin_sen ?? 0) / a.total_sen! : 0;
          const bPct = (b.total_sen ?? 0) > 0 ? (b.line_margin_sen ?? 0) / b.total_sen! : 0;
          return aPct - bPct;
        },
      },
    ] as GridColumn<SoDetailListingRow>[]) : []),
 {
      key: 'balance', label: 'Balance', width: 110, align: 'right', sortable: true,
      accessor: (r) => rowMoney(r.balance_sen ?? 0, r.currency),
      exportValue: (r) => r.balance_sen / 100,
      exportFormat: 'money',
      searchValue: (r) => rowMoney(r.balance_sen ?? 0, r.currency),
      sortFn: (a, b) => (a.balance_sen ?? 0) - (b.balance_sen ?? 0),
    },
 {
      key: 'payment', label: 'Payment', width: 100, sortable: true, groupable: true,
      accessor: (r) => <PaymentPill raw={opt(r, 'payment_status')} />,
      searchValue: (r) => payStateFor(opt(r, 'payment_status')),
      groupValue: (r) => payStateFor(opt(r, 'payment_status')),
    },
 {
      key: 'venue', label: 'Venue', width: 160, sortable: true, groupable: true,
      accessor: (r) => opt(r, 'venue') || '—',
      searchValue: (r) => opt(r, 'venue'),
      groupValue: (r) => opt(r, 'venue') || '(none)',
    },
    {
      key: 'branding', label: 'Branding', width: 110, sortable: true, groupable: true,
      defaultHidden: true,
      accessor: (r) => <BrandingPill branding={r.branding} />,
      searchValue: (r) => r.branding ?? '',
      groupValue: (r) => r.branding ?? '(none)',
    },
    {
      key: 'fabric', label: 'Fabrics', width: 120, sortable: true,
      accessor: (r) => r.fabric ?? '—',
      searchValue: (r) => r.fabric ?? '',
    },
    {
      key: 'divan_height', label: 'Divan Height', width: 110, sortable: true, align: 'right',
      accessor: (r) => fmtHeight(r.divan_height),
      searchValue: (r) => r.divan_height != null ? String(r.divan_height) : '',
      sortFn: (a, b) => heightSortValue(a.divan_height) - heightSortValue(b.divan_height),
    },
    {
      key: 'leg_height', label: 'Leg Height', width: 100, sortable: true, align: 'right',
      accessor: (r) => fmtHeight(r.leg_height),
      searchValue: (r) => r.leg_height != null ? String(r.leg_height) : '',
      sortFn: (a, b) => heightSortValue(a.leg_height) - heightSortValue(b.leg_height),
    },
    {
      key: 'specials', label: 'Specials', width: 160, sortable: true,
      accessor: (r) => formatSpecials(r.custom_specials) || '—',
      searchValue: (r) => formatSpecials(r.custom_specials),
    },
 {
      key: 'order_remarks', label: 'Order Remarks', width: 160, sortable: true,
      accessor: (r) => opt(r, 'remark') || opt(r, 'note') || '—',
      searchValue: (r) => opt(r, 'remark') || opt(r, 'note'),
    },
 {
      key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
      accessor: (r) => {
        const s = r.status ?? '';
        if (!s) return '—';
        const color = s === 'CANCELLED' ? 'var(--c-festive-b, #B8331F)'
          : s === 'DELIVERED' || s === 'CLOSED' ? 'var(--c-secondary-a, #2F5D4F)'
          : 'var(--c-burnt)';
        return <span style={{
          display: 'inline-flex', padding: '1px 8px',
          borderRadius: 'var(--radius-pill, 999px)',
          background: 'rgba(232, 107, 58, 0.10)', color,
          fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
          fontWeight: 700, letterSpacing: '0.06em',
        }}>{soListStatusWord(s, null, null, null)}</span>;
      },
      searchValue: (r) => r.status ?? '',
      groupValue: (r) => r.status ?? '(none)',
    },
    {
      key: 'status_2', label: 'Status 2', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.remark2 ?? '—',
      searchValue: (r) => r.remark2 ?? '',
      groupValue: (r) => r.remark2 ?? '(none)',
    },
 {
      key: 'processing_date', label: 'Processing Date', width: 130, sortable: true,
      accessor: (r) => fmtDateOrDash(opt(r, 'processing_date') || null),
      searchValue: (r) => opt(r, 'processing_date'),
      filterType: 'date', dateValue: (r) => opt(r, 'processing_date'),
    },
 {
      key: 'tax_expiry', label: 'Tax Exemption Expiry', width: 150, sortable: true,
      accessor: (r) => fmtDateOrDash(soExemptionExpiryOf(r)),
      searchValue: (r) => soExemptionExpiryOf(r) ?? '',
      filterType: 'date', dateValue: (r) => soExemptionExpiryOf(r),
    },
 {
      key: 'note', label: 'Note', width: 160, sortable: true,
      accessor: (r) => opt(r, 'note') || opt(r, 'remark3') || '—',
      searchValue: (r) => opt(r, 'note') || opt(r, 'remark3'),
    },
 {
      key: 'paid', label: 'Paid', width: 110, align: 'right', sortable: true,
      accessor: (r) => rowMoney(r.paid_total_sen ?? 0, r.currency),
      exportValue: (r) => r.paid_total_sen / 100,
      exportFormat: 'money',
      searchValue: (r) => rowMoney(r.paid_total_sen ?? 0, r.currency),
      sortFn: (a, b) => (a.paid_total_sen ?? 0) - (b.paid_total_sen ?? 0),
    },
    {
      key: 'last_payment', label: 'Last Payment', width: 120, sortable: true,
      accessor: (r) => fmtDateOrDash(r.last_payment_at),
      searchValue: (r) => r.last_payment_at ?? '',
      sortFn: (a, b) => String(a.last_payment_at ?? '').localeCompare(String(b.last_payment_at ?? '')),
      filterType: 'date', dateValue: (r) => r.last_payment_at,
    },
    {
      key: 'account_sheet', label: 'Account Sheet', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.account_sheet ?? '—',
      searchValue: (r) => r.account_sheet ?? '',
      groupValue: (r) => r.account_sheet ?? '(none)',
    },
    {
      key: 'approval_code', label: 'Approval Code', width: 130, sortable: true,
      accessor: (r) => r.approval_code ?? '—',
      searchValue: (r) => r.approval_code ?? '',
    },
    {
      key: 'collected_by', label: 'Collected By', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.collected_by ?? '—',
      searchValue: (r) => r.collected_by ?? '',
      groupValue: (r) => r.collected_by ?? '(none)',
    },
    {
      key: 'debtor_code', label: 'Customer', width: 110, sortable: true,
      defaultHidden: true,
      accessor: (r) => r.debtor_code ?? '',
      searchValue: (r) => r.debtor_code ?? '',
    },
    {
      key: 'uom', label: 'UOM', width: 70, sortable: true,
      defaultHidden: true,
      accessor: (r) => r.uom ?? '',
      searchValue: (r) => r.uom ?? '',
    },
    {
      key: 'currency', label: 'Curr.', width: 70, sortable: true,
      defaultHidden: true,
      accessor: (r) => r.currency ?? 'MYR',
      searchValue: (r) => r.currency ?? 'MYR',
    },
    {
      key: 'inclusive', label: 'Inclusive?', width: 80, sortable: false,
      defaultHidden: true,
      accessor: () => 'Yes',
      searchValue: () => 'Yes',
    },
    {
      key: 'tax_header', label: 'Tax (Header)', width: 100, align: 'right', sortable: false,
      defaultHidden: true,
      accessor: () => fmtSen(0),
      exportValue: () => 0,
      exportFormat: 'money',
      searchValue: () => fmtSen(0),
    },
    {
      key: 'tax_line', label: 'Tax (Line)', width: 100, align: 'right', sortable: false,
      defaultHidden: true,
      accessor: () => fmtSen(0),
      exportValue: () => 0,
      exportFormat: 'money',
      searchValue: () => fmtSen(0),
    },
    {
      key: 'detail_tax_code', label: 'Detail Tax Code', width: 120, sortable: false,
      defaultHidden: true,
      accessor: () => 'SR',
      searchValue: () => 'SR',
    },
    {
      key: 'creditor_code', label: 'Creditor Code', width: 110, sortable: false,
      defaultHidden: true,
      accessor: () => '—',
      searchValue: () => '',
    },
    {
      key: 'post_to_po', label: 'Post to PO', width: 100, sortable: false,
      defaultHidden: true,
      accessor: () => '—',
      searchValue: () => '',
    },
    {
      key: 'total_ex', label: 'Total (Ex)', width: 110, align: 'right', sortable: true,
      defaultHidden: true,
      accessor: (r) => rowMoney((r.total_sen ?? 0) - (r.tax_sen ?? 0), r.currency),
      exportValue: (r) => (r.total_sen - r.tax_sen) / 100,
      exportFormat: 'money',
      searchValue: (r) => rowMoney((r.total_sen ?? 0) - (r.tax_sen ?? 0), r.currency),
      sortFn: (a, b) =>
        ((a.total_sen ?? 0) - (a.tax_sen ?? 0)) -
        ((b.total_sen ?? 0) - (b.tax_sen ?? 0)),
    },
    {
      key: 'customer_delivery_date_extra', label: 'Delivery Date', width: 130, sortable: true,
      defaultHidden: true,
      accessor: (r) => fmtDateOrDash(r.customer_delivery_date),
      searchValue: (r) => r.customer_delivery_date ?? '',
      filterType: 'date', dateValue: (r) => r.customer_delivery_date,
    },
    {
      key: 'customer_state', label: 'State', width: 120, sortable: true, groupable: true,
      defaultHidden: true,
      accessor: (r) => opt(r, 'customer_state') || '—',
      searchValue: (r) => opt(r, 'customer_state'),
      groupValue: (r) => opt(r, 'customer_state') || '(none)',
    },
  ];
};

const COLUMNS_FINANCE: GridColumn<SoDetailListingRow>[] = buildColumns(true);
const COLUMNS_NO_FINANCE: GridColumn<SoDetailListingRow>[] = buildColumns(false);

export const SalesOrderDetailListing = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);
  const columns = canFinance ? COLUMNS_FINANCE : COLUMNS_NO_FINANCE;
  const [searchParams, setSearchParams] = useSearchParams();
  const outstandingOnly = searchParams.get('outstanding') === '1';
  const clearOutstanding = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('outstanding');
    setSearchParams(next, { replace: true });
  };

  const committed: SoDetailListingFilters = useMemo(() => ({ sortBy: 'date' }), []);
  const query = useSalesOrderDetailListing(committed);
  const rawRows = useMemo<SoDetailListingRow[]>(() => query.data?.rows ?? [], [query.data]);

  const baseRows = useMemo<SoDetailListingRow[]>(() => {
    if (!outstandingOnly) return rawRows;
    return rawRows.filter((r) => (r.local_total_sen ?? 0) - (r.paid_total_sen ?? 0) > 0);
  }, [rawRows, outstandingOnly]);

  const [visibleRows, setVisibleRows] = useState<SoDetailListingRow[]>(baseRows);

  const kpis = useMemo(() => {
    const totalLines = visibleRows.length;
    const uniqueDocs = new Set<string>();
    let revenue = 0;
    let cost = 0;
    const outstandingByDoc = new Map<string, number>();
    for (const r of visibleRows) {
      uniqueDocs.add(r.doc_no);
      revenue += r.total_sen ?? 0;
      if (canFinance) cost += r.line_cost_sen ?? 0;
      if (!outstandingByDoc.has(r.doc_no)) {
        const ltc = r.local_total_sen ?? 0;
        const ptc = r.paid_total_sen ?? 0;
        outstandingByDoc.set(r.doc_no, Math.max(ltc - ptc, 0));
      }
    }
    const outstanding = [...outstandingByDoc.values()].reduce((s, v) => s + v, 0);
    const margin = revenue - cost;
    return {
      totalLines,
      uniqueOrders: uniqueDocs.size,
      revenue,
      outstanding,
      cost:      canFinance ? cost : null,
      margin:    canFinance ? margin : null,
      marginPct: canFinance ? (revenue > 0 ? (margin / revenue) * 100 : 0) : null,
    };
  }, [visibleRows, canFinance]);

  const [findNonce, setFindNonce] = useState(0);

  const runPrint = () => window.print();

  useEffect(() => {
    document.title = `Sales Order Details · ${kpis.totalLines} items`;
    return () => { document.title = '2990s'; };
  }, [kpis.totalLines]);

  return (
    <div>
      <PageHeader back
        eyebrow="Reports"
        title="Sales Order Details"
        description="Line-item view — one row per sales-order line, with the order header repeated on every line."
        secondaryActions={[{ label: 'Back', icon: ArrowLeft, onClick: () => navigate(-1) }]}
        primaryAction={
          <div className="flex items-stretch gap-2">
            <Button variant="secondary" icon={<Printer size={14} />} onClick={runPrint}>
              Print
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={14} />}
              onClick={() => navigate('/scm/sales-orders/new')}
            >
              Add Line Item
            </Button>
          </div>
        }
      />

      {outstandingOnly && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/30 bg-primary-soft px-4 py-2.5 text-[12.5px] text-ink-secondary">
          <span className="font-semibold text-primary">Outstanding only</span>
          <span>Showing lines from orders with a balance still due.</span>
          <button
            type="button"
            onClick={clearOutstanding}
            className="ml-auto text-[12px] font-semibold text-primary hover:underline"
          >
            Clear outstanding filter
          </button>
        </div>
      )}

      <div className={`mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 ${canFinance ? 'lg:grid-cols-6' : 'lg:grid-cols-4'}`}>
        {(
          [
            { label: 'Total Lines',    value: kpis.totalLines.toString() },
            { label: 'Unique Orders',  value: kpis.uniqueOrders.toString() },
            { label: 'Revenue',   value: fmtSen(kpis.revenue) },
            ...(kpis.cost !== null
              ? [{ label: 'Cost', value: fmtSen(kpis.cost) }]
              : []),
            ...(kpis.margin !== null
              ? [{
                  label: 'Margin',
                  value: `${fmtSen(kpis.margin)}${kpis.revenue > 0 ? ` (${(kpis.marginPct ?? 0).toFixed(1)}%)` : ''}`,
                  tone: kpis.margin > 0 ? ('success' as const) : kpis.margin < 0 ? ('error' as const) : undefined,
                }]
              : []),
            {
              label: 'Outstanding',
              value: fmtSen(kpis.outstanding),
              tone: kpis.outstanding > 0 ? ('error' as const) : undefined,
            },
          ] as Array<{ label: string; value: string; tone?: 'success' | 'error' }>
        ).map(({ label, value, tone }) => (
          <StatCard
            key={label}
            label={label}
            value={value}
            tone={tone}
            pending={query.isLoading || (query.isFetching && rawRows.length === 0)}
            failed={Boolean(query.error)}
            onRetry={() => void query.refetch()}
          />
        ))}
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <DataGridCompat<SoDetailListingRow>
          rows={baseRows}
          onFilteredRowsChange={setVisibleRows}
          columns={columns}
          storageKey={STORAGE_KEY}
          rowKey={(r) => r.id}
          searchPlaceholder="Search rows…"
          focusSearchNonce={findNonce}
          groupBanner={false}
          isLoading={query.isFetching && rawRows.length === 0}
          emptyMessage={query.isFetching ? 'Loading…' : 'No rows match the current filters.'}
          onRowDoubleClick={(r) => navigate(`/scm/sales-orders/${r.doc_no}`)}
          contextMenu={(row) => [
            { label: 'Open Sales Order', onClick: () => navigate(`/scm/sales-orders/${row.doc_no}`) },
            { divider: true as const },
            { label: 'Focus search box', onClick: () => setFindNonce((n) => n + 1) },
          ]}
        />
      </section>
    </div>
  );
};

export const COL_KEYS: string[] = COLUMNS_FINANCE.map((c) => c.key);
