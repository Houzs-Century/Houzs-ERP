// ----------------------------------------------------------------------------
// SalesOrderDetailListing — Houzs-style "Sales Order Details" line-item view
// at /scm/reports/sales-order-detail-listing.
//
// One row per Sales Order LINE ITEM (with SO header info repeated on every
// line). 2026-05-27 — ported from the AutoCount two-card filter layout to
// match the Houzs reference exactly:
//
//   1. Header — "Sales Order Details · Line-item view · N items · drag to
//      reorder columns" (single-line)
//   2. KPI tiles — Total Lines · Unique Orders · Revenue · [Cost] ·
//      [Margin (RM + %)] · Outstanding (deduped per docNo). 6 for a
//      finance-viewer, 4 otherwise (see the finance gate below).
//   3. Compact horizontal filter row — funnel icon · global search ·
//      All Brands ▼ · All Groups ▼ · All Agents ▼ · All Venues ▼ ·
//      All Payment ▼ · Date from – to
//   4. <DataGrid> (PR-G primitive) with 33 default columns + 10 hidden by
//      default (defaultHidden:true). User reveals via right-click "Show".
//      (Was 34 before the 2026-05-27 col audit; dropped "Actions" since
//      mfg_sales_orders has no action_notes / actions field — the column
//      always rendered '—'. Restore when the schema gains an equivalent.)
//      Storage key: `so-detail-listing-grid.v2.houzs` (bump from v1 so the
//      column reorder + hide layout starts fresh on the new layout).
//
// ── Finance gate (fix/c1-reports) ─────────────────────────────────────────
// Line Cost / Margin RM / Margin % and the Cost + Margin KPI tiles are
// FINANCE-ONLY — `user.project_finance_viewer` (auth/me = isFinanceViewer),
// the same flag #574's list columns and #589's TotalsMarginCard use, and the
// caller-for-caller mirror of the server's canViewScmFinance. This page sits
// behind ScmGuard area="scm.sales.orders" — the area a Sales Executive needs
// to do their job — so without the gate it showed every salesperson's cost and
// margin, company-wide, to any of them. The columns are not DECLARED for a
// non-finance viewer (off, not hidden): no '—' placeholder, no RM 0.00, and
// the column chooser never lists them. The server omits the keys too, so a
// rendered column would have painted cost 0 / margin 100% — a lie, not a blank.
//
// Auto-inquiry on mount — Houzs shows data immediately. We still let the
// user narrow via filters; the query refetches on filter change. PDF
// Preview + Print + criteria-summary code retained from the previous
// AutoCount layout.
//
// ── Temporary placeholders ────────────────────────────────────────────────
// Malaysia is in a no-SST regime, so `tax_sen` is always 0; the Inclusive?
// / Tax (header/line) / Detail Tax Code columns render constants ("Yes" /
// "0.00" / "SR" in AutoCount convention) but live in the default-hidden
// long tail. SO→PO linking isn't tracked yet so Creditor Code / Post to PO
// are also default-hidden.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { canViewScmCosting } from "../../auth/salesAccess";
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer, Plus } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { buildVariantSummary } from '@2990s/shared'; // Commander 2026-05-28
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ItemGroupPill, BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import {
  useSalesOrderDetailListing,
  type SoDetailListingFilters,
  type SoDetailListingRow,
} from '../../vendor/scm/lib/reports-queries';
import { useAuth } from '../../auth/AuthContext';
import styles from './SalesOrderDetailListing.module.css';

/* Bump the storage key when migrating to the Houzs layout — the previous
   key (`so-detail-listing-grid`) held the AutoCount column order, which
   doesn't match the new Houzs columns. v2 starts fresh. */
const STORAGE_KEY = 'so-detail-listing-grid.v2.houzs';

const fmtRm = (centi: number | null | undefined, currency = ''): string => {
  const c = Number(centi ?? 0);
  const prefix = currency ? `${currency} ` : '';
  return `${prefix}${(c / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/* Compact date — "2026/05/04". */
const compactDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}/${m[2]}/${m[3]}`;
};

/* Payment status pill — same warm/green/grey palette as item-group pill,
   tied to a coarse three-state derived from `payment_status` enum. */
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

