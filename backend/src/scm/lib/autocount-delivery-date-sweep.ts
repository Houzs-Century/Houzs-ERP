// ----------------------------------------------------------------------------
// autocount-delivery-date-sweep — close the ONE-DIRECTIONAL half of the sync.
//
// THE PROBLEM IT SOLVES. AutoCount keeps a document's delivery date on the LINE
// (`SODTL.DeliveryDate`, `DODTL.DeliveryDate`). There is no header delivery date
// on SO or DO and no UDF holding one — checked against the live book 2026-09-11.
// The read middleware the ERP pulls through serves a NINE-COLUMN HEADER
// projection (`/DeliveryOrder/getSince`, `src/types.ts` ACDeliveryOrder), so a
// delivery date changed in AutoCount AFTER a document was imported never
// reaches us. Our own edits DO flow the other way — `autocount-outbox.ts` maps
// `line_delivery_date` onto `SODTL.DeliveryDate`. One-directional sync on one
// field is drift by construction.
//
// It was reported as a real defect, not a theoretical one: HC12445
// (`HC-SO-011302` / `HC-DO-011559`) sat at 05/09 in the ERP while the book had
// said 19/09 since some time after the 2026-08-11 import snapshot, and the
// delivery order cut from that sales order inherited the stale date.
// docs/bugs/0810.
//
// WHY A CRON SWEEP AND NOT A WORKFLOW. Reading the book means calling the host
// (`AC_SYNC_URL` / `AC_SYNC_KEY` are WORKER secrets and forbidden in Actions),
// so the only hands-free trigger is the Worker's own cron — the same reasoning
// as `autocount-relink-sweep.ts`. The one-time catch-up for what has ALREADY
// drifted is a workflow over a committed export
// (`scripts/repair-delivery-dates-from-book.mjs`); this keeps it from drifting
// again.
//
// IT SHIPS DARK, TWICE OVER.
//   * `scm.app_config 'scm.autocount_delivery_date_sweep'` is the switch:
//     absent / 'off' -> NO-OP (the seeded, unset state); 'plan' -> read and
//     REPORT; 'apply' -> write. Anything else fails CLOSED to 'off'.
//   * the host route `/delivery-dates` does not exist until AcSyncService is
//     rebuilt and swapped on the office machine (`deploy-on-host.ps1`). Until
//     then the call 404s, which this treats as "not deployed yet" and reports
//     once rather than erroring — so this ships with no effect and no noise.
//
// WHAT IT WILL NOT TOUCH, and each for a stated reason:
//   * a line whose `line_delivery_date_overridden` is true. That flag exists
//     (docs/bugs/0807-do-line-delivery-date-silently-dropped-by-payload-key-mismat.md)
//     to mark a date an operator typed on purpose.
//   * a BLANK ERP date, line or header. A blank is not a CHANGE, so it is not
//     this sweep's business; filling blanks changes what MRP waits for on
//     thousands of orders and is the owner's call, behind the repair script's
//     INCLUDE_BLANKS. A sweep that ran on its own must never widen its own
//     blast radius.
//   * a header carrying `amended_delivery_date` — a deliberate ERP amendment. If
//     that disagrees with the book the fault is the write-back, not the pull,
//     and silently overwriting it would hide a different bug.
//   * a document whose book lines disagree among themselves: no single value can
//     be the header date, so only the LINES move.
// ----------------------------------------------------------------------------
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { callAcRead } from '../../services/autocount-host-read';
import { paginateAll } from './paginate-all';

type Row = Record<string, unknown>;
/* paginate-all keeps PageResult private, so the shape is restated rather than
   widening that module's surface for one caller. */
type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };

