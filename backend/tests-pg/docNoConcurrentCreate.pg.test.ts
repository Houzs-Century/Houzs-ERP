import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  claimDocNoSuffix,
  fetchMonthlyDocNos,
  insertWithDocNoRetry,
  maxMonthlySuffix,
  mintMonthlyDocNo,
  nextMonthlyDocNo,
} from '../src/scm/lib/doc-no';
import {
  applyDocNoCounterMigration,
  assertDisposableTestDatabase,
  postgrestOver,
} from './lib/doc-no-fixture';

/* THIRTY SALESPEOPLE PRESS SAVE AT THE SAME SECOND.
 *
 * The owner's question, in his words, before opening Sales Orders to the whole
 * floor: 「确保检查看 document number 怎么跑 以免 30 个人同时开单的话号码大家撞」.
 * Two things have to be answered, and neither can be answered by reading code:
 * does any pair of them get the SAME number, and does the loser see an error?
 *
 * WHY THIS SUITE EXISTS BESIDE docNoCounter.pg.test.ts. That file races
 * `scm.next_doc_no_n` — the SQL function — and proves the counter itself is
 * atomic. It does not race the CREATE. The create is three steps, not one:
 *
 *     floor  = max(suffix) over the month's live rows   (a PostgREST read)
 *     n      = scm.next_doc_no_n(series, floor)         (the atomic claim)
 *     insert = INSERT … doc_no = series-NNN             (the unique index)
 *
 * The gap between the first and the second is where a concurrent create lives,
 * and only an end-to-end race can say whether it is closed. So every test below
 * calls the SAME functions the route calls — mintMonthlyDocNo and
 * insertWithDocNoRetry out of scm/lib/doc-no.ts, unmodified — over real
 * connections, one connection per "salesperson".
 *
 * THE RED IS IN THIS FILE, and it is measured, not asserted from theory. The
 * counter can be switched off at the transport (postgrestOver's `counter:false`
 * answers PGRST202, which is a REAL production state: the window between a
 * merge and pg-migrate). With it off, minting degrades to max(suffix)+1 — what
 * shipped before 2026-08-21 — and the same thirty-way race is shown to hand the
 * same number to all thirty and refuse twenty-nine of them with 23505. That is
 * the bug the owner is asking about, reproduced on demand, next to the fix.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

/** The owner's number. Not a round figure picked for a test — it is the floor. */
const SALESPEOPLE = 30;

const TABLE = 'mfg_sales_orders';
const COL = 'doc_no';

/** A counting barrier: every caller waits until ALL of them have arrived.
 *  This is what makes "the same millisecond" a fact of the test rather than a
 *  hope about scheduling — with it, all thirty demonstrably hold the identical
 *  floor before any of them claims a number. */