/* Task #63 — `custom_specials` is a jsonb array with mixed element shape
   across PRs: some lines store plain strings ("Memory Foam Top"), others
   store objects (`{ label, priceSen }` per the latest schema, or the
   older `{ description, surchargeSen }`). Render each element's most
   user-facing string and comma-join. */
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
      /* SO-SKU spec P5 (D8) — show the surcharge next to the name, marked
         "incl." because the amount is ALREADY folded into the line price
         (custom_specials is the price COMPOSITION, not an extra charge).
         Shapes across PRs: { surchargeSen } (older) | { priceSen } (0134) —
         both are sen. */
      const sen = Number(o.surchargeSen ?? o.priceSen ?? 0);
      return sen > 0
        ? `${label} (+RM${(sen / 100).toLocaleString('en-MY', { maximumFractionDigits: 2 })} incl.)`
        : label;
    }
    return '';
  }).filter(Boolean);
  return parts.join(', ');
};

/* SO-SKU spec P5 — heights are number (inches) or a non-numeric pick string. */
const fmtHeight = (v: number | string | null): string => {
  if (v == null || v === '') return '—';
  return typeof v === 'number' ? `${v}"` : String(v);
};
/* Numeric rows sort by value; string picks sink to the end (stable). */
const heightSortValue = (v: number | string | null): number =>
  typeof v === 'number' ? v : v == null ? -Infinity : Infinity;

/* ─────────────────────────────────────────────────────────────────────────
   Column factory — 47 columns for a finance-viewer (33 visible by default +
   14 hidden), 44 otherwise: cols 12-14 (Line Cost · Margin RM · Margin %) are
   only DECLARED when `canFinance`, so a non-finance viewer can't see them and
   the column chooser can't offer them.
   Order mirrors the Houzs reference shot column-for-column. Houzs col 23
   "Actions" dropped in the 2026-05-27 audit (no schema field; always '—').
     1. Doc.No (orange) 2. Date 3. Debtor Name 4. Agent 5. Item Group (pill)
     6. Item Code (bold) 7. Description 8. Location 9. Qty 10. Unit Price
     11. Total [12. Line Cost 13. Margin RM 14. Margin % — finance only]
     15. Balance
     16. Payment (pill) 17. Venue 18. Branding (pill) 19. Fabric
     20. Divan Height 21. Leg Height 22. Specials
     23. Order Remarks 24. Status (pill) 25. Status 2 26. Processing Date
     27. Tax Exemption Expiry 28. Note 29. Paid 30. Last Payment
     31. Account Sheet 32. Approval Code 33. Collected By
   Hidden long tail (14 cols): debtor_code · uom · currency · inclusive? ·
   tax (header/line) · detail tax code · creditor code · post to PO ·
   total ex · plus 2990-extras (customer_delivery_date · processing_date ·
   customer_state · payment_method).
   ───────────────────────────────────────────────────────────────────────── */
