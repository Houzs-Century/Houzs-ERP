// ----------------------------------------------------------------------------
// so-list-column-funnels — the Sales Order list's column funnels, run over
// EVERY order on the server instead of over the loaded page.
//
// Owner 2026-10-17: after Branding moved server-side, every other funnel still
// narrowed only the 100 rows on screen while the footer kept the full count.
// The grid sends each funnel it can push down as ONE `cols` param, a JSON
// object `{ <grid column key>: [<funnel value>, ...] }`; this file turns each
// column into one PostgREST `or=` term the list's `header` ANDs onto the read,
// and lists every value a column takes across the company's orders, so a value
// that is not on the loaded page can still be picked (GET /funnel-values).
//
// A funnel value is the grid's cell key (dataTableRows.filterKeyOf): the cell
// text, with "—" standing for a blank cell. Most columns ARE a header column of
// the list view and are matched exactly. A few cells are derived, and for those
// the term is a SUPERSET (an order the cell could show the value for is
// admitted; the grid's own page funnel trims the rest), the same trade
// so-list-branding-funnel.ts makes:
//   - doc_no         the AutoCount number (base-table linked_ac_docno) or the
//                    ERP number; both are matched.
//   - debtor_code    a book order with no code shows AC_DEBTOR_CODE.
//   - salesperson    the book's agent spelling (AGENT_MAP), the raw agent text,
//                    or the salesperson's / agent uuid's staff name.
//   - venue          the book's venue spelling (VENUE_MAP) or the raw venue.
//   - reference      ref, else customer_so_no.
//   - sales_location the primary line's warehouse label, else sales_location:
//                    any line at a warehouse with that label, or the text.
//
// Columns NOT here stay page-local in the grid: the ones read from other tables
// per page (PO / DO numbers, stock status, shipped progress, payment method and
// approval codes from the payments ledger, sales exemption expiry from the book,
// every line column, custom fields). Finance columns are honoured only for a
// finance viewer (the read refuses to filter on cost for anyone else).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { applySoScope } from './salesScope';
import { quote } from './so-list-branding-funnel';
import { pgrestInList } from './pgrest-in-list';
import { pageWithTruncation } from './outstanding-po-lines';
import { lookupByIds } from './document-line-export';
import { warehouseLabel } from './warehouse-label';
import { soBookHeaderOf } from './so-book-header';
import { SO_FINANCE_KEYS } from './finance-keys';
import { AC_DEBTOR_CODE } from '../../services/autocount-writeback';
import { AGENT_MAP, VENUE_MAP } from '../../services/autocount-master-maps';

/** The blank-cell key the grid uses (dataTableRows.filterKeyOf). */
export const BLANK = '—';

type Spec =
  /** A text header column, matched exactly. Blank = NULL or ''. */
  | { kind: 'text'; col: string }
  /** A date column. Blank = NULL. */
  | { kind: 'date'; col: string }
  /** A number column. Blank = NULL; `zeroIsNull` when the cell shows 0 for NULL. */
  | { kind: 'number'; col: string; zeroIsNull: boolean }
  | { kind: 'doc_no' | 'debtor_code' | 'salesperson' | 'venue' | 'reference' | 'sales_location' };

const money = (col: string): Spec => ({ kind: 'number', col, zeroIsNull: true });

/** Grid column key -> how the server matches it. The frontend mirrors the keys
 *  (pages/scm-v2/so-list-server-funnels.ts SO_COLUMN_FUNNEL_KEYS). */
export const SO_COLUMN_FUNNELS: Record<string, Spec> = {
  doc_no: { kind: 'doc_no' },
  erp_doc_no: { kind: 'text', col: 'doc_no' },
  so_date: { kind: 'date', col: 'so_date' },
  salesperson: { kind: 'salesperson' },
  sales_location: { kind: 'sales_location' },
  reference: { kind: 'reference' },
  status: { kind: 'text', col: 'status' },
  amount: { kind: 'number', col: 'local_total_sen', zeroIsNull: false },
  phone: { kind: 'text', col: 'phone' },
  email: { kind: 'text', col: 'email' },
  debtor_code: { kind: 'debtor_code' },
  address1: { kind: 'text', col: 'address1' },
  address2: { kind: 'text', col: 'address2' },
  city: { kind: 'text', col: 'city' },
  postcode: { kind: 'text', col: 'postcode' },
  customer_state: { kind: 'text', col: 'customer_state' },
  paid: money('paid_total_sen'),
  balance: { kind: 'number', col: 'balance_sen_live', zeroIsNull: false },
  venue: { kind: 'venue' },
  processing_date: { kind: 'date', col: 'processing_date' },
  customer_delivery_date: { kind: 'date', col: 'customer_delivery_date' },
  note: { kind: 'text', col: 'note' },
  customer_type: { kind: 'text', col: 'customer_type' },
  building_type: { kind: 'text', col: 'building_type' },
  customer_country: { kind: 'text', col: 'customer_country' },
  ...Object.fromEntries(SO_FINANCE_KEYS.map((k) => [k, money(k)])),
};

