// ----------------------------------------------------------------------------
// bank-statement-open — how much of each bank statement is still OPEN, for the
// statements list (GET /accounting/bank/statements).
//
// This used to be one unpaged PostgREST read of every statement line the
// company holds, tallied here. PostgREST answers at most `db-max-rows` (1,000,
// lib/paginate-all.ts) per response with no error, so past 1,000 lines the
// "still to decide" count and amount came out too low, silently.
//
// Now: one grouped SQL statement (company-scoped, OPEN only) over Hyperdrive;
// when SQL is unavailable, the same rows read through PostgREST in full pages.
// A read that fails, or stops before the end, is an error — never a 0.
// ----------------------------------------------------------------------------

import { paginateAll, type PageResult } from '../scm/lib/paginate-all';
import { trySql } from '../scm/lib/list-sql';

export type OpenTally = { count: number; sen: number; payouts: number };
export type OpenTallyRead =
  | { ok: true; byStatement: Map<number, OpenTally> }
  | { ok: false; error: { message: string; code?: string } };

/** One statement's OPEN lines, grouped. `sen` arrives as text (a bigint sum). */
export type OpenTallyRow = { statement_id: number | string; count: number | string; sen: number | string | null; payouts: number | string };

type OpenLine = { statement_id: number | string; kind: string | null; amount_sen: number | string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a supabase client or the test fake; the read is built here
type Sb = { from: (table: string) => any };

/** The grouped read, through the repo's SQL door. Null = take the paged fallback. */
export function openTallySql(
  env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string },
  companyId: number,
): Promise<OpenTallyRow[] | null> {
  return trySql(env, 'bank-statement-open', async (sql) => {
    const rows = await sql<OpenTallyRow[]>`
      SELECT statement_id,
             count(*)::int AS count,
             coalesce(sum(amount_sen), 0)::text AS sen,
             (count(*) FILTER (WHERE left(kind, 6) = 'PAYOUT'))::int AS payouts
        FROM scm.acc_bank_statement_lines
       WHERE company_id = ${companyId} AND state = 'OPEN'
       GROUP BY statement_id`;
    return [...rows];
  });
}

function fromGrouped(rows: readonly OpenTallyRow[]): Map<number, OpenTally> {
  const out = new Map<number, OpenTally>();
  for (const r of rows) {
    out.set(Number(r.statement_id), { count: Number(r.count), sen: Number(r.sen ?? 0), payouts: Number(r.payouts) });
  }
  return out;
}

function fromLines(lines: readonly OpenLine[]): Map<number, OpenTally> {
  const out = new Map<number, OpenTally>();
  for (const l of lines) {
    const id = Number(l.statement_id);
    const at = out.get(id) ?? { count: 0, sen: 0, payouts: 0 };
    at.count += 1;
    at.sen += Number(l.amount_sen ?? 0);
    if (String(l.kind).startsWith('PAYOUT')) at.payouts += 1;
    out.set(id, at);
  }
  return out;
}

/**
 * Every statement's OPEN tally for one company. `readSql` is the grouped
 * statement (`() => openTallySql(c.env, companyId)` in the route); null from it
 * means SQL is unavailable and the lines are read through PostgREST in full.
 */
export async function loadOpenTallies(
  sb: Sb,
  companyId: number,
  readSql: () => Promise<OpenTallyRow[] | null>,
): Promise<OpenTallyRead> {
  const grouped = await readSql();
  if (grouped) return { ok: true, byStatement: fromGrouped(grouped) };

  /* Ordered by id: unordered `.range()` pages can repeat and skip rows. */
  const paged = await paginateAll<OpenLine>((lo, hi) => sb.from('acc_bank_statement_lines')
    .select('statement_id, kind, amount_sen')
    .eq('company_id', companyId)
    .eq('state', 'OPEN')
    .order('id', { ascending: true })
    .range(lo, hi) as PromiseLike<PageResult<OpenLine>>);
  if (paged.error || !paged.data) return { ok: false, error: paged.error ?? { message: 'no rows and no error' } };
  if (paged.truncated) return { ok: false, error: { message: 'open statement lines: the paged read stopped before the end' } };
  return { ok: true, byStatement: fromLines(paged.data) };
}
