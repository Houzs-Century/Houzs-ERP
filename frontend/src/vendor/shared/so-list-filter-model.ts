// The Sales Order list's SECOND-LEVEL filters — one model, four readers.
//
// Owner 2026-09-14: the status list is the FIRST filter; below it the user adds
// rows of [field][operator + value] that combine with AND (Created By is me,
// Salesperson, SO No from..to, Processing / Delivery / Created date with
// presets, Venue, Balance, ...).
//
// This file is the whole contract, and it has two byte-identical homes:
//   backend/src/scm/shared/so-list-filter-model.ts   (the list endpoint's parser)
//   frontend/src/vendor/shared/so-list-filter-model.ts (URL state, phone sheet,
//                                                       desktop filter bar)
// frontend/src/vendor/shared/so-list-filter-model.canonical.test.ts fails the
// moment they differ, so the server can never refuse a row the UI builds, and a
// shared link parses the same on every surface.
//
// WIRE FORMAT: one repeated `f` query param per row, `field:op` or
// `field:op:value`. The value is everything after the second colon, so a name
// containing ":" survives. Ranges are `from~to` with either end optional.
// Money is ringgit text ("2500.50"); the server converts to whole sen.
//
// LINE-LEVEL FIELDS. Warehouse, Item category and Pending amendment are facts
// about an order's LINES or its amendments while the list reads a header view.
// The server answers them with three computed fields
// (migrations-pg 20260914T1600_scm_so_list_line_filter_fields.sql), so they
// filter the page, the totals and the counts like any header column.
// Branding reads the HEADER column; an order whose header says NONE / blank and
// whose list label is derived from its first line is not matched by it.

export const SO_FILTER_PARAM = 'f';
export const SO_FILTER_MAX_ROWS = 12;
const MAX_TEXT = 80;
const MAX_DOC_NO = 40;

export type SoFilterGroup = 'who' | 'where' | 'when' | 'order';
export type SoFilterKind = 'person' | 'warehouse' | 'text' | 'docRange' | 'date' | 'money' | 'choice';
export type SoFilterOp =
  | 'me' | 'is' | 'contains' | 'between' | 'on' | 'before' | 'after' | 'preset'
  | 'eq' | 'gt' | 'lt' | 'positive';
export type SoFilterFieldKey =
  | 'createdBy' | 'salesperson'
  | 'warehouse' | 'branding' | 'venue' | 'state' | 'city' | 'salesLocation'
  | 'processingDate' | 'deliveryDate' | 'createdDate' | 'orderDate' | 'lastChangeDate'
  | 'docNo' | 'name' | 'reference' | 'balance' | 'total' | 'paymentStatus' | 'overdue'
  | 'itemCategory' | 'pendingAmendment'
  | 'customerType' | 'buildingType' | 'contactNo' | 'email' | 'remarks';

export interface SoListFilter {
  field: SoFilterFieldKey;
  op: SoFilterOp;
  value: string;
}

export interface SoFilterChoice {
  value: string;
  label: string;
}

export interface SoFilterFieldDef {
  key: SoFilterFieldKey;
  label: string;
  group: SoFilterGroup;
  kind: SoFilterKind;
  ops: readonly SoFilterOp[];
  choices?: readonly SoFilterChoice[];
  /** One plain sentence shown under the field in the picker. */
  hint?: string;
}

export const SO_FILTER_GROUP_LABELS: Record<SoFilterGroup, string> = {
  who: 'Who',
  where: 'Where',
  when: 'When',
  order: 'Order and money',
};

const DATE_OPS = ['preset', 'between', 'on', 'before', 'after'] as const;

/* The line buckets the list itself uses (the list handler's normCategory). */
const SO_CATEGORY_CHOICES: readonly SoFilterChoice[] = [
  { value: 'sofa', label: 'Sofa' },
  { value: 'bedframe', label: 'Bedframe' },
  { value: 'mattress', label: 'Mattress' },
  { value: 'accessory', label: 'Accessory' },
];

/** An Item category choice as the bucket the server's computed field holds. */
export function soCategoryBucket(choice: string): string | null {
  return SO_CATEGORY_CHOICES.some((c) => c.value === choice) ? choice.toUpperCase() : null;
}
const TEXT_OPS = ['contains', 'is'] as const;
const PERSON_OPS = ['me', 'is'] as const;

