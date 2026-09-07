import { paginateAll } from './paginate-all';
import { BASE_COMPANY_CODE, docPrefixForCode } from './companyScope';
import { isMissingRpc, isUnsupportedTransactionRpc } from './rpc-missing';

/* ────────────────────── Monthly doc numbers ──────────────────────
   `<PREFIX>-YYMM-NNN`. The AUTHORITY is scm.doc_number_counters — see
   mintMonthlyDocNo below. The two pure functions here read the rows that
   happen to exist for the month, and that is now a FLOOR the counter is raised
   to, never the counter itself.

   WHY THAT CHANGED. max(suffix)+1 over surviving rows is a QUERY, not a
   counter: it answers whatever the data currently says. It steps over a
   deleted MID-month row — the original reason it must never be count+1, which
   re-mints a surviving number forever and took down POS order creation on
   2026-06-12 after a cleanup deleted SO-2606-002..007. It does NOT survive a
   deletion at the TOP of a series: removing the highest-numbered document
   lowers the max and hands that number straight back to the next create.

   On 2026-08-20 golive-wipe-hc.mjs did exactly that, deliberately — its header
   said "deleting HC's document rows IS the reset" — and the ERP re-issued
   HC-SO-2608-001/002, HC-PO-2608-001 and HC-PI-2608-001, which the licensed
   AED_HOUZS account book had held since 2026-08-14/17. AutoCount refused them
   with `Primary Key Error` and was right: once a number leaves this system the
   surviving rows here stop being a faithful record of what was issued.
   docs/doc-number-reissue-coe.md.

   Both stay EXPORTED and pure. `maxMonthlySuffix` is the floor the counter is
   raised to. `nextMonthlyDocNo` is the exact PRE-counter answer, kept because
   it is what the tests measure the new behaviour against and because it is the
   degradation path while the RPC is not there yet (see mintMonthlyDocNo). */
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

/* ────────────────── Reading the month (max+1's only input) ──────────────────
   `nextMonthlyDocNo` is exactly as good as the list it is handed, and the
   obvious way to fetch that list is silently wrong:

     await sb.from('sales_invoices').select('invoice_number')
       .like('invoice_number', `${p}SI-${yymm}-%`);        // ← ≤1000 rows, no error

   PostgREST caps a response at 1000 rows and drops the rest WITHOUT an error
   (see lib/paginate-all.ts — `.limit(5000)` does not lift the ceiling either).
   Past the 1000th document in one YYMM the scan comes back truncated, the max
   is stale, and the mint re-issues a number that is already live → 23505.
   Unlike the concurrent-create race below, this does NOT self-heal: every one
   of insertWithDocNoRetry's attempts re-reads the same truncated set and
   re-mints the same dead number, so creation stays 500 for the REST OF THE
   MONTH. Same failure as the 2026-06-12 POS outage above, but deterministic
   rather than a race — it arrives on a schedule, not on a coincidence.

   `.order(col, { ascending: false }).limit(1)` reads fewer rows and is WRONG
   here: the suffix is padStart(3)-padded, so the 1000th document is
   `SI-2607-1000` and a lexical sort ranks `SI-2607-999` above it. That string
   cliff lands on the very same document as the row cap it was meant to dodge,
   so it trades a silent truncation for a silent mis-sort at identical volume.
   (`nextJeNo` at the foot of this file does use that shape and is fine ONLY
   because it pads to 4, moving its break to 10k/mo. It is a deliberate
   difference, not an oversight — do not "unify" it into this family: the pad
   widths differ, so minting a JE through nextMonthlyDocNo would hand out
   `JE-2607-001` and break a live sequence's continuity.)
   Paging the month and taking a NUMERIC max is padding-agnostic: it stays
   correct across 999 → 1000 and any later width change.

   `monthPrefix` feeds BOTH the LIKE and nextMonthlyDocNo, so the two can no
   longer drift apart — the per-company prefix contract in lib/companyScope.ts
   (HOUZS bare `SI-2607-001`, others `2990-SI-2607-001`) now holds by
   construction rather than by remembering to paste the same template twice. */
export async function fetchMonthlyDocNos(
  sb: any,
  table: string,
  col: string,
  monthPrefix: string,
): Promise<string[]> {
  // `.order(col)` is what makes the paging stable: with no sort key PostgREST
  // may hand the same row back in two `.range()` windows and silently drop
  // another. `col` carries the UNIQUE doc-no index, so the order is total.
  const { data } = await paginateAll<Record<string, unknown>>((from, to) =>
    sb.from(table).select(col).like(col, `${monthPrefix}-%`).order(col).range(from, to),
  );
  // Exactly one column is selected, so the row's single string value IS the doc
  // number whichever key the driver named it (trips read `trip_no`/`tripNo`).
  // A fetch error still yields [] — identical to the old `data ?? []`: the
  // insert collides and insertWithDocNoRetry handles it exactly as it does
  // today. The ONLY behaviour change here is that the set is no longer cut off.
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => Object.values(row).find((v) => typeof v === 'string'))
    .filter((v): v is string => typeof v === 'string');
}