const buildColumns = (canFinance: boolean): DataGridColumn<SoDetailListingRow>[] => {
  /* Read-out helper for the "may exist on the row but not on the type"
     fields — the API flattens the SO header onto every line, so anything
     in mfg_sales_orders is reachable via (r as Record<string, unknown>)[k]. */
  const opt = (r: SoDetailListingRow, k: string): string => {
    const v = (r as Record<string, unknown>)[k];
    if (v == null || v === '') return '';
    return String(v);
  };

  return [
    /* 1 */ {
      key: 'doc_no', label: 'Doc. No.', width: 120, sortable: true, groupable: false,
      accessor: (r) => <span className={styles.codeCell}>{r.doc_no}</span>,
      searchValue: (r) => r.doc_no,
      filterType: 'numbering', filterValue: (r) => r.doc_no,
    },
    /* 2 */ {
      key: 'so_date', label: 'Date', width: 110, sortable: true,
      accessor: (r) => compactDate((r.so_date ?? r.line_date) as string | null),
      searchValue: (r) => String(r.so_date ?? r.line_date ?? ''),
      sortFn: (a, b) => String(a.so_date ?? a.line_date ?? '').localeCompare(String(b.so_date ?? b.line_date ?? '')),
      filterType: 'date', dateValue: (r) => (r.so_date ?? r.line_date) as string | null,
    },
    /* 3 */ {
      key: 'debtor_name', label: 'Customer', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.debtor_name ?? '—',
      searchValue: (r) => r.debtor_name ?? '',
    },
    /* 4 */ {
      key: 'agent', label: 'Agent', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.agent ?? '—',
      searchValue: (r) => r.agent ?? '',
      groupValue: (r) => r.agent ?? '(none)',
    },
    /* 5 */ {
      key: 'item_group', label: 'Item Group', width: 110, sortable: true, groupable: true,
      accessor: (r) => <ItemGroupPill group={r.item_group} />,
      searchValue: (r) => r.item_group ?? '',
      groupValue: (r) => r.item_group ?? '(none)',
    },
    /* 6 */ {
      key: 'item_code', label: 'Item Code', width: 120, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{r.item_code}</span>,
      searchValue: (r) => r.item_code ?? '',
    },
    /* 7 */ {
      key: 'description', label: 'Description', width: 220, sortable: true,
      /* Main description only — the variant summary now lives in its own
         "Description 2" column. When there's no manual description, fall back
         to the variant summary so the cell isn't a bare dash. */
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
    /* 7b */ {
      key: 'description2', label: 'Description 2', width: 220, sortable: true,
      /* Commander 2026-05-28 — the HOOKKA-style merged variant summary, now
         its own toggleable column instead of a muted second line beneath the
         description. `variants` rides along on the flattened row
         (Record<string,unknown>) even though it isn't a typed field. */
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
    /* 8 */ {
      key: 'location', label: 'Location', width: 80, sortable: true, groupable: true,
      accessor: (r) => r.location ?? '—',
      searchValue: (r) => r.location ?? '',
    },
    /* 9 */ {
      key: 'qty', label: 'Qty', width: 60, align: 'right', sortable: true,
      accessor: (r) => String(r.qty ?? 0),
      searchValue: (r) => String(r.qty ?? 0),
      sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
    },
    /* 10 */ {
      key: 'unit_price', label: 'Unit Price', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.unit_price_sen),
      searchValue: (r) => fmtRm(r.unit_price_sen),
      sortFn: (a, b) => (a.unit_price_sen ?? 0) - (b.unit_price_sen ?? 0),
    },
    /* 11 */ {
      key: 'total', label: 'Total', width: 120, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{fmtRm(r.total_sen)}</span>,
      searchValue: (r) => fmtRm(r.total_sen),
      sortFn: (a, b) => (a.total_sen ?? 0) - (b.total_sen ?? 0),
      filterType: 'number', numberValue: (r) => r.total_sen ?? 0,
    },
    /* 12-14 — FINANCE ONLY (fix/c1-reports). Declared only for a
       finance-viewer. The server strips line_cost_sen / line_margin_sen
       for everyone else (canViewScmFinance), so rendering these for a
       non-finance viewer would not read blank — it would read cost RM 0.00 and
       margin 100%, a confident lie. Cut, not blanked: off, not hidden. */
    ...(canFinance ? ([
      /* 12 */ {
        key: 'line_cost', label: 'Line Cost', width: 110, align: 'right', sortable: true,
        accessor: (r) => (r.line_cost_sen ?? 0) > 0 ? fmtRm(r.line_cost_sen) : <span style={{ color: 'var(--fg-muted)' }}>—</span>,
        searchValue: (r) => fmtRm(r.line_cost_sen ?? 0),
        sortFn: (a, b) => (a.line_cost_sen ?? 0) - (b.line_cost_sen ?? 0),
      },
      /* 13 */ {
        key: 'line_margin', label: 'Margin RM', width: 110, align: 'right', sortable: true,
        accessor: (r) => {
          const m = r.line_margin_sen ?? 0;
          if ((r.total_sen ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
          const color = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
          return <span style={{ color, fontWeight: 600 }}>{fmtRm(m)}</span>;
        },
        searchValue: (r) => fmtRm(r.line_margin_sen ?? 0),
        sortFn: (a, b) => (a.line_margin_sen ?? 0) - (b.line_margin_sen ?? 0),
      },
      /* 14 */ {
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
    ] as DataGridColumn<SoDetailListingRow>[]) : []),
    /* 15 */ {
      key: 'balance', label: 'Balance', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.balance_sen ?? 0),
      searchValue: (r) => fmtRm(r.balance_sen ?? 0),
      sortFn: (a, b) => (a.balance_sen ?? 0) - (b.balance_sen ?? 0),
    },
    /* 16 */ {
      key: 'payment', label: 'Payment', width: 100, sortable: true, groupable: true,
      accessor: (r) => <PaymentPill raw={opt(r, 'payment_status')} />,
      searchValue: (r) => payStateFor(opt(r, 'payment_status')),
      groupValue: (r) => payStateFor(opt(r, 'payment_status')),
    },
    /* 17 */ {
      key: 'venue', label: 'Venue', width: 160, sortable: true, groupable: true,
      accessor: (r) => opt(r, 'venue') || '—',
      searchValue: (r) => opt(r, 'venue'),
      groupValue: (r) => opt(r, 'venue') || '(none)',
    },
    /* 18 — Commander 2026-05-29: branding hidden by default (reveal via the
       Columns menu when needed); the brand is implicit at order time. */
    {
      key: 'branding', label: 'Branding', width: 110, sortable: true, groupable: true,
      defaultHidden: true,
      accessor: (r) => <BrandingPill branding={r.branding} />,
      searchValue: (r) => r.branding ?? '',
      groupValue: (r) => r.branding ?? '(none)',
    },
    /* 19 — Task #63: typed read from variants->>'fabricColor' (extracted
       server-side as `fabric` on the row). */
    {
      /* Commander 2026-05-28 — unify fabric/colour term → "Fabrics".
         Column key 'fabric' unchanged; only the display label. */
      key: 'fabric', label: 'Fabrics', width: 120, sortable: true,
      accessor: (r) => r.fabric ?? '—',
      searchValue: (r) => r.fabric ?? '',
    },
    /* 20 — SO-SKU spec P5: numbers render as `30"`; non-numeric variant picks
       ('No Leg') pass through as-is. Numeric rows sort first. */
    {
      key: 'divan_height', label: 'Divan Height', width: 110, sortable: true, align: 'right',
      accessor: (r) => fmtHeight(r.divan_height),
      searchValue: (r) => r.divan_height != null ? String(r.divan_height) : '',
      sortFn: (a, b) => heightSortValue(a.divan_height) - heightSortValue(b.divan_height),
    },
    /* 21 — same rendering rule as col 20. */
    {
      key: 'leg_height', label: 'Leg Height', width: 100, sortable: true, align: 'right',
      accessor: (r) => fmtHeight(r.leg_height),
      searchValue: (r) => r.leg_height != null ? String(r.leg_height) : '',
      sortFn: (a, b) => heightSortValue(a.leg_height) - heightSortValue(b.leg_height),
    },
    /* 22 — Task #63: custom_specials is a jsonb array. Element shape
       varies across PRs (some lines store strings, others store
       `{ label } | { description }` objects), so coerce to a label
       string per element and comma-join. */
    {
      key: 'specials', label: 'Specials', width: 160, sortable: true,
      accessor: (r) => formatSpecials(r.custom_specials) || '—',
      searchValue: (r) => formatSpecials(r.custom_specials),
    },
    /* 23 — Actions col DROPPED in audit pass (2026-05-27). Houzs uses this
       for free-text delivery action notes; 2990's schema has no equivalent
       field on mfg_sales_orders / mfg_sales_order_items, so the column
       always rendered '—'. Dead UI surface → removed rather than padded
       with a placeholder. Re-add when an `action_notes` column lands. */
    /* 24 */ {
      key: 'order_remarks', label: 'Order Remarks', width: 160, sortable: true,
      accessor: (r) => opt(r, 'remark') || opt(r, 'note') || '—',
      searchValue: (r) => opt(r, 'remark') || opt(r, 'note'),
    },
    /* 25 */ {
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
        }}>{s.replace(/_/g, ' ')}</span>;
      },
      searchValue: (r) => r.status ?? '',
      groupValue: (r) => r.status ?? '(none)',
    },
    /* 26 — Status 2: secondary lifecycle state (Houzs uses for sub-status
       like "Photo Sent", "Awaiting Driver" etc.). Sourced from the
       header's `remark2` text column (typed on the row). */
    {
      key: 'status_2', label: 'Status 2', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.remark2 ?? '—',
      searchValue: (r) => r.remark2 ?? '',
      groupValue: (r) => r.remark2 ?? '(none)',
    },
    /* 27 */ {
      /* "Processing Date" = processing_date. SO New / Detail / OrderInfoCard
         all read+write this one field, and since mig 0284 the label, the column
         and the API field are the same word. The column key never changed, so
         saved column layouts still match. Duplicate "Internal DD" column
         removed, commander 2026-05-28. */
      key: 'processing_date', label: 'Processing Date', width: 130, sortable: true,
      accessor: (r) => { const v = opt(r, 'processing_date'); return v ? compactDate(v) : '—'; },
      searchValue: (r) => opt(r, 'processing_date'),
      filterType: 'date', dateValue: (r) => opt(r, 'processing_date'),
    },
    /* 28 */ {
      key: 'tax_expiry', label: 'Tax Exemption Expiry', width: 150, sortable: true,
      accessor: (r) => r.sales_exemption_expiry ? compactDate(r.sales_exemption_expiry) : '—',
      searchValue: (r) => r.sales_exemption_expiry ?? '',
      filterType: 'date', dateValue: (r) => r.sales_exemption_expiry,
    },
    /* 29 */ {
      key: 'note', label: 'Note', width: 160, sortable: true,
      accessor: (r) => opt(r, 'note') || opt(r, 'remark3') || '—',
      searchValue: (r) => opt(r, 'note') || opt(r, 'remark3'),
    },
    /* 30 */ {
      key: 'paid', label: 'Paid', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.paid_total_sen ?? 0),
      searchValue: (r) => fmtRm(r.paid_total_sen ?? 0),
      sortFn: (a, b) => (a.paid_total_sen ?? 0) - (b.paid_total_sen ?? 0),
    },
    /* 31 — Task #63: last payment date sourced server-side as MAX(paid_at)
       from mfg_sales_order_payments per SO. */
    {
      key: 'last_payment', label: 'Last Payment', width: 120, sortable: true,
      accessor: (r) => r.last_payment_at ? compactDate(r.last_payment_at) : '—',
      searchValue: (r) => r.last_payment_at ?? '',
      sortFn: (a, b) => String(a.last_payment_at ?? '').localeCompare(String(b.last_payment_at ?? '')),
      filterType: 'date', dateValue: (r) => r.last_payment_at,
    },
    /* 32 — Task #63: most-recent payment's account_sheet (bank account /
       cashbook) from mfg_sales_order_payments. */
    {
      key: 'account_sheet', label: 'Account Sheet', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.account_sheet ?? '—',
      searchValue: (r) => r.account_sheet ?? '',
      groupValue: (r) => r.account_sheet ?? '(none)',
    },
    /* 33 — Task #63: most-recent payment's approval_code (auth / slip /
       receipt no); falls back to legacy header-level approval_code for
       SOs predating the payments ledger. */
    {
      key: 'approval_code', label: 'Approval Code', width: 130, sortable: true,
      accessor: (r) => r.approval_code ?? '—',
      searchValue: (r) => r.approval_code ?? '',
    },
    /* 34 — Task #63: most-recent payment's collected_by, resolved
       server-side from staff.id → staff.name. */
    {
      key: 'collected_by', label: 'Collected By', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.collected_by ?? '—',
      searchValue: (r) => r.collected_by ?? '',
      groupValue: (r) => r.collected_by ?? '(none)',
    },
    /* ── Default-hidden long tail (10 columns) ────────────────────────── */
    {
      key: 'debtor_code', label: 'Debtor Code', width: 110, sortable: true,
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
      /* No-SST regime — constant "Yes" until SST returns. */
      key: 'inclusive', label: 'Inclusive?', width: 80, sortable: false,
      defaultHidden: true,
      accessor: () => 'Yes',
      searchValue: () => 'Yes',
    },
    {
      key: 'tax_header', label: 'Tax (Header)', width: 100, align: 'right', sortable: false,
      defaultHidden: true,
      accessor: () => fmtRm(0),
      searchValue: () => fmtRm(0),
    },
    {
      key: 'tax_line', label: 'Tax (Line)', width: 100, align: 'right', sortable: false,
      defaultHidden: true,
      accessor: () => fmtRm(0),
      searchValue: () => fmtRm(0),
    },
    {
      /* No-SST regime — constant "SR" (Standard Rated 0%). */
      key: 'detail_tax_code', label: 'Detail Tax Code', width: 120, sortable: false,
      defaultHidden: true,
      accessor: () => 'SR',
      searchValue: () => 'SR',
    },
    {
      /* SO→PO linking not tracked yet — render dash. */
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
      accessor: (r) => fmtRm((r.total_sen ?? 0) - (r.tax_sen ?? 0)),
      searchValue: (r) => fmtRm((r.total_sen ?? 0) - (r.tax_sen ?? 0)),
      sortFn: (a, b) =>
        ((a.total_sen ?? 0) - (a.tax_sen ?? 0)) -
        ((b.total_sen ?? 0) - (b.tax_sen ?? 0)),
    },
    /* ── 2990-extra (default-hidden) ─ surfaced fields the report can show
       but Houzs doesn't have. Right-click "Show column" to enable. ─── */
    {
      /* Header field on mfg_sales_orders, flattened onto every line in the
         API (apps/api/src/routes/reports.ts L73). */
      key: 'customer_delivery_date_extra', label: 'Delivery Date', width: 130, sortable: true,
      defaultHidden: true,
      accessor: (r) => r.customer_delivery_date ? compactDate(r.customer_delivery_date) : '—',
      searchValue: (r) => r.customer_delivery_date ?? '',
      filterType: 'date', dateValue: (r) => r.customer_delivery_date,
    },
    {
      /* Customer state — populated whenever the customer record has an
         address with a known MY state (the SO snapshots it on create). */
      key: 'customer_state', label: 'State', width: 120, sortable: true, groupable: true,
      defaultHidden: true,
      accessor: (r) => opt(r, 'customer_state') || '—',
      searchValue: (r) => opt(r, 'customer_state'),
      groupValue: (r) => opt(r, 'customer_state') || '(none)',
    },
  ];
};

