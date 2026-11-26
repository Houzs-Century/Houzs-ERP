import { paginateAll } from './paginate-all';
import { BASE_COMPANY_CODE, docPrefixForCode } from './companyScope';
import { isMissingRpc, isUnsupportedTransactionRpc } from './rpc-missing';
import { todayMyt } from './my-time';

export function maxMonthlySuffix(monthPrefix: string, existing: string[]): number {
  const head = `${monthPrefix}-`;
  let max = 0;
  for (const docNo of existing) {
    if (!docNo.startsWith(head)) continue;
    const tail = docNo.slice(head.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = parseInt(tail, 10);
    if (n > max) max = n;
  }
  return max;
}

export function nextMonthlyDocNo(monthPrefix: string, existing: string[], digits = 3): string {
  /* `digits` is the SUFFIX WIDTH the owner can set per company (GL redesign
     item 8: 如果到时我要 2990-MPV-2609-0001 呢). Width is display only —
     maxMonthlySuffix parses any length, so widening later renumbers nothing
     and collides with nothing. */
  return `${monthPrefix}-${String(maxMonthlySuffix(monthPrefix, existing) + 1).padStart(digits, '0')}`;
}

export async function fetchMonthlyDocNos(
  sb: any,
  table: string,
  col: string,
  monthPrefix: string,
): Promise<string[]> {
  const { data } = await paginateAll<Record<string, unknown>>((from, to) =>
    sb.from(table).select(col).like(col, `${monthPrefix}-%`).order(col).range(from, to),
  );
  // Exactly one column is selected, so the row's single string value IS the doc
  // number whichever key the driver named it (trips read `trip_no`/`tripNo`).
  // A fetch error still yields [] — identical to the old `data ?? []`: the
  // insert collides and insertWithDocNoRetry handles it exactly as it does
  // today. The ONLY behaviour change here is that the set is no longer cut off.
  // THE NAMED COLUMN FIRST. A driver that returns the whole row instead of the
  // one column asked for (the test fake does; a view could) would otherwise
  // hand back its FIRST string — an id — and the floor would read 0 for a
  // series with numbers on file, minting -001 twice (docs/bugs/0827 found it
  // raising the second credit note of a month). The single-value fallback
  // stays for the drivers that rename the key (trips: trip_no / tripNo).
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => (typeof row[col] === 'string' ? row[col] : Object.values(row).find((v) => typeof v === 'string')))
    .filter((v): v is string => typeof v === 'string');
}


/** The RPC name, in one place: the migration, the transaction-client whitelist
    and this caller must agree, and three string literals do not. */
export const DOC_NO_COUNTER_RPC = 'next_doc_no_n';

/**
 * Claim the next suffix for `series`, never below `floor + 1`. Returns the
 * number to use — the counter has already moved past it when this resolves.
 *
 * Returns NULL when the counter is NOT AVAILABLE, which is a narrower thing
 * than "the call failed": the function is not in the schema yet (between a
 * merge and pg-migrate — deploy.yml runs migrations BEFORE the Worker, so this
 * is a staging/local window rather than a production one), or the client is
 * the atomic-transaction proxy refusing an RPC outside its whitelist. Anything
 * else THROWS. That distinction is the whole safety of the fallback: a
 * fallback taken on a real error would silently mint from the live max against
 * a database that just rejected the atomic path — which is the bug this file
 * exists to remove. isMissingRpc / isUnsupportedTransactionRpc are the shared
 * predicates for exactly this (lib/rpc-missing.ts).
 */
export async function claimDocNoSuffix(
  sb: any,
  series: string,
  floor: number,
): Promise<number | null> {
  const f = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
  if (typeof sb?.rpc !== 'function') return null;
  let data: unknown;
  try {
    const res = await sb.rpc(DOC_NO_COUNTER_RPC, { p_series: series, p_floor: f });
    if (res?.error) {
      if (isMissingRpc(res.error)) return null;
      throw new Error(
        `${DOC_NO_COUNTER_RPC}(${series}, ${f}) failed: ${res.error.message ?? JSON.stringify(res.error)}`,
      );
    }
    data = res?.data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isUnsupportedTransactionRpc(msg)) return null;
    throw e;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const n = typeof row === 'object' && row !== null ? Number((row as Record<string, unknown>)['n']) : Number(row);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${DOC_NO_COUNTER_RPC}(${series}, ${f}) returned no usable number: ${JSON.stringify(data)}`);
  }
  return n;
}

/** The whole mint for a single-create minter. `monthPrefix` is the doc number
    WITHOUT the trailing `-NNN`, e.g. `${companyDocPrefix(c)}SI-${yymm}`, and it
    is BOTH the LIKE pattern for the floor read and the counter's series key —
    so the two cannot drift apart. */
export async function mintMonthlyDocNo(
  sb: any,
  table: string,
  col: string,
  monthPrefix: string,
  digits = 3,
): Promise<string> {
  const floor = maxMonthlySuffix(monthPrefix, await fetchMonthlyDocNos(sb, table, col, monthPrefix));
  const n = await claimDocNoSuffix(sb, monthPrefix, floor);
  if (n === null) {
    // eslint-disable-next-line no-console
    console.warn(`[doc-no] ${DOC_NO_COUNTER_RPC} unavailable for ${monthPrefix}; minting from the live max (pre-counter behaviour, re-issue exposure is back until the migration applies)`);
    return `${monthPrefix}-${String(floor + 1).padStart(digits, '0')}`;
  }
  return `${monthPrefix}-${String(n).padStart(digits, '0')}`;
}

type DocNoInsertResult<T> = { data: T | null; error: { code?: string; message?: string } | null };

export async function insertWithDocNoRetry<T>(
  mint: () => Promise<string>,
  attempt: (docNo: string) => PromiseLike<DocNoInsertResult<T>>,
  tries = 8,
): Promise<DocNoInsertResult<T>> {
  let last: DocNoInsertResult<T> = { data: null, error: null };
  for (let i = 0; i < tries; i += 1) {
    const docNo = await mint();
    last = await attempt(docNo);
    if (!last.error) return last;
    if (last.error.code !== '23505') return last;
  }
  return last;
}


const padMmDd = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${yy}${m}`;
};