/* ─────────────────── THE COUNTER — scm.doc_number_counters ───────────────────
   ONE row per SERIES, where a series is the doc number without its `-NNN`
   tail: `HC-SO-2608`, `2990-SI-2608`, `TRIP-2608`, `JE-2608`. That string IS
   the namespace the number lives in — it is what the old `.like(head || '-%')`
   scan matched and what the unique index protects — so keying on it needs no
   parsing, no company id, and no special case for TRIP, which deliberately has
   no company prefix and is therefore ONE sequence shared by both companies
   (lib/companyScope.ts: "Do NOT apply to CROSS-COMPANY shared docs (trips /
   delivery-planning) — those keep one shared sequence"). Two different tables
   sharing a series would SHARE this counter, which is correct: they would be
   minting into the same doc-number namespace.

   `scm.next_doc_no_n(p_series, p_floor)` is one statement —
   INSERT … ON CONFLICT … DO UPDATE … RETURNING — so two concurrent saves
   cannot read the same value: the second waits on the first's row lock and
   sees the incremented counter. The unique doc-no indexes and
   insertWithDocNoRetry below STAY as the safety net; they are cheap and this
   is a money path.

   THE FLOOR IS A BELT, AND IT IS DELIBERATE. The RPC hands back
   GREATEST(counter, floor + 1), so the live rows can still push the counter UP
   but can never pull it DOWN. Three things fall out of that, and they are the
   reason the read below was not deleted:

     · A series the seed migration never covered (a table added later, a month
       nobody had rows in) self-seeds from its own live max on first use —
       exactly today's answer — instead of restarting at 001.
     · A row inserted out of band (an import, a repair script) cannot be
       re-issued: the next mint steps over it.
     · The PostgREST 1000-row truncation trap documented above stops being able
       to cause a re-issue at all. A truncated read returns a LOW floor, and a
       low floor is now harmless.

   The one thing the floor cannot know is the numbers that left this system —
   the AED_HOUZS account book holds those and the ERP has no row for them. That
   is what the migration's seed is for, and it is the only part of this that
   had to be hardcoded from evidence. */

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
  /* THE CLIENT HAS NO `.rpc` AT ALL — a THIRD shape of "not available", beside
     isMissingRpc's PostgREST error and isUnsupportedTransactionRpc's throw. It
     is a property of the CLIENT, checked before the call, and is therefore not
     an error being swallowed: nothing has failed yet.

     Unreachable in production. @supabase/supabase-js's SupabaseClient always
     has rpc(), and so does pgTransactionSupabase (it throws for names outside
     its whitelist, which is the second shape above). What DOES reach here is a
     hand-built test stub — 17 suites across payments, journals and the
     AutoCount queue build `{ from() {…} }` objects with no rpc, and none of
     them is a test about numbering. Widening them all to answer a counter RPC
     would have made 66 unrelated tests assert doc numbers they do not care
     about.

     Pinned by tests/docNoCounterFallback.test.ts, which also proves the shape
     NEXT to it: an rpc that EXISTS and FAILS must throw, never fall back. */
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
  /* NOT a silent fallback. The function RETURNS integer and cannot answer NULL
     for a non-null series (it clamps p_floor itself), so an unusable answer
     here means the RPC is not what this caller thinks it is — refusing is the
     only honest response on a money path. */
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
    // Counter unavailable — see claimDocNoSuffix. This is the pre-counter
    // behaviour, stated out loud rather than reached by accident.
    // eslint-disable-next-line no-console
    console.warn(`[doc-no] ${DOC_NO_COUNTER_RPC} unavailable for ${monthPrefix}; minting from the live max (pre-counter behaviour, re-issue exposure is back until the migration applies)`);
    return `${monthPrefix}-${String(floor + 1).padStart(digits, '0')}`;
  }
  return `${monthPrefix}-${String(n).padStart(digits, '0')}`;
}

/* ─────────────────────── Mint + insert with collision retry ─────────────────
   `max+1` self-heals a deleted-gap re-mint, but two concurrent creates in the
   same YYMM still both read the same live max and mint the same suffix — the
   loser hits the UNIQUE doc-no index (Postgres 23505) and, without a retry,
   the whole create hard-fails (500). A `SELECT MAX` on the Supabase pooler can
   also miss a just-committed sibling (read-after-write lag), which surfaces the
   same way. The GRN batch path (scm/routes/grns.ts) already loops on 23505 and
   re-derives the next free suffix; this factors that exact loop out so every
   single-create minter (DO/CN/CS/CRN/DR/SI/PI/TRIP) self-heals identically.

   `mint()` re-reads the live max and returns the next free doc number (the
   existing per-route `nextNum` helper). `attempt(docNo)` runs the insert with
   that number and returns `{ data, error }` (Supabase's shape). On a 23505 the
   loop re-mints from a fresh read and retries, up to `tries` times. Any other
   error (or exhausting the retries) returns the last `{ data, error }` so the
   caller keeps its existing error handling. */
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