/* supabase-js types a dynamic `.select(string)` as a parser error, which then
   poisons the whole builder. Every read here is one flat table with no embed,
   so the honest shape is a row bag — asserted in ONE place rather than at each
   field. Same reason committed-shipments.ts takes `sb: any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const asPage = (q: any): PromiseLike<PageResult<Row>> => q as PromiseLike<PageResult<Row>>;

type Sb = ReturnType<typeof getSupabaseService>;

export const DELIVERY_DATE_SWEEP_KEY = 'scm.autocount_delivery_date_sweep';

export type DeliveryDateSweepMode = 'off' | 'plan' | 'apply';

/** The AED_HOUZS book IS Houzs Century. 2990 carries no AutoCount link at all
 *  (owner: 2990 does not sync) and Hookka is a different book, so both are out
 *  of scope by construction — the predicate is here anyway, because every
 *  AutoCount repair in this repo carries one. */
const BOOK_COMPANY_ID = 1;

/** How far back the window reaches. Filtering on the DELIVERY DATE is both the
 *  bound and the right semantics: a date staff still move belongs to a document
 *  delivering soon or delivered recently. Measured on the 2026-09-11 export —
 *  the book holds 51,041 SO and 48,291 DO dated lines in total, and 120 days
 *  back is 8,522 / 6,075, well inside the host route's 20,000-row ceiling. */
const WINDOW_DAYS = 120;

/** A ceiling per run, so one cron slot cannot spend itself on round trips. Each
 *  write is its own PostgREST call; the next slot continues where this stopped,
 *  and `remaining` says how much is left. */
const MAX_WRITES_PER_RUN = 200;

interface TypeSpec {
  readonly type: 'SO' | 'DO';
  readonly itemTable: string;
  readonly headerTable: string;
  /** The column on the ITEM row that names its parent document. */
  readonly itemParentCol: string;
  /** The column on the HEADER that names the same document. */
  readonly headerKeyCol: string;
  readonly headerDateCols: readonly string[];
  /* LITERAL select strings. supabase-js parses the select at the TYPE level, so
     a template string resolves to ParserError and the whole query loses its
     type. Two literals cost less than one clever one. */
  readonly itemSelect: string;
  readonly headerSelect: string;
}

const SPECS: readonly TypeSpec[] = [
  {
    type: 'SO',
    itemTable: 'mfg_sales_order_items',
    headerTable: 'mfg_sales_orders',
    itemParentCol: 'doc_no',
    headerKeyCol: 'doc_no',
    headerDateCols: ['customer_delivery_date'],
    itemSelect: 'id, doc_no, linked_ac_dtlkey, line_delivery_date, line_delivery_date_overridden',
    headerSelect: 'doc_no, customer_delivery_date, amended_delivery_date',
  },
  {
    type: 'DO',
    itemTable: 'delivery_order_items',
    headerTable: 'delivery_orders',
    itemParentCol: 'delivery_order_id',
    headerKeyCol: 'id',
    /* Two column names for one fact on a delivery order; both follow the book,
       the way the repair script writes them. */
    headerDateCols: ['expected_delivery_at', 'customer_delivery_date'],
    itemSelect: 'id, delivery_order_id, linked_ac_dtlkey, line_delivery_date, line_delivery_date_overridden',
    /* A delivery order has no amendment column; `amended` stays null for DO. */
    headerSelect: 'id, expected_delivery_at, customer_delivery_date',
  },
];

export interface DeliveryDateSweepResult {
  mode: DeliveryDateSweepMode;
  since: string;
  /** True when the host answered but does not serve `/delivery-dates` yet. */
  hostRouteMissing: boolean;
  /** One sentence when the host could not be read at all. */
  hostError: string | null;
  perType: Record<string, { bookRows: number; truncated: boolean; erpLines: number; lineDiffs: number; headerDiffs: number }>;
  linesWritten: number;
  headersWritten: number;
  /** Differences this run did not get to, because of MAX_WRITES_PER_RUN. */
  remaining: number;
}

/**
 * The switch, read fresh on every run. Never throws — a sweep failure must
 * never break the cron slot — and fails CLOSED to 'off' on anything it does not
 * understand, because this ends in a write to documents the floor reads.
 */