const FINANCE = new Set<string>(SO_FINANCE_KEYS);

export type SoColumnFunnels = Record<string, string[]>;

/** The `cols` param. Unknown keys, a finance column for a non-finance caller,
 *  and the grid's condition tokens (date range / number range, which start with
 *  \u0001 and stay page-local) are dropped. Malformed reads as no filter. */
export function readSoColumnFunnels(raw: string | undefined, canFinance: boolean): SoColumnFunnels | null {
  if (raw === undefined || raw === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: SoColumnFunnels = {};
  for (const [key, vals] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in SO_COLUMN_FUNNELS) || (FINANCE.has(key) && !canFinance) || !Array.isArray(vals)) continue;
    const kept = [...new Set(vals.filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith('\u0001')))];
    if (kept.length > 0) out[key] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* A term that matches no order: doc_no is the key, never NULL. */
const NOTHING = 'doc_no.is.null';
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
/* Case-insensitive equality for a book-spelled value: ilike with the PostgREST
   grammar characters (and `"`) turned into the single-character wildcard, as
   escapeForOr does for the search box — a superset at worst. */
const ilikeExact = (v: string): string => v.trim().replace(/[,(){}"\\]/g, '_');
const inList = (col: string, vals: readonly string[]): string => `${col}.in.(${vals.map(quote).join(',')})`;
const blankText = (col: string): string[] => [`${col}.is.null`, `${col}.in.("")`];

/** Header values whose AutoCount spelling is `v` (bookSpelling / bookSpellingOrOwn). */
function reverseBook(map: Record<string, string>, v: string): string[] {
  return [v, ...Object.entries(map).filter(([, to]) => to === v).map(([from]) => from)];
}

type QueryError = { message: string } | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts)
type Sb = any;

export type ColumnFunnelRead =
  | { ok: true; ors: string[] }
  | { ok: false; status: 500; body: { error: string; reason: string } };

/** One `or=` expression per active funnel; the list ANDs them onto its read. */
export async function resolveSoColumnFunnels(sb: Sb, c: CompanyScopeCtx, funnels: SoColumnFunnels | null): Promise<ColumnFunnelRead> {
  if (!funnels) return { ok: true, ors: [] };
  const ors: string[] = [];
  for (const [key, vals] of Object.entries(funnels)) {
    const spec = SO_COLUMN_FUNNELS[key] as Spec | undefined;
    if (!spec) continue;
    const blank = vals.includes(BLANK);
    const plain = vals.filter((v) => v !== BLANK);
    const terms: string[] = [];
    switch (spec.kind) {
      case 'text':
        if (plain.length) terms.push(inList(spec.col, plain));
        if (blank) terms.push(...blankText(spec.col));
        break;
      case 'date': {
        const dates = plain.filter((v) => DATE_RE.test(v));
        if (dates.length) terms.push(inList(spec.col, dates));
        if (blank) terms.push(`${spec.col}.is.null`);
        break;
      }
      case 'number': {
        const nums = plain.filter((v) => v.trim() !== '' && Number.isFinite(Number(v)));
        if (nums.length) terms.push(`${spec.col}.in.(${nums.map((n) => String(Number(n))).join(',')})`);
        if (blank || (spec.zeroIsNull && nums.some((n) => Number(n) === 0))) terms.push(`${spec.col}.is.null`);
        break;
      }
      case 'doc_no': {
        if (plain.length) {
          const { data, error } = await scopeToCompany(
            sb.from('mfg_sales_orders').select('doc_no').filter('linked_ac_docno', 'in', pgrestInList(plain)).limit(1000), c);
          if (error) return fail(`doc no funnel: ${(error as { message: string }).message}`);
          const erp = ((data ?? []) as Array<{ doc_no: string }>).map((r) => r.doc_no);
          terms.push(inList('doc_no', [...new Set([...plain, ...erp])]));
        }
        break;
      }
      case 'debtor_code':
        if (plain.length) terms.push(inList('debtor_code', plain));
        if (blank || plain.includes(AC_DEBTOR_CODE)) terms.push(...blankText('debtor_code'));
        break;
      case 'venue':
        for (const v of plain) for (const cand of reverseBook(VENUE_MAP, v)) terms.push(`venue.ilike.${ilikeExact(cand)}`);
        if (blank) terms.push(...blankText('venue'));
        break;
      case 'reference':
        if (plain.length) terms.push(inList('ref', plain), inList('customer_so_no', plain));
        if (blank) terms.push(...blankText('ref'));
        break;
      case 'salesperson': {
        const cands = [...new Set(plain.flatMap((v) => reverseBook(AGENT_MAP, v)))];
        for (const cand of cands) terms.push(`agent.ilike.${ilikeExact(cand)}`);
        if (cands.length) {
          /* Staff ids only filter this company's orders, so the lookup by name
             cannot reveal another company's rows. */
          const { data, error } = await sb.from('staff').select('id').filter('name', 'in', pgrestInList(cands));
          if (error) return fail(`salesperson funnel: ${(error as { message: string }).message}`);
          const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
          if (ids.length) terms.push(inList('salesperson_id', ids), inList('agent', ids));
        }
        if (blank) terms.push(...blankText('agent'));
        break;
      }
      case 'sales_location': {
        if (plain.length) {
          terms.push(inList('sales_location', plain));
          const { data, error } = await scopeToCompany(sb.from('warehouses').select('id, code, name'), c);
          if (error) return fail(`sales location funnel: ${(error as { message: string }).message}`);
          const ids = ((data ?? []) as Array<{ id: string; code: string | null; name: string | null }>)
            .filter((w) => { const l = warehouseLabel(w); return l != null && plain.includes(l); })
            .map((w) => w.id);
          if (ids.length) terms.push(`so_line_warehouse_ids.ov.{${ids.join(',')}}`);
        }
        if (blank) terms.push(...blankText('sales_location'));
        break;
      }
    }
    ors.push(terms.length > 0 ? terms.join(',') : NOTHING);
  }
  return { ok: true, ors };
}

function fail(reason: string): ColumnFunnelRead {
  return { ok: false, status: 500, body: { error: 'load_failed', reason } };
}

// ── Value lists ─────────────────────────────────────────────────────────────

const VIEW_COLS = [
  'doc_no', 'so_date', 'status', 'local_total_sen', 'phone', 'email', 'debtor_code', 'agent', 'salesperson_id',
  'venue', 'branding', 'ref', 'customer_so_no', 'sales_location', 'address1', 'address2', 'city', 'postcode',
  'customer_state', 'paid_total_sen', 'paid_sen', 'balance_sen_live', 'balance_sen', 'processing_date',
  'customer_delivery_date', 'note', 'customer_type', 'building_type', 'customer_country', 'currency',
];

type ValueRow = Record<string, string | number | null> & { doc_no: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string => (v == null ? '' : String(v));
const trimmedOrNull = (v: unknown): string | null => str(v).trim() || null;

/** The grid's cell value for one server column (MfgSalesOrdersListV2 getValue). */
function cellOf(key: string, r: ValueRow, ctx: { acDocNo: string | null; staffName: (id: unknown) => string | null }): string {
  const spec = SO_COLUMN_FUNNELS[key]!;
  const orNull = (v: string | number | null | undefined): string | null => (v == null ? null : String(v));
  const book = () => soBookHeaderOf(
    { doc_no: r.doc_no, debtor_code: orNull(r.debtor_code), agent: orNull(r.agent), venue: orNull(r.venue), branding: orNull(r.branding) },
    ctx.acDocNo, ctx.staffName(r.salesperson_id));
  switch (spec.kind) {
    case 'text': case 'date': return str(r[spec.col]);
    case 'number': {
      if (key === 'balance') return str(r.balance_sen_live ?? r.balance_sen);
      if (key === 'paid') return str(r.paid_total_sen ?? r.paid_sen ?? 0);
      return str(spec.zeroIsNull ? (r[spec.col] ?? 0) : r[spec.col]);
    }
    case 'doc_no': return str(book().ac_doc_no);
    case 'debtor_code': return str(book().ac_debtor_code ?? r.debtor_code);
    case 'venue': return str(book().ac_venue ?? r.venue);
    case 'salesperson': {
      const agent = trimmedOrNull(r.agent);
      return str(book().ac_agent ?? (agent && UUID_RE.test(agent) ? ctx.staffName(agent) : agent));
    }
    case 'reference': return trimmedOrNull(r.ref) ?? trimmedOrNull(r.customer_so_no) ?? BLANK;
    case 'sales_location': return str(trimmedOrNull(r.sales_location));
  }
}

export type SoFunnelValues =
  | { error: string }
  | { error: null; values: Record<string, string[]>; truncated: boolean };

/**
 * Every value each server column takes across the caller's orders in the active
 * company (sales scope applied, so a rep is offered only what their own list can
 * show). Sales Location also offers every company warehouse label, the value a
 * line's warehouse gives the cell. Currency rides along (pushed down since
 * 2026-09-16, previously seeded from the loaded page only).
 */
export async function buildSoFunnelValues(sb: Sb, c: CompanyScopeCtx, scopeIds: string[] | null, canFinance: boolean): Promise<SoFunnelValues> {
  const keys = Object.keys(SO_COLUMN_FUNNELS).filter((k) => canFinance || !FINANCE.has(k));
  const cols = [...VIEW_COLS, ...(canFinance ? SO_FINANCE_KEYS : [])].join(', ');
  const [view, base, wh] = await Promise.all([
    pageWithTruncation<ValueRow>((from, to) =>
      scopeToCompany(applySoScope(sb.from('mfg_sales_orders_with_payment_totals').select(cols), scopeIds), c)
        .order('doc_no', { ascending: true }).range(from, to)),
    pageWithTruncation<{ doc_no: string; linked_ac_docno: string | null }>((from, to) =>
      scopeToCompany(applySoScope(sb.from('mfg_sales_orders').select('doc_no, linked_ac_docno'), scopeIds), c)
        .not('linked_ac_docno', 'is', null).order('doc_no', { ascending: true }).range(from, to)),
    scopeToCompany(sb.from('warehouses').select('id, code, name'), c) as PromiseLike<{ data: unknown[] | null; error: QueryError }>,
  ]);
  if (view.error) return { error: `orders: ${view.error.message}` };
  if (base.error) return { error: `book numbers: ${base.error.message}` };
  if (wh.error) return { error: `warehouses: ${wh.error.message}` };
  const rows = view.data ?? [];
  const acDocNo = new Map((base.data ?? []).map((b) => [b.doc_no, trimmedOrNull(b.linked_ac_docno)]));

  const staffIds = rows.flatMap((r) => [r.salesperson_id, r.agent]).map(str).filter((s) => UUID_RE.test(s));
  const staff = await lookupByIds<{ id: string; name: string | null }>(staffIds, (batch, from, to) =>
    sb.from('staff').select('id, name').in('id', batch).order('id', { ascending: true }).range(from, to));
  if (staff.error) return { error: `staff: ${staff.error}` };
  const staffName = (id: unknown): string | null => (typeof id === 'string' ? trimmedOrNull(staff.byId.get(id)?.name) : null);

  const sets = new Map<string, Set<string>>(keys.map((k) => [k, new Set<string>()]));
  const currency = new Set<string>();
  for (const r of rows) {
    const ctx = { acDocNo: acDocNo.get(r.doc_no) ?? null, staffName };
    for (const k of keys) sets.get(k)!.add(cellOf(k, r, ctx));
    currency.add(str(r.currency) || 'MYR');
  }
  for (const w of (wh.data ?? []) as Array<{ code: string | null; name: string | null }>) {
    const l = warehouseLabel(w);
    if (l) sets.get('sales_location')!.add(l);
  }
  const values: Record<string, string[]> = { currency: [...currency].sort() };
  for (const [k, set] of sets) values[k] = [...set].sort();
  return { error: null, values, truncated: view.truncated || base.truncated };
}