function barrierFor(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

type Outcome = {
  /** The number this caller actually committed, or null if it never committed. */
  docNo: string | null;
  /* Supabase's own error shape, which is what insertWithDocNoRetry hands back —
     `message` is optional there, so it is optional here too rather than being
     narrowed into a type the library cannot satisfy. */
  error: { code?: string; message?: string } | null;
  /** How many times this caller minted. >1 means insertWithDocNoRetry re-minted. */
  mints: number;
  /** Every number this caller tried, in order. */
  tried: string[];
};

type RaceOptions = {
  series: string;
  /** Is migration 0316 reachable? `false` is the pre-counter world. */
  counter: boolean;
  /** Wrap the insert in insertWithDocNoRetry, or fire a bare one? */
  retry: boolean;
  /** Hold every caller until all of them have read the floor. */
  sameMillisecond: boolean;
  n?: number;
};

/** Fire `n` concurrent creates, each on its OWN connection — a pool of one, so
 *  nothing is serialised by connection reuse. Returns what each caller saw. */
async function raceCreates(opts: RaceOptions): Promise<Outcome[]> {
  const n = opts.n ?? SALESPEOPLE;
  const gate = barrierFor(n);
  const pools = Array.from({ length: n }, () => postgres(url, { max: 1, onnotice: () => {} }));
  try {
    return await Promise.all(pools.map(async (pool): Promise<Outcome> => {
      const sb = postgrestOver(pool, { counter: opts.counter });
      const tried: string[] = [];

      const mint = async (): Promise<string> => {
        if (!opts.sameMillisecond) {
          // The production call, untouched.
          const dn = await mintMonthlyDocNo(sb, TABLE, COL, opts.series);
          tried.push(dn);
          return dn;
        }
        /* mintMonthlyDocNo's OWN two steps, split so the barrier lands exactly
           between them. Nothing else differs: the floor read and the claim are
           the same two calls that function makes, in the same order. The split
           is the worst case rather than a different code path — it forces all
           thirty to hold the identical floor, which is what "at the same
           second" means once the read is what precedes the claim. */
        const floor = maxMonthlySuffix(opts.series, await fetchMonthlyDocNos(sb, TABLE, COL, opts.series));
        if (tried.length === 0) await gate();
        const claimed = await claimDocNoSuffix(sb, opts.series, floor);
        const dn = claimed === null
          ? `${opts.series}-${String(floor + 1).padStart(3, '0')}`   // the pre-counter answer
          : `${opts.series}-${String(claimed).padStart(3, '0')}`;
        tried.push(dn);
        return dn;
      };

      const attempt = (dn: string) => sb.from(TABLE).insert({ [COL]: dn, company_id: 1 });

      const res = opts.retry
        ? await insertWithDocNoRetry<unknown[]>(mint, attempt, 8)
        : await attempt(await mint());

      return {
        docNo: res.error ? null : (tried[tried.length - 1] ?? null),
        error: res.error,
        mints: tried.length,
        tried,
      };
    }));
  } finally {
    await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
  }
}

const suffixes = (rows: Array<{ doc_no: string }>): number[] =>
  rows.map((r) => Number(r.doc_no.slice(r.doc_no.lastIndexOf('-') + 1)));

describePg('thirty concurrent Sales Order creates (real postgres)', () => {
  let admin: Sql;

  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    admin = postgres(url, { max: 8, onnotice: () => {} });
    await admin.unsafe(`
      DROP SCHEMA IF EXISTS scm CASCADE;
      CREATE SCHEMA scm;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA scm TO service_role;

      /* The doc-no column is the PRIMARY KEY in production too — that unique
         index IS what turns a duplicate number into a refused write rather than
         two orders wearing one number. The test would be worthless without it. */
      CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, company_id bigint);
    `);
    // Real migration 0316, replayed the way pg-migrate applies it.
    expect(await applyDocNoCounterMigration(admin)).toBeGreaterThan(5);
  });

  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  /* ── THE OWNER'S QUESTION ────────────────────────────────────────────────── */

  test('thirty at once through the real minter: thirty numbers, nobody sees an error', async () => {
    const series = 'HC-SO-2609';
    const out = await raceCreates({ series, counter: true, retry: true, sameMillisecond: false });

    // Nobody saw an error. This is the half of the question about the LOSER.
    expect(out.filter((o) => o.error)).toEqual([]);
    // Nobody got anybody else's number.
    expect(new Set(out.map((o) => o.docNo)).size).toBe(SALESPEOPLE);
    // …and thirty orders exist, numbered 001-030 with no gap and no repeat.
    const rows = await admin<Array<{ doc_no: string }>>`
      SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE ${`${series}-%`} ORDER BY doc_no`;
    expect(rows).toHaveLength(SALESPEOPLE);
    expect(suffixes(rows).sort((a, b) => a - b))
      .toEqual(Array.from({ length: SALESPEOPLE }, (_, i) => i + 1));
  });

  test('thirty holding the IDENTICAL floor still get thirty numbers, with no retry needed', async () => {
    const series = 'HC-SO-2611';
    const out = await raceCreates({ series, counter: true, retry: true, sameMillisecond: true });

    expect(out.filter((o) => o.error)).toEqual([]);
    expect(new Set(out.map((o) => o.docNo)).size).toBe(SALESPEOPLE);
    /* THE POINT OF THIS TEST. All thirty read the same floor — the barrier
       guarantees it — and every one of them still minted exactly ONCE. The
       collision retry never fired, because there was no collision to recover
       from: the counter had already handed out thirty different numbers. The
       retry is the belt; the counter is what actually holds the trousers up. */
    expect(out.map((o) => o.mints)).toEqual(Array.from({ length: SALESPEOPLE }, () => 1));
    const rows = await admin<Array<{ doc_no: string }>>`
      SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE ${`${series}-%`} ORDER BY doc_no`;
    expect(suffixes(rows).sort((a, b) => a - b))
      .toEqual(Array.from({ length: SALESPEOPLE }, (_, i) => i + 1));
  });

  /* ── THE RED: the same race, in the world before the counter ─────────────── */

  test('RED — without the counter, all thirty mint ONE number and twenty-nine are refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const series = 'HC-SO-2612';
      const out = await raceCreates({ series, counter: false, retry: false, sameMillisecond: true });

      // Every caller minted the SAME number — max(suffix)+1 over an empty month.
      expect(new Set(out.map((o) => o.tried[0])).size).toBe(1);
      expect(out[0]!.tried[0]).toBe(`${series}-001`);
      expect(nextMonthlyDocNo(series, [])).toBe(`${series}-001`); // the pre-counter answer, stated

      // One order exists. Twenty-nine callers got a primary-key violation, which
      // is what the route turns into `insert_failed` + HTTP 500 when there is no
      // retry above it — customer, payments and PWP claims all lost with it.
      const failures = out.filter((o) => o.error);
      expect(out.filter((o) => !o.error)).toHaveLength(1);
      expect(failures).toHaveLength(SALESPEOPLE - 1);
      expect(new Set(failures.map((o) => o.error!.code))).toEqual(new Set(['23505']));

      const rows = await admin<Array<{ doc_no: string }>>`
        SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE ${`${series}-%`}`;
      expect(rows.map((r) => r.doc_no)).toEqual([`${series}-001`]);
    } finally {
      warn.mockRestore();
    }
  });

  test('RED — the retry net alone re-mints hard and is NOT what makes thirty safe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const series = 'HC-SO-2613';
      const out = await raceCreates({ series, counter: false, retry: true, sameMillisecond: true });

      /* The net engaged: with an identical floor, twenty-nine callers collided on
         the first attempt and had to re-mint. Guaranteed by the barrier, so this
         is an assertion and not a coincidence. */
      const totalMints = out.reduce((n, o) => n + o.mints, 0);
      expect(totalMints).toBeGreaterThan(SALESPEOPLE);
      expect(out.filter((o) => o.mints > 1).length).toBe(SALESPEOPLE - 1);

      /* The SAFETY property never breaks either way — the unique index is
         absolute, so no two orders can ever wear one number. What degrades is
         whether a caller gets served at all: each retry re-reads the live max,
         so the thundering herd re-collides and the eight tries are spent on
         contention rather than on progress. How many are lost depends on real
         scheduling, so it is REPORTED, not asserted — the stable claim is only
         that some callers can be refused here, which is exactly what the counter
         removes in the two tests above. */
      const served = out.filter((o) => !o.error);
      const refused = out.length - served.length;
      const rows = await admin<Array<{ doc_no: string }>>`
        SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE ${`${series}-%`} ORDER BY doc_no`;
      expect(rows).toHaveLength(served.length);
      expect(new Set(rows.map((r) => r.doc_no)).size).toBe(served.length);
      // eslint-disable-next-line no-console
      console.log(`[doc-no race] pre-counter + 8 retries at n=${SALESPEOPLE}: served ${served.length}, refused ${refused}, mints ${totalMints}`);
    } finally {
      warn.mockRestore();
    }
  });

  /* ── THE OTHER EDGES THE OWNER'S CASE IS NOT THE ONLY ONE OF ─────────────── */

  test('a create while a MID-month document is being deleted (the 2026-06-12 shape)', async () => {
    const series = 'HC-SO-2701';
    for (let i = 0; i < 5; i += 1) {
      const dn = await mintMonthlyDocNo(postgrestOver(admin), TABLE, COL, series);
      await admin`INSERT INTO scm.mfg_sales_orders (doc_no, company_id) VALUES (${dn}, 1)`;
    }
    // A cleanup removes one from the MIDDLE while creates keep arriving.
    const deleting = admin`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${`${series}-003`}`;
    const [created] = await Promise.all([
      raceCreates({ series, counter: true, retry: true, sameMillisecond: false, n: 5 }),
      deleting,
    ]);
    expect(created.filter((o) => o.error)).toEqual([]);
    /* count+1 was the 2026-06-12 outage: with 4 survivors it mints 005, which is
       alive, and every SO create jams on the primary key for the rest of the
       month. Neither max+1 nor the counter can do that — and the counter also
       refuses to re-issue 003, which max+1 would have done had the deleted row
       been the TOP one. */
    const rows = await admin<Array<{ doc_no: string }>>`
      SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE ${`${series}-%`} ORDER BY doc_no`;
    expect(suffixes(rows)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('the first create of a month nobody has used starts at 001', async () => {
    const series = 'HC-SO-2702';
    const [{ n: seeded }] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM scm.doc_number_counters WHERE series = ${series}`;
    expect(seeded).toBe(0); // nothing seeded it; the counter self-seeds on first use
    const first = await mintMonthlyDocNo(postgrestOver(admin), TABLE, COL, series);
    expect(first).toBe(`${series}-001`);
  });

  test('past the 1,000th document of one month: the paged floor is right, and a truncated one is harmless', async () => {
    const series = 'HC-SO-2703';
    await admin.unsafe(
      `INSERT INTO scm.mfg_sales_orders (doc_no, company_id)
         SELECT format('${series}-%s', lpad(i::text, 3, '0')), 1 FROM generate_series(1, 1200) i`,
    );
    const sb = postgrestOver(admin);

    /* THE TRAP doc-no.ts documents at length. A single un-paged PostgREST read
       stops at 1,000 rows WITHOUT an error. The cap is real and measured here;
       what it costs is then arithmetic on the set it returns — the first 1,000
       of the month — and the number that arithmetic derives is a document that
       is ALREADY LIVE. Before the counter that was a deterministic re-issue, and
       it did NOT self-heal: every retry re-read the same truncated set and
       re-minted the same dead number, so creation stayed 500 for the REST OF THE
       MONTH. Unlike the concurrent-create race above, it arrives on a schedule.

       The truncated SET is built rather than read back, deliberately: an
       un-ordered PostgREST cap returns "some 1,000 of them" and pinning which
       thousand would make this a test about physical row order. The cap itself
       is what is measured; its consequence is stated on the set it does return
       when the rows are in insertion order, which is the realistic case. */
    const capped = await sb.from(TABLE).select(COL).like(COL, `${series}-%`);
    expect((capped.data as unknown[])).toHaveLength(1000); // the cap, measured
    const firstThousand = Array.from({ length: 1000 }, (_, i) => `${series}-${String(i + 1).padStart(3, '0')}`);
    const derived = nextMonthlyDocNo(series, firstThousand);
    expect(derived).toBe(`${series}-1001`);
    const [{ n: alive }] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE doc_no = ${derived}`;
    expect(alive).toBe(1); // …a number that is ALREADY TAKEN. That is the trap.

    // fetchMonthlyDocNos pages, so the floor is the real one: 1200.
    expect(maxMonthlySuffix(series, await fetchMonthlyDocNos(sb, TABLE, COL, series))).toBe(1200);
    expect(await mintMonthlyDocNo(sb, TABLE, COL, series)).toBe(`${series}-1201`);

    /* And the counter makes the truncated floor harmless even if a caller
       somehow reports it: a LOW floor can only be ignored. Padding is not the
       ceiling either — the suffix widens past three digits and maxMonthlySuffix
       parses it numerically, so nothing here breaks at 999 → 1000. */
    expect(await claimDocNoSuffix(sb, series, 1000)).toBe(1202);
  });
});
