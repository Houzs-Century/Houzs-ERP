import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; this is the SAME splitter
// pg-migrate.mjs uses, so the replay below is the real one and not a lookalike.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import {
  mintMonthlyDocNo,
  nextJeNo,
  nextMonthlyDocNo,
  claimDocNoSuffix,
} from '../src/scm/lib/doc-no';

/* scm.doc_number_counters — the document counter, against a real server.
 *
 * WHAT THIS PROVES, and why none of it can be proved without one. The defect is
 * a DELETE followed by a mint: the old minter derived the next number from the
 * rows that still existed, so removing the TOP of a month handed that number
 * straight back, and on 2026-08-20 the ERP re-issued four numbers the AED_HOUZS
 * account book already held (docs/doc-number-reissue-coe.md). A unit test with a
 * stubbed client can only re-state the arithmetic it is given. The counter is an
 * INSERT … ON CONFLICT … RETURNING, so its atomicity is a property of Postgres
 * row locking and nothing else — two mocked clients cannot contend for a row.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL.
 *
 * THE RED IS IN THIS FILE, on purpose. Every assertion about the new behaviour
 * is paired with the PRE-COUNTER answer computed by `nextMonthlyDocNo`, which is
 * still exported and still returns exactly what shipped before this change. So
 * the file does not merely assert that the fix works: it shows, in the same
 * fixture and on the same rows, the number the old minter WOULD have handed
 * back. Reverting the fix makes these fail by name.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_doc_number_counters.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_doc_number_counters.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

/** Replay exactly as pg-migrate.mjs does: split, then one transaction. */
async function applyMigration(sql: Sql): Promise<number> {
  const stmts = splitSqlStatements(await migrationSql()) as string[];
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
  return stmts.length;
}

/* A PostgREST-SHAPED FACADE over a real connection — not a mock of the database.
 *
 * The production client is @supabase/supabase-js talking HTTP to PostgREST;
 * there is no way to run that here. What this replaces is the TRANSPORT, and
 * only the four calls doc-no.ts makes: `.from().select().like().order().range()`
 * and `.rpc()`. Every row, every lock and every counter increment below is real
 * PostgreSQL. The repo's own pgTransactionSupabase would have been preferable
 * and cannot be used: it has no `.like()`, which is the whole floor read.
 */