export async function readDeliveryDateSweepMode(sb: Sb): Promise<DeliveryDateSweepMode> {
  try {
    const { data, error } = await sb
      .from('app_config')
      .select('value')
      .eq('key', DELIVERY_DATE_SWEEP_KEY)
      .maybeSingle();
    if (error || !data) return 'off';
    const v = String((data as { value: unknown }).value ?? '').trim().toLowerCase();
    return v === 'plan' || v === 'apply' ? v : 'off';
  } catch {
    return 'off';
  }
}

/** `today - WINDOW_DAYS` as YYYY-MM-DD, in UTC. The window only has to be wide
 *  enough to cover what staff still edit; an hour of timezone either way
 *  changes nothing, so this does not pull in the MYT helper. */
export function sweepSince(now: Date, windowDays = WINDOW_DAYS): string {
  const d = new Date(now.getTime() - windowDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** One row of the host's `/delivery-dates` answer. */
export interface BookDeliveryDate {
  DocNo: string;
  DtlKey: number | string;
  DeliveryDate: string | null;
}

interface ErpLine {
  id: string;
  linked_ac_dtlkey: number | string | null;
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean | null;
  parent: string | null;
}

export interface LinePlan { id: string; from: string; to: string; parent: string | null }
export interface HeaderPlan { key: string; from: string; to: string }

/**
 * The whole decision, as a pure function — which is what makes it testable
 * without a database or a host. Given the book's rows and the ERP's lines, say
 * which lines and which headers move.
 *
 * `headerNow` maps a parent key to its current header date plus whether it
 * carries an amendment; a parent absent from that map is left alone.
 */
export function planDeliveryDateSweep(
  bookRows: readonly BookDeliveryDate[],
  erpLines: readonly ErpLine[],
  headerNow: ReadonlyMap<string, { date: string | null; amended: string | null }>,
): { lines: LinePlan[]; headers: HeaderPlan[] } {
  const byKey = new Map<string, string>();
  for (const r of bookRows) {
    if (r.DeliveryDate == null) continue;
    byKey.set(String(r.DtlKey), r.DeliveryDate);
  }

  const lines: LinePlan[] = [];
  /* parent -> the set of book dates its ERP lines map to. One value means the
     header can follow; more than one means the document genuinely has mixed
     dates and only the lines move. */
  const parentDates = new Map<string, Set<string>>();

  for (const l of erpLines) {
    if (l.linked_ac_dtlkey == null) continue;
    const want = byKey.get(String(l.linked_ac_dtlkey));
    if (want == null) continue;                       // outside the window
    if (l.parent != null) {
      const s = parentDates.get(l.parent) ?? new Set<string>();
      s.add(want);
      parentDates.set(l.parent, s);
    }
    if (l.line_delivery_date === want) continue;      // already in step
    if (l.line_delivery_date_overridden === true) continue;
    if (l.line_delivery_date == null) continue;       // a blank is not a change
    lines.push({ id: l.id, from: l.line_delivery_date, to: want, parent: l.parent });
  }

  const headers: HeaderPlan[] = [];
  for (const [parent, dates] of parentDates) {
    if (dates.size !== 1) continue;
    const want = [...dates][0]!;
    const now = headerNow.get(parent);
    if (now == null) continue;
    if (now.amended != null) continue;
    if (now.date == null) continue;                   // a blank is not a change
    if (now.date === want) continue;
    headers.push({ key: parent, from: now.date, to: want });
  }
  return { lines, headers };
}

/** `YYYY-MM-DD` from whatever Postgres handed back (a date column can arrive as
 *  a Date, and `String(d).slice(0,10)` on one gives `NaN`). */
function ymd(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export async function deliveryDateSweep(
  env: Env,
  now: Date = new Date(),
): Promise<DeliveryDateSweepResult> {
  const sb = getSupabaseService(env);
  const since = sweepSince(now);
  const out: DeliveryDateSweepResult = {
    mode: 'off', since, hostRouteMissing: false, hostError: null,
    perType: {}, linesWritten: 0, headersWritten: 0, remaining: 0,
  };
  const mode = await readDeliveryDateSweepMode(sb);
  out.mode = mode;
  if (mode === 'off') return out;

  let budget = MAX_WRITES_PER_RUN;

  for (const spec of SPECS) {
    const res = await callAcRead(env, 'delivery_dates', { Type: spec.type, SinceDeliveryDate: since });
    if (!res.ok) {
      /* 404 = the host is up and running a build that predates this route. That
         is the expected state until deploy-on-host.ps1 runs, so it is reported,
         not raised. */
      if (res.status === 404) out.hostRouteMissing = true;
      else out.hostError = res.error;
      out.perType[spec.type] = { bookRows: 0, truncated: false, erpLines: 0, lineDiffs: 0, headerDiffs: 0 };
      continue;
    }
    const body = (res.body ?? {}) as { rows?: BookDeliveryDate[]; truncated?: boolean };
    const bookRows = Array.isArray(body.rows) ? body.rows : [];

    const { data: lineRows, error: lineErr } = await paginateAll<Row>((from, to) =>
      asPage(sb.from(spec.itemTable)
        .select(spec.itemSelect)
        .eq('company_id', BOOK_COMPANY_ID)
        .not('linked_ac_dtlkey', 'is', null)
        .order('id')
        .range(from, to)));
    if (lineErr) {
      out.hostError = out.hostError ?? `could not read ${spec.itemTable}: ${lineErr.message}`;
      out.perType[spec.type] = { bookRows: bookRows.length, truncated: body.truncated === true, erpLines: 0, lineDiffs: 0, headerDiffs: 0 };
      continue;
    }
    const erpLines: ErpLine[] = (lineRows ?? []).map((r) => ({
      id: String(r.id),
      linked_ac_dtlkey: (r.linked_ac_dtlkey as number | string | null) ?? null,
      line_delivery_date: ymd(r.line_delivery_date),
      line_delivery_date_overridden: (r.line_delivery_date_overridden as boolean | null) ?? null,
      parent: r[spec.itemParentCol] == null ? null : String(r[spec.itemParentCol]),
    }));

    const parents = [...new Set(erpLines.map((l) => l.parent).filter((p): p is string => !!p))];
    const headerNow = new Map<string, { date: string | null; amended: string | null }>();
    if (parents.length > 0) {
      const { data: hdrRows, error: hdrErr } = await paginateAll<Row>((from, to) =>
        asPage(sb.from(spec.headerTable)
          .select(spec.headerSelect)
          .eq('company_id', BOOK_COMPANY_ID)
          .not('linked_ac_docno', 'is', null)
          .order(spec.headerKeyCol)
          .range(from, to)));
      if (!hdrErr) {
        for (const h of hdrRows ?? []) {
          headerNow.set(String(h[spec.headerKeyCol]), {
            date: ymd(h[spec.headerDateCols[0]!]),
            amended: ymd(h.amended_delivery_date),
          });
        }
      }
    }

    const plan = planDeliveryDateSweep(bookRows, erpLines, headerNow);
    out.perType[spec.type] = {
      bookRows: bookRows.length, truncated: body.truncated === true,
      erpLines: erpLines.length, lineDiffs: plan.lines.length, headerDiffs: plan.headers.length,
    };
    if (mode !== 'apply') { out.remaining += plan.lines.length + plan.headers.length; continue; }

    for (const l of plan.lines) {
      if (budget <= 0) { out.remaining += 1; continue; }
      const { error } = await sb.from(spec.itemTable)
        .update({ line_delivery_date: l.to })
        .eq('id', l.id)
        .eq('company_id', BOOK_COMPANY_ID);
      if (!error) { out.linesWritten += 1; budget -= 1; }
    }
    for (const h of plan.headers) {
      if (budget <= 0) { out.remaining += 1; continue; }
      const patch: Record<string, string> = {};
      for (const c of spec.headerDateCols) patch[c] = h.to;
      const { error } = await sb.from(spec.headerTable)
        .update(patch)
        .eq(spec.headerKeyCol, h.key)
        .eq('company_id', BOOK_COMPANY_ID);
      if (!error) { out.headersWritten += 1; budget -= 1; }
    }
  }
  return out;
}