/* ──────────────────────── Journal-entry numbers (JE) ────────────────────────
   ONE minter for every JE number in the system. It lived in THREE copies —
   routes/accounting.ts, lib/post-si-revenue.ts, routes/payment-vouchers.ts —
   and the copies drifted: only accounting.ts's ever learned the company prefix,
   so a 2990 Sales Invoice's and Payment Voucher's JE minted into HOUZS's
   sequence while a 2990 Purchase Invoice's correctly got `2990-JE-…`.
   payment-vouchers.ts said so in writing ("copied verbatim from accounting.ts
   nextJeNo") while no longer being verbatim — a copy's comment describes the
   day it was pasted, not today. Same lesson as fetchMonthlyDocNos above: the
   month prefix feeds BOTH the LIKE and the mint, so they cannot drift apart —
   here the whole minter is the shared thing, for the same reason.

   Deliberately NOT folded into the nextMonthlyDocNo family above: 4-pad vs
   3-pad, and a single-row read instead of a paged one. See the note there. */

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
  // HOUZS JEs are historically bare — see above. NOT docPrefixForCode('HOUZS').
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
  /* `.schema('public')` — the companies MASTER is `public.companies`; the SCM
     client is pinned to the `scm` schema. See jePrefixForCompany below, which
     paid five days of an unwritten general ledger for this line. */
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
  /* `.schema('public')` IS THE FIX, and it is not decoration.
   *
   * The SCM client is pinned to the `scm` schema (db/supabase.ts:77) so that the
   * ported route code's `sb.from('x')` resolves to `scm.x` unchanged. The
   * companies MASTER is `public.companies` — there is no `scm.companies`, in any
   * migration. So the bare `.from('companies')` this line used to carry resolved
   * to a table that does not exist, the read errored, and the fail-closed throw
   * below fired on EVERY call, for every company.
   *
   * It is the only `from('companies')` in the backend; everything else reads the
   * master through raw SQL (middleware/companyContext.ts:120). That is why the
   * mistake was invisible: there was no sibling call to disagree with.
   *
   * Measured cost, on production 2026-08-23: the newest journal entry in EITHER
   * company was dated 15/08. This landed on 18/08. Five days in which no sales
   * invoice, purchase invoice, payment voucher or reversal wrote a single line
   * to the general ledger — each one throwing here, uncaught, so the operator
   * got "Something went wrong" over a document that had already posted. */
  const { data, error } = await sb
    .schema('public')
    .from('companies')
    .select('code')
    .eq('id', companyId)
    .maybeSingle();
  // Fail closed: the whole point of this function is a per-company JE prefix, so
  // a discarded read that fell through to '' would reintroduce the cross-company
  // number collision it exists to prevent. Refuse rather than mint under the
  // wrong prefix.
  if (error) throw new Error(`jePrefixForCompany: could not read company ${companyId}: ${error.message ?? String(error)}`);
  return jePrefixForCode(data?.code);
};

export const nextJeNo = async (sb: any, date: Date, coPrefix = ''): Promise<string> => {
  // Per-company sequence: the prefix in the LIKE pattern isolates each company's
  // running number — "JE-2607-%" never matches "2990-JE-2607-…" and vice-versa —
  // so the two companies' accounting vouchers can't collide or share a sequence.
  const prefix = `${coPrefix}JE-${padMmDd(date)}`;
  const { data } = await sb
    .from('journal_entries')
    .select('je_no')
    .like('je_no', `${prefix}-%`)
    .order('je_no', { ascending: false })
    .limit(1);
  const last = data?.[0]?.je_no ?? null;
  const lastN = last ? parseInt(String(last).split('-').pop() ?? '0', 10) : 0;
  /* SAME counter, SAME series key, DIFFERENT pad. `prefix` is already the
     series (`JE-2608` / `2990-JE-2608`), so a JE takes its number from
     scm.doc_number_counters exactly like every other document type and stops
     handing a number back when the top JE of a month is deleted. Only the
     formatting differs: 4-pad, which is why this was never folded into the
     nextMonthlyDocNo family (see the note there — minting a JE through the
     3-pad path would break a live sequence's continuity).

     The lexical `.order().limit(1)` read above stays exactly as it was and is
     now only the FLOOR. Its documented break at 10,000 JEs/month (a lexical
     sort ranks `JE-2607-9999` above `JE-2607-10000`) can only under-report the
     floor, and an under-reported floor is harmless the moment the counter
     row exists — the counter wins. The migration seeds this series from a
     NUMERIC max for the same reason. */
  const n = await claimDocNoSuffix(sb, prefix, lastN);
  if (n === null) {
    // eslint-disable-next-line no-console
    console.warn(`[doc-no] ${DOC_NO_COUNTER_RPC} unavailable for ${prefix}; minting from the live max (pre-counter behaviour)`);
    return `${prefix}-${String(lastN + 1).padStart(4, '0')}`;
  }
  return `${prefix}-${String(n).padStart(4, '0')}`;
};