function postgrestOver(sql: Sql) {
  return {
    from(table: string) {
      const q = {
        _cols: '*',
        _like: null as null | [string, string],
        _order: null as null | [string, boolean],
        _from: 0,
        _to: 999,
        _limit: null as null | number,
        select(cols: string) { q._cols = cols; return q; },
        like(col: string, pattern: string) { q._like = [col, pattern]; return q; },
        order(col: string, opts?: { ascending?: boolean }) { q._order = [col, opts?.ascending !== false]; return q; },
        limit(n: number) { q._limit = n; return q; },
        range(from: number, to: number) { q._from = from; q._to = to; return q; },
        async then(
          resolve: (v: { data: unknown[] | null; error: unknown }) => void,
          _reject?: (e: unknown) => void,
        ) {
          const [likeCol, likePattern] = q._like ?? ['', '%'];
          const take = q._limit ?? (q._to - q._from + 1);
          try {
            const rows = await sql.unsafe(
              `SELECT ${q._cols} FROM scm.${table}`
              + (q._like ? ` WHERE ${likeCol} LIKE $1` : '')
              + (q._order ? ` ORDER BY ${q._order[0]}${q._order[1] ? '' : ' DESC'}` : '')
              + ` LIMIT ${take} OFFSET ${q._limit ? 0 : q._from}`,
              (q._like ? [likePattern] : []) as never[],
            );
            // PostgREST's shape: a read error is DATA, never a throw.
            resolve({ data: [...(rows as unknown[])], error: null });
          } catch (e) {
            resolve({ data: null, error: { message: e instanceof Error ? e.message : String(e) } });
          }
        },
      };
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'next_doc_no_n') return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${name}` } };
      try {
        const rows = await sql.unsafe<Array<{ n: number }>>(
          'SELECT scm.next_doc_no_n($1::text, $2::int) AS n',
          [args.p_series, args.p_floor] as never[],
        );
        return { data: rows[0]?.n ?? null, error: null };
      } catch (e) {
        return { data: null, error: { code: '', message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

const counters = async (sql: Sql) =>
  new Map(
    (await sql<Array<{ series: string; next_n: number }>>`
      SELECT series, next_n FROM scm.doc_number_counters ORDER BY series`)
      .map((r) => [r.series, Number(r.next_n)] as const),
  );

describePg('scm.doc_number_counters — the document counter (real postgres)', () => {
  let admin: Sql;
  let sb: ReturnType<typeof postgrestOver>;

  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    admin = postgres(url, { max: 12, onnotice: () => {} });
    sb = postgrestOver(admin);

    /* THE FIXTURE IS THE INCIDENT. 2990 keeps a full month of live rows (it was
       never wiped and must not move). HC keeps only what survived the 2026-08-20
       wipe: two sales orders and one each of PO / PI / GRN, and NOTHING at all
       for DO or SI — which is exactly why the book's HC-DO-2608-001/002 and
       HC-SI-2608-001 were armed to be re-issued. */
    await admin.unsafe(`
      DROP SCHEMA IF EXISTS scm CASCADE;
      CREATE SCHEMA scm;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA scm TO service_role;

      CREATE TABLE scm.mfg_sales_orders  (doc_no         text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.purchase_orders   (po_number      text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.delivery_orders   (do_number      text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.sales_invoices    (invoice_number text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.purchase_invoices (invoice_number text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.grns              (grn_number     text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.trips             (trip_no        text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.journal_entries   (je_no          text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.autocount_outbox  (doc_no         text NOT NULL);
      -- A table with no rows at all: the state a wipe leaves behind.
      CREATE TABLE scm.doc_no_probe      (x              text PRIMARY KEY);

      -- 2990: a full, untouched month (26 sales orders, 20 POs, 5 JEs).
      INSERT INTO scm.mfg_sales_orders (doc_no, company_id)
        SELECT format('2990-SO-2608-%s', lpad(i::text, 3, '0')), 2 FROM generate_series(1, 26) i;
      INSERT INTO scm.purchase_orders (po_number, company_id)
        SELECT format('2990-PO-2608-%s', lpad(i::text, 3, '0')), 2 FROM generate_series(1, 20) i;
      INSERT INTO scm.journal_entries (je_no, company_id)
        SELECT format('2990-JE-2608-%s', lpad(i::text, 4, '0')), 2 FROM generate_series(1, 5) i;

      -- HC: what the wipe left behind, plus the outbox rows raised after it.
      INSERT INTO scm.mfg_sales_orders (doc_no, company_id)
        VALUES ('HC-SO-2608-001', 1), ('HC-SO-2608-002', 1);
      INSERT INTO scm.purchase_orders   (po_number,      company_id) VALUES ('HC-PO-2608-001', 1);
      INSERT INTO scm.purchase_invoices (invoice_number, company_id) VALUES ('HC-PI-2608-001', 1);
      INSERT INTO scm.grns              (grn_number,     company_id) VALUES ('HC-GRN-2608-001', 1);
      INSERT INTO scm.autocount_outbox (doc_no) VALUES
        ('HC-SO-2608-001'), ('HC-SO-2608-002'), ('HC-PO-2608-001'),
        ('HC-PI-2608-001'), ('HC-GRN-2608-001');

      -- The cross-company trip sequence: no company prefix, one series.
      INSERT INTO scm.trips (trip_no, company_id)
        VALUES ('TRIP-2608-001', 1), ('TRIP-2608-002', 2), ('TRIP-2608-003', 1);
    `);

    const applied = await applyMigration(admin);
    expect(applied).toBeGreaterThan(5);
  });

  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  /* ── THE DEFECT ─────────────────────────────────────────────────────────── */

  test('deleting the TOP of a month does not hand its number back (the defect)', async () => {
    // Mint three fresh numbers into an empty series.
    const a = await mintMonthlyDocNo(sb, 'doc_no_probe', 'x', 'HC-ZZ-2608');
    expect(a).toBe('HC-ZZ-2608-001');
    const b = await mintMonthlyDocNo(sb, 'doc_no_probe', 'x', 'HC-ZZ-2608');
    const c = await mintMonthlyDocNo(sb, 'doc_no_probe', 'x', 'HC-ZZ-2608');
    expect([b, c]).toEqual(['HC-ZZ-2608-002', 'HC-ZZ-2608-003']);

    /* Nothing was written to a document table above, so the live rows for this
       series are ALREADY empty — the exact state the wipe produced. THE OLD
       MINTER, on this same state, hands 001 straight back: */
    expect(nextMonthlyDocNo('HC-ZZ-2608', [])).toBe('HC-ZZ-2608-001');

    // The counter does not.
    const d = await mintMonthlyDocNo(sb, 'doc_no_probe', 'x', 'HC-ZZ-2608');
    expect(d).toBe('HC-ZZ-2608-004');
    expect([a, b, c]).not.toContain(d);
  });

  test('a real DELETE of the highest row cannot re-issue that number', async () => {
    // Three live sales orders in a fresh month, minted through the counter.
    for (let i = 0; i < 3; i += 1) {
      const n = await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2610');
      await admin`INSERT INTO scm.mfg_sales_orders (doc_no, company_id) VALUES (${n}, 1)`;
    }
    const before = await admin<Array<{ doc_no: string }>>`
      SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE 'HC-SO-2610-%' ORDER BY doc_no`;
    expect(before.map((r) => r.doc_no)).toEqual(['HC-SO-2610-001', 'HC-SO-2610-002', 'HC-SO-2610-003']);

    // Delete the TOP of the month — a go-live wipe, a cleanup, a rolled-back create.
    await admin`DELETE FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-2610-003'`;
    const survivors = (await admin<Array<{ doc_no: string }>>`
      SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE 'HC-SO-2610-%' ORDER BY doc_no`)
      .map((r) => r.doc_no);

    // RED, stated: this is what shipped before, on exactly these survivors.
    expect(nextMonthlyDocNo('HC-SO-2610', survivors)).toBe('HC-SO-2610-003');

    // GREEN: the counter steps over the hole instead of falling into it.
    const next = await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2610');
    expect(next).toBe('HC-SO-2610-004');
  });

  test('wiping the WHOLE month does not restart the series at 001', async () => {
    await admin`DELETE FROM scm.mfg_sales_orders WHERE doc_no LIKE 'HC-SO-2610-%'`;
    expect(nextMonthlyDocNo('HC-SO-2610', [])).toBe('HC-SO-2610-001'); // RED: the 2026-08-20 incident
    const next = await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2610');
    expect(next).toBe('HC-SO-2610-005'); // GREEN
  });

  /* ── CONCURRENCY ────────────────────────────────────────────────────────── */

  test('two concurrent transactions cannot claim the same number', async () => {
    // Real contention: tx1 claims and HOLDS its row lock; tx2 must wait.
    let released = false;
    const tx1 = admin.begin(async (t) => {
      const [{ n }] = await t<Array<{ n: number }>>`SELECT scm.next_doc_no_n('CONC-2608', 0) AS n`;
      await new Promise((r) => setTimeout(r, 150)); // hold the lock
      released = true;
      return Number(n);
    });
    await new Promise((r) => setTimeout(r, 40));
    const tx2 = admin.begin(async (t) => {
      const [{ n }] = await t<Array<{ n: number }>>`SELECT scm.next_doc_no_n('CONC-2608', 0) AS n`;
      // Proves tx2 was BLOCKED on tx1's row, not merely sequenced by luck.
      expect(released).toBe(true);
      return Number(n);
    });
    const [a, b] = await Promise.all([tx1, tx2]);
    expect(new Set([a, b]).size).toBe(2);
    expect([a, b].sort((x, y) => x - y)).toEqual([1, 2]);
  });

  test('40 claims across 8 real connections are 40 distinct numbers', async () => {
    const pools = Array.from({ length: 8 }, () => postgres(url, { max: 1, onnotice: () => {} }));
    try {
      const claimed = (
        await Promise.all(
          pools.map(async (p) => {
            const out: number[] = [];
            for (let i = 0; i < 5; i += 1) {
              const [{ n }] = await p<Array<{ n: number }>>`SELECT scm.next_doc_no_n('FANOUT-2608', 0) AS n`;
              out.push(Number(n));
            }
            return out;
          }),
        )
      ).flat();
      expect(claimed).toHaveLength(40);
      expect(new Set(claimed).size).toBe(40);
      expect([...claimed].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    } finally {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
    }
  });

  /* ── THE SEED ───────────────────────────────────────────────────────────── */

  test("2990's existing series are exactly where they were — the migration does not move them", async () => {
    const c = await counters(admin);
    // Every 2990 series lands on live max + 1, i.e. the number the OLD minter
    // would have handed out. 2990 was never wiped and nothing 2990 mints has
    // ever reached the AED_HOUZS book, so it must not move by even one.
    for (const [series, table, col, live] of [
      ['2990-SO-2608', 'mfg_sales_orders', 'doc_no', 26],
      ['2990-PO-2608', 'purchase_orders', 'po_number', 20],
      ['2990-JE-2608', 'journal_entries', 'je_no', 5],
    ] as const) {
      const rows = (await admin.unsafe<Array<Record<string, string>>>(
        `SELECT ${col} AS v FROM scm.${table} WHERE ${col} LIKE '${series}-%'`,
      )).map((r) => r.v);
      expect(rows).toHaveLength(live);
      expect(c.get(series)).toBe(live + 1);
    }
    // Said the other way round, against the function that shipped before this
    // change: for a 3-pad series the seeded counter and the OLD minter agree
    // exactly, so nothing 2990 raises next is renumbered by one digit.
    const soRows = (await admin<Array<{ v: string }>>`
      SELECT doc_no AS v FROM scm.mfg_sales_orders WHERE doc_no LIKE '2990-SO-2608-%'`).map((r) => r.v);
    expect(nextMonthlyDocNo('2990-SO-2608', soRows)).toBe('2990-SO-2608-027');
    expect(c.get('2990-SO-2608')).toBe(27);
  });

  test('the ARMED series are seeded above the account book, from named evidence', async () => {
    const c = await counters(admin);
    /* The book holds HC-DO-2608-001/002 and HC-SI-2608-001 while the ERP holds
       NO row for either — the state that made them the next two collisions. */
    const [{ n: liveDo }] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM scm.delivery_orders WHERE do_number LIKE 'HC-DO-2608-%'`;
    expect(liveDo).toBe(0);
    expect(nextMonthlyDocNo('HC-DO-2608', [])).toBe('HC-DO-2608-001'); // RED: what the book already holds
    expect(c.get('HC-DO-2608')).toBe(3);
    expect(c.get('HC-SI-2608')).toBe(2);
    expect(c.get('HC-SO-2608')).toBe(3);
    expect(c.get('HC-PO-2608')).toBe(2);
    expect(c.get('HC-PI-2608')).toBe(2);
    // Every seeded row says where it came from — a money path answers "why is
    // this series at 3?" from the row, not from a commit message.
    const sources = await admin<Array<{ series: string; seed_source: string }>>`
      SELECT series, seed_source FROM scm.doc_number_counters
       WHERE series IN ('HC-DO-2608','HC-SI-2608','HC-SO-2608','HC-PO-2608','HC-PI-2608')`;
    expect(sources).toHaveLength(5);
    for (const r of sources) expect(r.seed_source).toMatch(/ac-live-proof\.json/);
  });

  test('HC-GRN is seeded WITHOUT claiming book evidence it does not have', async () => {
    const c = await counters(admin);
    /* The book holds HC-GR-2608-001; our minter writes HC-GRN-. Different
       strings, so they cannot collide as written — and nothing in this repo can
       say whether the office host maps one onto the other. The counter is
       seeded past the number the ERP is EVIDENCED to have issued and queued for
       export, and its own source row says in words that this is not a book
       number. Pinned, because the tempting future edit is to tidy that sentence
       into looking like the other five. */
    expect(c.get('HC-GRN-2608')).toBe(2);
    expect(c.has('HC-GR-2608')).toBe(false); // no minter produces this string
    const [row] = await admin<Array<{ seed_source: string }>>`
      SELECT seed_source FROM scm.doc_number_counters WHERE series = 'HC-GRN-2608'`;
    expect(row.seed_source).toMatch(/NOT a book number/);
    expect(row.seed_source).not.toMatch(/AED_HOUZS holds/);
  });

  test('a month with no prior rows starts at 001', async () => {
    const c = await counters(admin);
    expect(c.has('HC-SO-2612')).toBe(false); // nothing seeded it
    const first = await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2612');
    expect(first).toBe('HC-SO-2612-001');
    const second = await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2612');
    expect(second).toBe('HC-SO-2612-002');
  });

  test('TRIP stays ONE sequence shared by both companies', async () => {
    /* No company prefix, deliberately: lib/companyScope.ts says "Do NOT apply
       to CROSS-COMPANY shared docs (trips / delivery-planning) — those keep one
       shared sequence", and both call sites (trips.ts:101,
       delivery-planning.ts:2222) pass the bare `TRIP-${yymm}`. Preserved, not
       inherited by accident: a per-company TRIP series would renumber a live
       sequence. */
    const c = await counters(admin);
    expect(c.get('TRIP-2608')).toBe(4); // live max 3 (one company 2 rows, other 1)
    expect([...c.keys()].filter((k) => k.includes('TRIP'))).toEqual(['TRIP-2608']);

    const fromCompany1 = await mintMonthlyDocNo(sb, 'trips', 'trip_no', 'TRIP-2608');
    const fromCompany2 = await mintMonthlyDocNo(sb, 'trips', 'trip_no', 'TRIP-2608');
    expect([fromCompany1, fromCompany2]).toEqual(['TRIP-2608-004', 'TRIP-2608-005']);
    const after = await counters(admin);
    expect([...after.keys()].filter((k) => k.includes('TRIP'))).toEqual(['TRIP-2608']);
  });

  test('JE takes its number from the same counter and keeps its 4-pad', async () => {
    const je = await nextJeNo(sb, new Date('2026-08-15T00:00:00Z'), '2990-');
    expect(je).toBe('2990-JE-2608-0006');
    const je2 = await nextJeNo(sb, new Date('2026-08-15T00:00:00Z'), '2990-');
    expect(je2).toBe('2990-JE-2608-0007');
    // …and stays a per-company sequence: HOUZS JEs are historically bare.
    const houzs = await nextJeNo(sb, new Date('2026-08-15T00:00:00Z'), '');
    expect(houzs).toBe('JE-2608-0001');
  });

  /* ── PROPERTIES OF THE COUNTER ──────────────────────────────────────────── */

  test('a live row ABOVE the counter pushes it up; a low floor never pulls it down', async () => {
    // An out-of-band insert (an import, a repair script) cannot be re-issued…
    await admin`INSERT INTO scm.purchase_orders (po_number, company_id) VALUES ('HC-PO-2608-050', 1)`;
    const next = await mintMonthlyDocNo(sb, 'purchase_orders', 'po_number', 'HC-PO-2608');
    expect(next).toBe('HC-PO-2608-051');
    // …and a floor BELOW the counter (a truncated read, a deleted month) is
    // simply ignored, which is what makes the 1000-row PostgREST truncation
    // trap in doc-no.ts unable to cause a re-issue any more.
    expect(await claimDocNoSuffix(sb, 'HC-PO-2608', 0)).toBe(52);
    expect(await claimDocNoSuffix(sb, 'HC-PO-2608', 3)).toBe(53);
  });

  test('re-applying the migration moves no counter', async () => {
    const before = await counters(admin);
    await applyMigration(admin);
    const after = await counters(admin);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  test('the RPC is service_role only', async () => {
    const [{ acl }] = await admin<Array<{ acl: string | null }>>`
      SELECT array_to_string(proacl, ',') AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'scm' AND p.proname = 'next_doc_no_n'`;
    expect(acl ?? '').toMatch(/service_role=X/);
    expect(acl ?? '').not.toMatch(/(^|,)=X/); // no PUBLIC execute
  });
});