/**
 * JE-number prefix keyed on a company CODE — the ONE JE-prefix rule.
 *
 * HOUZS (the base company) mints its JE numbers BARE — `JE-2607-0001`, no
 * prefix — and always has; that is DELIBERATELY unlike its SO/PO doc numbers,
 * which carry `HC-` (docPrefixForCode('HOUZS') === 'HC-'). Every OTHER company
 * keys off the SAME resolver the SO/PO minters use: 2990 → '2990-', and a
 * future third company → '<CODE>-'. Renaming a live series would orphan every
 * reference to an existing JE number, so HOUZS stays bare here on purpose.
 */
export const jePrefixForCode = (code: string | null | undefined): string => {
  if (typeof code !== 'string' || !code) return '';
  const upper = code.trim().toUpperCase();
  if (upper === BASE_COMPANY_CODE) return '';
  return docPrefixForCode(upper);
};

/**
 * JE-number company prefix keyed on the DOCUMENT's company (not the operator's
 * active company — an auto-posted SI/PI/PV or a reversal belongs to the source
 * document's company, whoever is logged in).
 *
 * Resolves the prefix from the company's CODE, never a hardcoded numeric id.
 * The `companies.id` bigint differs across staging/prod (see companyScope.ts),
 * so the old `Number(companyId) === 1 ? '' : '2990-'` mis-fired in any
 * environment where 2990 was not id 2, and would have dropped a future third
 * company into the '2990-' branch. Reads the code from the companies master by
 * id; an unresolved company degrades to the base company's bare '' — the same
 * base-fallback companyDocPrefix uses for an unresolved code.
 */
/**
 * The company CODE for an id, read from the master. Extracted from
 * jePrefixForCompany so the doc-number minters can resolve a code they were
 * never handed instead of GUESSING one — the headless scan job knows the
 * company id and not the code, and companyDocPrefix's missing-code branch
 * degrades to the BASE company, which since 2026-08-07 means a 2990 document
 * minted `HC-…`. A document number cannot be renamed once it exists
 * (companyScope.ts:535), so guessing here is permanent.
 *
 * Fails closed for the same reason jePrefixForCompany does: minting under the
 * wrong prefix is the collision this whole mechanism exists to prevent.
 */
export const companyCodeById = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client; `sb` is `any` throughout this file, no exported client type
  sb: any,
  companyId: number | null | undefined,
): Promise<string | null> => {
  if (companyId == null) return null;
  const { data, error } = await sb
    .schema('public')
    .from('companies')
    .select('code')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new Error(`companyCodeById: could not read company ${companyId}: ${error.message ?? String(error)}`);
  const code = (data as { code?: string | null } | null)?.code;
  return typeof code === 'string' && code.trim() ? code : null;
};

export const jePrefixForCompany = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client; `sb` is `any` throughout this file and acc/engine.ts, no exported client type
  sb: any,
  companyId: number | null | undefined,
): Promise<string> => {
  if (companyId == null) return '';
  const { data, error } = await sb
    .schema('public')
    .from('companies')
    .select('code')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new Error(`jePrefixForCompany: could not read company ${companyId}: ${error.message ?? String(error)}`);
  return jePrefixForCode(data?.code);
};

export const nextJeNo = async (sb: any, date: Date, coPrefix = ''): Promise<string> => {
  const prefix = `${coPrefix}JE-${padMmDd(date)}`;
  const { data } = await sb
    .from('journal_entries')
    .select('je_no')
    .like('je_no', `${prefix}-%`)
    .order('je_no', { ascending: false })
    .limit(1);
  const last = data?.[0]?.je_no ?? null;
  const lastN = last ? parseInt(String(last).split('-').pop() ?? '0', 10) : 0;
  const n = await claimDocNoSuffix(sb, prefix, lastN);
  if (n === null) {
    // eslint-disable-next-line no-console
    console.warn(`[doc-no] ${DOC_NO_COUNTER_RPC} unavailable for ${prefix}; minting from the live max (pre-counter behaviour)`);
    return `${prefix}-${String(lastN + 1).padStart(4, '0')}`;
  }
  return `${prefix}-${String(n).padStart(4, '0')}`;
};

/* ─────────────────────────── The month a series takes ───────────────────────
   A finance document's number carries the month of the DOCUMENT'S OWN DATE —
   the invoice date, the voucher date, the day the money was paid — never the
   day the row happened to be keyed (owner 2026-09-07: 要根据文件日期,而不是文件
   几时 create 的日期; the case in hand was an AP invoice dated 31/03/2026 minted
   2990-API-2609-001 because it was typed in September). Blank or unparseable
   falls back to today IN MALAYSIA — the old `new Date()` read the Worker's UTC
   clock, so a paper keyed before 08:00 on the 1st took the previous month.
   Editing the date after the save does NOT re-mint: the number is an id, not a
   date (his rule: 单据存了后改日期号码不要重发). */
export function docMonthTag(date: string | null | undefined): string {
  const s = String(date ?? '').trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayMyt();
  return `${d.slice(2, 4)}${d.slice(5, 7)}`;
}