export const SO_FILTER_FIELDS: readonly SoFilterFieldDef[] = [
  { key: 'createdBy', label: 'Created by', group: 'who', kind: 'person', ops: PERSON_OPS,
    hint: 'The salesperson the order is recorded under' },
  { key: 'salesperson', label: 'Salesperson', group: 'who', kind: 'person', ops: PERSON_OPS },
  { key: 'warehouse', label: 'Warehouse', group: 'where', kind: 'warehouse', ops: ['is'],
    hint: 'Orders with at least one line from this warehouse' },
  { key: 'branding', label: 'Branding', group: 'where', kind: 'text', ops: TEXT_OPS },
  { key: 'venue', label: 'Venue', group: 'where', kind: 'text', ops: TEXT_OPS },
  { key: 'state', label: 'State', group: 'where', kind: 'text', ops: TEXT_OPS },
  { key: 'city', label: 'City', group: 'where', kind: 'text', ops: TEXT_OPS },
  { key: 'salesLocation', label: 'Sales location', group: 'where', kind: 'text', ops: TEXT_OPS },
  { key: 'processingDate', label: 'Processing date', group: 'when', kind: 'date', ops: DATE_OPS },
  { key: 'deliveryDate', label: 'Delivery date', group: 'when', kind: 'date', ops: DATE_OPS },
  { key: 'createdDate', label: 'Created date', group: 'when', kind: 'date', ops: DATE_OPS,
    hint: 'When the order was entered into the system' },
  { key: 'orderDate', label: 'Order date', group: 'when', kind: 'date', ops: DATE_OPS,
    hint: 'The date printed on the sales order' },
  { key: 'lastChangeDate', label: 'Last change date', group: 'when', kind: 'date', ops: DATE_OPS },
  { key: 'docNo', label: 'Sales order no.', group: 'order', kind: 'docRange', ops: ['between'] },
  { key: 'name', label: 'Name', group: 'order', kind: 'text', ops: TEXT_OPS },
  { key: 'reference', label: 'Reference', group: 'order', kind: 'text', ops: TEXT_OPS },
  { key: 'balance', label: 'Balance', group: 'order', kind: 'money', ops: ['positive', 'eq', 'gt', 'lt', 'between'] },
  { key: 'total', label: 'Total', group: 'order', kind: 'money', ops: ['eq', 'gt', 'lt', 'between'] },
  { key: 'paymentStatus', label: 'Payment status', group: 'order', kind: 'choice', ops: ['is'],
    choices: [
      { value: 'unpaid', label: 'Unpaid' },
      { value: 'deposit', label: 'Deposit only' },
      { value: 'paid', label: 'Fully paid' },
    ] },
  { key: 'overdue', label: 'Overdue', group: 'order', kind: 'choice', ops: ['is'],
    choices: [{ value: 'yes', label: 'Delivery date passed, not delivered' }],
    hint: 'Delivery date (amended date if set) is before today and the order is not shipped, delivered, invoiced, closed or cancelled' },
  { key: 'itemCategory', label: 'Item category', group: 'order', kind: 'choice', ops: ['is'],
    choices: SO_CATEGORY_CHOICES,
    hint: 'Orders with at least one line of this kind' },
  { key: 'pendingAmendment', label: 'Pending amendment', group: 'order', kind: 'choice', ops: ['is'],
    choices: [
      { value: 'yes', label: 'Has a pending amendment' },
      { value: 'no', label: 'No pending amendment' },
    ] },
  { key: 'customerType', label: 'Customer type', group: 'order', kind: 'text', ops: TEXT_OPS },
  { key: 'buildingType', label: 'Building type', group: 'order', kind: 'text', ops: TEXT_OPS },
  { key: 'contactNo', label: 'Contact no.', group: 'order', kind: 'text', ops: ['contains'] },
  { key: 'email', label: 'Email', group: 'order', kind: 'text', ops: TEXT_OPS },
  { key: 'remarks', label: 'Remarks', group: 'order', kind: 'text', ops: ['contains'] },
];

const FIELD_BY_KEY = new Map<string, SoFilterFieldDef>(SO_FILTER_FIELDS.map((f) => [f.key, f]));

export function soFilterField(key: string): SoFilterFieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

export const SO_OP_LABELS: Record<SoFilterOp, string> = {
  me: 'is me',
  is: 'is',
  contains: 'contains',
  between: 'between',
  on: 'on',
  before: 'before',
  after: 'after',
  preset: 'preset',
  eq: '=',
  gt: '>',
  lt: '<',
  positive: 'has balance',
};

export type SoDatePreset =
  | 'yesterday' | 'today' | 'tomorrow'
  | 'last_week' | 'this_week' | 'next_week'
  | 'last_month' | 'this_month' | 'next_month';