/* Page-level Group By is now hosted entirely inside DataGrid (drag-to-group
   banner). The previous AutoCount dropdown is dropped — Houzs has no
   equivalent on this screen.

   Static columns at module scope so DataGrid's React.memo can hit
   (Task #99). The columns hold no per-page state.

   Built ONCE per finance tier rather than per render: the finance flag is the
   only input, so two frozen sets keep the reference stable and the memo hit
   intact (a useMemo(buildColumns) would have been rebuilt on every mount). A
   layout saved while the finance columns were visible is safe — DataGrid drops
   saved order/hidden keys it can't resolve against the current column set. */
const COLUMNS_FINANCE: DataGridColumn<SoDetailListingRow>[] = buildColumns(true);
const COLUMNS_NO_FINANCE: DataGridColumn<SoDetailListingRow>[] = buildColumns(false);

export const SalesOrderDetailListing = () => {
  const navigate = useNavigate();
  /* Finance-viewer gate — the same signal the PMS finance sections and the SO
     list columns (#574) use (auth/me = isFinanceViewer), and the client-side
     mirror of the server's canViewScmFinance. */
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);
  const columns = canFinance ? COLUMNS_FINANCE : COLUMNS_NO_FINANCE;
  /* Task #120 — `?outstanding=1` URL param applied to the row set. The
     line-flat report repeats outstanding per line, so we filter lines from
     docs whose (local_total − paid) > 0. Same param used on the L1 list
     and across all SO-family modules. */
  const [searchParams, setSearchParams] = useSearchParams();
  const outstandingOnly = searchParams.get('outstanding') === '1';
  const clearOutstanding = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('outstanding');
    setSearchParams(next, { replace: true });
  };

  /* ── Server-side query — auto-runs (Houzs shows data immediately).
        Date range filtering is now client-side via the column-aware filter
        bar, so we fetch the full result set with just a stable sort. If the
        line count ever balloons past ~2k we can re-introduce a server-side
        date window. */
  const committed: SoDetailListingFilters = useMemo(() => ({ sortBy: 'date' }), []);
  const query = useSalesOrderDetailListing(committed);
  const rawRows = useMemo<SoDetailListingRow[]>(() => query.data?.rows ?? [], [query.data]);

  /* Apply the outstanding-only overlay before handing rows to the DataGrid.
     The line-flat row format repeats outstanding per line; we drop lines from
     docs whose (local_total − paid) <= 0. */
  const baseRows = useMemo<SoDetailListingRow[]>(() => {
    if (!outstandingOnly) return rawRows;
    return rawRows.filter((r) => (r.local_total_sen ?? 0) - (r.paid_total_sen ?? 0) > 0);
  }, [rawRows, outstandingOnly]);

  /* The outstanding-only overlay (?outstanding=1) narrows the rows; the
     DataGrid's own per-column funnel filters do the rest on top. */
  // DataGrid filters internally now; capture its on-screen rows so the KPI
  // strip reflects the active funnel filters (was the ColumnFilterBar output).
  const [visibleRows, setVisibleRows] = useState<SoDetailListingRow[]>(baseRows);

  /* ── KPI tiles — computed off the filtered row set, NOT rawRows, so
        narrowing the filters re-scopes the headline numbers (matches
        Houzs's interactive feel). Outstanding is deduped per docNo since
        the line-flat row format repeats it per line.

        cost / margin / marginPct are NULL for a non-finance viewer, not 0:
        the server omits line_cost_sen for them, so summing it would total
        zero and paint margin as 100% of revenue. Returning null makes the
        absence explicit — a tile added later can't silently inherit the lie. */
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

  /* ── PDF preview (retained from the AutoCount layout) ──────────────── */
  const [findNonce, setFindNonce] = useState(0);

  const runPrint = () => window.print();

  /* Match the headline format Houzs uses on the title bar — drives the
       "N items · drag to reorder columns" subtitle below. */
  useEffect(() => {
    document.title = `Sales Order Details · ${kpis.totalLines} items`;
    return () => { document.title = '2990s'; };
  }, [kpis.totalLines]);

  return (
    <div>
      {/* ── Header — shared PageHeader (full-bleed, design-system) ─── */}
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
            {/* Task #63 — restore the "New Line Item" CTA stripped from
                the prior Houzs port. Line items only exist inside an SO,
                so this routes to the Create SO page; the user adds lines
                there and they show up here on next load. */}
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

      {/* ── Outstanding-only overlay notice (?outstanding=1) ───────── */}
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

      {/* ── KPI tiles (scoped to current filters). Cost + Margin are omitted
             entirely for a non-finance viewer — no tile, no placeholder — and
             the track narrows from 6 to 4 so the row stays full-width rather
             than leaving two dead slots where the finance tiles used to sit. */}
      <div className={`mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 ${canFinance ? 'lg:grid-cols-6' : 'lg:grid-cols-4'}`}>
        {(
          [
            { label: 'Total Lines',    value: kpis.totalLines.toString() },
            { label: 'Unique Orders',  value: kpis.uniqueOrders.toString() },
            { label: 'Revenue (RM)',   value: fmtRm(kpis.revenue) },
            ...(kpis.cost !== null
              ? [{ label: 'Cost (RM)', value: fmtRm(kpis.cost) }]
              : []),
            ...(kpis.margin !== null
              ? [{
                  label: 'Margin (RM + %)',
                  value: `${fmtRm(kpis.margin)}${kpis.revenue > 0 ? ` (${(kpis.marginPct ?? 0).toFixed(1)}%)` : ''}`,
                  tone: kpis.margin > 0 ? ('success' as const) : kpis.margin < 0 ? ('error' as const) : undefined,
                }]
              : []),
            {
              label: 'Outstanding (RM)',
              value: fmtRm(kpis.outstanding),
              tone: kpis.outstanding > 0 ? ('error' as const) : undefined,
            },
          ] as Array<{ label: string; value: string; tone?: 'success' | 'error' }>
        ).map(({ label, value, tone }) => (
          /* Every tile is a reduce over `visibleRows`, which is EMPTY until the
             listing resolves — so "Revenue (RM) RM 0.00" would be a confident
             statement about a report that has not loaded. Mark them unknown
             until there are rows behind them. */
          <StatCard
            key={label}
            label={label}
            value={value}
            tone={tone}
            pending={query.isLoading || (query.isFetching && rawRows.length === 0) || Boolean(query.error)}
          />
        ))}
      </div>

      {/* ── DataGrid — 33 visible columns + 14 hidden by default ───── */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <DataGrid<SoDetailListingRow>
          rows={baseRows}
          onFilteredRowsChange={setVisibleRows}
          columns={columns}
          storageKey={STORAGE_KEY}
          rowKey={(r) => r.id}
          searchPlaceholder="Search rows…"
          focusSearchNonce={findNonce}
          /* Houzs design — no "drag header here to group" banner above
             the grid; the page already owns the horizontal filter row. */
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

// Re-export the visible column-key list (for tests / debug). This is the
// FINANCE-tier superset — a non-finance viewer gets COLUMNS_NO_FINANCE, which
// omits line_cost / line_margin / margin_pct. Not a permission surface: no
// runtime code reads it.
export const COL_KEYS: string[] = COLUMNS_FINANCE.map((c) => c.key);