export const SO_DATE_PRESETS: readonly { value: SoDatePreset; label: string }[] = [
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_week', label: 'This week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_month', label: 'This month' },
  { value: 'next_month', label: 'Next month' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONEY_RE = /^-?\d{1,9}(\.\d{1,2})?$/;
const DOC_NO_RE = /^[A-Za-z0-9\-/_. ]*$/;
const hasControlChar = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 32);

/** Is `s` a real calendar date written yyyy-mm-dd? */
export function soIsYmd(s: string): boolean {
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function splitRange(value: string): [string, string] | null {
  const i = value.indexOf('~');
  if (i < 0 || value.indexOf('~', i + 1) >= 0) return null;
  return [value.slice(0, i).trim(), value.slice(i + 1).trim()];
}

/** Whole sen from ringgit text, or null when it is not a money amount. */
export function soMoneyToSen(v: string): number | null {
  const t = v.trim();
  if (!MONEY_RE.test(t)) return null;
  const neg = t.startsWith('-');
  const [whole, frac = ''] = (neg ? t.slice(1) : t).split('.');
  const sen = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -sen : sen;
}

function validValue(def: SoFilterFieldDef, op: SoFilterOp, value: string): boolean {
  switch (def.kind) {
    case 'person':
      return op === 'me' ? value === '' : UUID_RE.test(value);
    case 'warehouse':
      return UUID_RE.test(value);
    case 'text': {
      const t = value.trim();
      return t.length > 0 && value.length <= MAX_TEXT && !hasControlChar(value);
    }
    case 'docRange': {
      const r = splitRange(value);
      if (!r) return false;
      const [a, b] = r;
      if (!a && !b) return false;
      return [a, b].every((s) => s.length <= MAX_DOC_NO && DOC_NO_RE.test(s));
    }
    case 'date': {
      if (op === 'preset') return SO_DATE_PRESETS.some((p) => p.value === value);
      if (op === 'between') {
        const r = splitRange(value);
        if (!r) return false;
        const [a, b] = r;
        if (!a && !b) return false;
        if ((a && !soIsYmd(a)) || (b && !soIsYmd(b))) return false;
        return !(a && b && a > b);
      }
      return soIsYmd(value);
    }
    case 'money': {
      if (op === 'positive') return value === '';
      if (op === 'between') {
        const r = splitRange(value);
        if (!r) return false;
        const [a, b] = r;
        if (!a && !b) return false;
        const sa = a ? soMoneyToSen(a) : 0;
        const sb = b ? soMoneyToSen(b) : 0;
        if (sa === null || sb === null) return false;
        return !(a && b && sa > sb);
      }
      return soMoneyToSen(value) !== null;
    }
    case 'choice':
      return (def.choices ?? []).some((c) => c.value === value);
  }
}

/** Parse ONE `f` value. Null when the field, operator or value is not valid. */
export function parseSoListFilter(raw: string): SoListFilter | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const a = raw.indexOf(':');
  if (a <= 0) return null;
  const field = raw.slice(0, a);
  const b = raw.indexOf(':', a + 1);
  const op = (b < 0 ? raw.slice(a + 1) : raw.slice(a + 1, b)) as SoFilterOp;
  const value = b < 0 ? '' : raw.slice(b + 1);
  const def = soFilterField(field);
  if (!def || !def.ops.includes(op)) return null;
  if (!validValue(def, op, value)) return null;
  return { field: def.key, op, value };
}

/** Parse every `f` value, in order. Anything invalid — or past the row cap — is
 *  returned in `invalid` verbatim so the server can refuse it by name. */
export function parseSoListFilters(raw: readonly string[]): { filters: SoListFilter[]; invalid: string[] } {
  const filters: SoListFilter[] = [];
  const invalid: string[] = [];
  for (const r of raw) {
    const f = parseSoListFilter(r);
    if (!f || filters.length >= SO_FILTER_MAX_ROWS) invalid.push(r);
    else filters.push(f);
  }
  return { filters, invalid };
}

export function serializeSoListFilter(f: SoListFilter): string {
  return f.value === '' ? `${f.field}:${f.op}` : `${f.field}:${f.op}:${f.value}`;
}

export function serializeSoListFilters(filters: readonly SoListFilter[]): string[] {
  return filters.map(serializeSoListFilter);
}

/** A new, not-yet-filled row for `field`, on the field's first operator. */
export function soFilterDefaultRow(field: SoFilterFieldKey): SoListFilter {
  const def = soFilterField(field);
  const op = def ? def.ops[0] : 'is';
  return { field, op, value: op === 'preset' ? 'this_week' : '' };
}

/** True when the row would pass the server's validation as it stands. */
export function soFilterIsComplete(f: SoListFilter): boolean {
  return parseSoListFilter(serializeSoListFilter(f)) !== null;
}

/** Today's date in Kuala Lumpur, yyyy-mm-dd. The server runs in UTC; an order
 *  "due today" means today where the business is. */
export function soTodayYmd(now: Date, timeZone = 'Asia/Kuala_Lumpur'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function soAddDays(ymd: string, days: number): string {
  const m = YMD_RE.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

function monthRange(ymd: string, offset: number): { from: string; to: string } {
  const m = YMD_RE.exec(ymd);
  if (!m) return { from: ymd, to: ymd };
  const first = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + offset, 1));
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]) + offset, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** The inclusive date window a preset names, relative to `todayYmd`. Weeks start
 *  on Monday. */
export function soDatePresetRange(preset: SoDatePreset, todayYmd: string): { from: string; to: string } {
  const m = YMD_RE.exec(todayYmd);
  const dow = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : 1;
  const monday = soAddDays(todayYmd, -((dow + 6) % 7));
  const week = (n: number) => ({ from: soAddDays(monday, 7 * n), to: soAddDays(monday, 7 * n + 6) });
  switch (preset) {
    case 'yesterday': { const d = soAddDays(todayYmd, -1); return { from: d, to: d }; }
    case 'today': return { from: todayYmd, to: todayYmd };
    case 'tomorrow': { const d = soAddDays(todayYmd, 1); return { from: d, to: d }; }
    case 'last_week': return week(-1);
    case 'this_week': return week(0);
    case 'next_week': return week(1);
    case 'last_month': return monthRange(todayYmd, -1);
    case 'this_month': return monthRange(todayYmd, 0);
    case 'next_month': return monthRange(todayYmd, 1);
  }
}

/** A date filter as an inclusive window with either end open. */
export function soDateFilterWindow(f: SoListFilter, todayYmd: string): { from: string | null; to: string | null } {
  if (f.op === 'preset') return soDatePresetRange(f.value as SoDatePreset, todayYmd);
  if (f.op === 'on') return { from: f.value, to: f.value };
  if (f.op === 'before') return { from: null, to: soAddDays(f.value, -1) };
  if (f.op === 'after') return { from: soAddDays(f.value, 1), to: null };
  const r = splitRange(f.value) ?? ['', ''];
  return { from: r[0] || null, to: r[1] || null };
}

/** A range value's two ends ('' when open). */
export function soRangeEnds(value: string): [string, string] {
  return splitRange(value) ?? ['', ''];
}

const dmy = (ymd: string) => (soIsYmd(ymd) ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : ymd);
const rm = (v: string) => {
  const sen = soMoneyToSen(v);
  if (sen === null) return v;
  const abs = Math.abs(sen);
  return `${sen < 0 ? '-' : ''}RM ${Math.floor(abs / 100).toLocaleString('en-MY')}.${String(abs % 100).padStart(2, '0')}`;
};

export interface SoFilterLabels {
  staff: (staffId: string) => string;
  warehouse: (warehouseId: string) => string;
}

/** The words a filter row shows for its operator + value. `labels` resolves a
 *  staff or warehouse uuid to a display name. */
export function soFilterSummary(f: SoListFilter, labels: SoFilterLabels): string {
  const def = soFilterField(f.field);
  if (!def || !soFilterIsComplete(f)) return 'Choose…';
  switch (def.kind) {
    case 'person':
      return f.op === 'me' ? 'is me' : `is ${labels.staff(f.value) || 'a staff member'}`;
    case 'warehouse':
      return `is ${labels.warehouse(f.value) || 'a warehouse'}`;
    case 'text':
      return `${SO_OP_LABELS[f.op]} "${f.value.trim()}"`;
    case 'choice':
      return def.choices?.find((c) => c.value === f.value)?.label ?? f.value;
    case 'docRange': {
      const [a, b] = soRangeEnds(f.value);
      return a && b ? `${a} – ${b}` : a ? `from ${a}` : `up to ${b}`;
    }
    case 'date': {
      if (f.op === 'preset') return SO_DATE_PRESETS.find((p) => p.value === f.value)?.label ?? f.value;
      if (f.op !== 'between') return `${SO_OP_LABELS[f.op]} ${dmy(f.value)}`;
      const [a, b] = soRangeEnds(f.value);
      return a && b ? `${dmy(a)} – ${dmy(b)}` : a ? `from ${dmy(a)}` : `up to ${dmy(b)}`;
    }
    case 'money': {
      if (f.op === 'positive') return 'has balance';
      if (f.op !== 'between') return `${SO_OP_LABELS[f.op]} ${rm(f.value)}`;
      const [a, b] = soRangeEnds(f.value);
      return a && b ? `${rm(a)} – ${rm(b)}` : a ? `from ${rm(a)}` : `up to ${rm(b)}`;
    }
  }
}
