import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* Real PostgreSQL proof for check-autocount-drift.mjs — hard rule 2's drift
   detection ("staff WILL edit in AutoCount out of habit") and hard rule 3's
   cancel-parity acceptance test.
 *
 * WHY AN INTEGRATION TEST AND NOT A UNIT TEST. The script is a top-level-await
 * program whose comparisons are inseparable from its queries, and the defect
 * class it is most exposed to is a query or a property that does not resolve.
 * That is not hypothetical here: section 4 advertised "date, party name, ref,
 * document total" while gating the ref and total comparisons on `d.refCol` and
 * `d.totalCol` — two properties NO document type ever defined. Both were
 * permanently undefined, so the two comparisons never ran, and the section
 * printed "None." however far apart the two systems' money was. A green check
 * asserting coverage it does not have is worse than no check, because the
 * heading is what the next reader trusts.
 *
 * So this runs the REAL script as a subprocess against the REAL migrations, with
 * a fixture AutoCount snapshot supplied through AC_DRIFT_DATA_DIR, and asserts
 * on what it PRINTS. Nothing here can reach the live account book: the snapshot
 * is a local fixture and the script only ever reads.
 *
 * Skipped, not failed, without TEST_DATABASE_URL: locally there is no PG. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/check-autocount-drift.mjs', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber these constantly.
async function migrationBySuffix(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]), 'utf8');
}

let admin: Sql;
let dataDir: string;

/* The columns the drift check binds. total_centi and ref exist here because
   they are exactly what the fix made the script resolve and select; a fixture
   without them would let the old always-undefined behaviour pass unnoticed. */
async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests refuse any database other than houzs_test');
  }
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE scm.app_config (
      key text PRIMARY KEY, value text, description text);
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, status text, so_date date, debtor_name text,
      ref text, total_centi bigint,
      linked_ac_docno text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text,
      item_code text, qty numeric, unit_price_centi bigint);
    CREATE TABLE scm.purchase_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_number text, status text,
      po_date date, creditor_name text, total_centi bigint,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purchase_order_id uuid,
      item_code text, qty numeric, unit_price_centi bigint);
    CREATE TABLE scm.delivery_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      total_centi bigint, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.grns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      total_centi bigint, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.sales_invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      total_centi bigint, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.purchase_invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      total_centi bigint, created_at timestamptz NOT NULL DEFAULT now());
  `);
  await sql.unsafe(await migrationBySuffix('_scm_autocount_outbox.sql'));
  await sql.unsafe(await migrationBySuffix('_scm_autocount_outbox_alarm.sql'));
}

const EMPTY_TYPES = { SO: [], PO: [], DO: [], GR: [], IV: [], PI: [] };

/** Write a fixture AutoCount snapshot the script will read via AC_DRIFT_DATA_DIR. */
async function snapshot(headers: Record<string, unknown[]>, lines: Record<string, unknown[]> = {}) {
  await writeFile(join(dataDir, 'ac-doc-headers.json.gz'),
    gzipSync(Buffer.from(JSON.stringify({ ...EMPTY_TYPES, ...headers }), 'utf8')));
  await writeFile(join(dataDir, 'ac-doc-lines.json.gz'),
    gzipSync(Buffer.from(JSON.stringify({ ...EMPTY_TYPES, ...lines }), 'utf8')));
  await writeFile(join(dataDir, 'ac-doc-export-manifest.json'), JSON.stringify({
    // Fresh, so the >7-day staleness warning does not colour the verdict.
    exported_at: new Date().toISOString().slice(0, 19),
    database: 'AED_HOUZS_FIXTURE', host: '127.0.0.1', line_cutoff: '2026-07-01',
  }));
}

const acSo = (over: Record<string, unknown> = {}) => ({
  DocNo: 'SO-000021', DocDate: '2026-08-01', PartyName: 'ACME', Ref: 'PO-CUST-1',
  Cancelled: false, NetTotal: 1500.0, LastModified: '2026-08-01T09:00:00',
  LastModifiedUserID: 'ADMIN', ...over,
});

/* child_process is imported LAZILY — `npm test` collects this file under the
   Cloudflare workers pool, where a module-scope node:child_process import fails
   the file at load time, before describe.skip can spare it. */
async function drift(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [scriptPath], {
    env: { ...process.env, DATABASE_URL: url, TOP: '10', AC_DRIFT_DATA_DIR: dataDir },
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

describePg('check-autocount-drift against real PostgreSQL', () => {
  beforeAll(async () => {
    admin = postgres(url, { ssl: false, prepare: false, max: 1, onnotice: () => {} });
    dataDir = await mkdtemp(join(tmpdir(), 'ac-drift-fixture-'));
  });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetFixture(admin); });

  test('every query executes against the real schema, and each doc type binds its total column', async () => {
    await snapshot({});
    const stdout = await drift();
    // A phantom column anywhere would have thrown 42703 and exited 1.
    for (const section of [
      'SECTION 0 — COLUMN BINDING',
      'SECTION 1 — SCOPE',
      'SECTION 2 — BROKEN LINKS',
      'SECTION 3 — CANCEL PARITY',
      'SECTION 4 — HEADER FIELD DRIFT',
      'SECTION 5 — EDITED IN AUTOCOUNT',
      'SECTION 6 — LINE DRIFT',
    ]) expect(stdout).toContain(section);
    /* The binding line now REPORTS what it resolved. Before the fix `total=`
       was not printed at all, because no type carried a totalCands list. */
    expect(stdout).toContain('total=total_centi');
    // Nothing linked yet, so the honest answer is "not measurable", not "OK".
    expect(stdout).toContain('VERDICT: NOT MEASURABLE');
  });

  test('a document total that disagrees with AutoCount is REPORTED', async () => {
    // ERP says 1500.00; the account book says 1499.00. One ringgit, and before
    // the fix this printed "None." because the comparison never ran.
    await snapshot({ SO: [acSo({ NetTotal: 1499.0 })] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, ref, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CONFIRMED', '2026-08-01', 'ACME', 'PO-CUST-1', 150000, 'SO-000021')`;

    const stdout = await drift();
    expect(stdout).toContain('total ERP=1500.00 AC=1499.00');
    expect(stdout).toContain('document(s) whose header fields disagree');
    expect(stdout).not.toContain('SECTION 4 — HEADER FIELD DRIFT\n' + '='.repeat(78) + '\n  None.');
  });

  test('a Ref changed inside AutoCount is REPORTED', async () => {
    await snapshot({ SO: [acSo({ Ref: 'SOMETHING-ELSE' })] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, ref, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CONFIRMED', '2026-08-01', 'ACME', 'PO-CUST-1', 150000, 'SO-000021')`;

    const stdout = await drift();
    expect(stdout).toContain('ref ERP="PO-CUST-1" AC="SOMETHING-ELSE"');
  });

  test('an agreeing document is NOT reported — the check can still say None', async () => {
    /* The other half of the proof. A comparison that fires on everything would
       also "catch" the cases above, and would be just as useless. */
    await snapshot({ SO: [acSo()] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, ref, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CONFIRMED', '2026-08-01', 'ACME', 'PO-CUST-1', 150000, 'SO-000021')`;

    const stdout = await drift();
    expect(stdout).not.toContain('total ERP=');
    expect(stdout).not.toContain('ref ERP=');
    expect(stdout).not.toContain('header fields disagree');
  });

  test('a blank ERP ref is not drift — the ERP never claimed that field', async () => {
    await snapshot({ SO: [acSo({ Ref: 'SET-BY-A-HUMAN-IN-AUTOCOUNT' })] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, ref, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CONFIRMED', '2026-08-01', 'ACME', NULL, 150000, 'SO-000021')`;

    const stdout = await drift();
    expect(stdout).not.toContain('ref ERP=');
  });

  test('cancel parity: a document cancelled on ONE side only is the hard-rule-3 divergence', async () => {
    // Cancelled in the ERP, still live in AutoCount — exactly the SI/PI cancel
    // gap. The owner's outstanding rule then differs by this document.
    await snapshot({ SO: [acSo({ Cancelled: false })] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, ref, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CANCELLED', '2026-08-01', 'ACME', 'PO-CUST-1', 150000, 'SO-000021')`;

    const stdout = await drift();
    expect(stdout).toContain('ERP=CANCELLED');
    expect(stdout).toContain('AutoCount=live');
    expect(stdout).toContain('cancelled on ONE side only');
    expect(stdout).toContain('VERDICT: ALARM');
  });

  test('a linked document AutoCount does not have is a BROKEN LINK, not a silent skip', async () => {
    await snapshot({ SO: [] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CONFIRMED', '2026-08-01', 'ACME', 150000, 'SO-999999')`;

    const stdout = await drift();
    expect(stdout).toContain('NOT FOUND');
    expect(stdout).toContain('point at an AutoCount document that does not exist');
    expect(stdout).toContain('VERDICT: ALARM');
  });

  test('an edit made in AutoCount after the ERP wrote is the habit signal (hard rule 2)', async () => {
    await snapshot({ SO: [acSo({ LastModified: '2026-08-05T14:00:00', LastModifiedUserID: 'SHOPFLOOR' })] });
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, status, so_date, debtor_name, ref, total_centi, linked_ac_docno)
      VALUES ('HC-SO-1', 'CONFIRMED', '2026-08-01', 'ACME', 'PO-CUST-1', 150000, 'SO-000021')`;
    await admin`
      INSERT INTO scm.autocount_outbox
        (company_id, op, doc_type, doc_no, payload, status, ac_doc_no, sent_at)
      VALUES (1, 'create_so', 'SO', 'HC-SO-1', '{}'::jsonb, 'sent', 'SO-000021',
              '2026-08-02T10:00:00Z')`;

    const stdout = await drift();
    expect(stdout).toContain('AutoCount modified 2026-08-05T14:00:00 by SHOPFLOOR');
    expect(stdout).toContain('edited in AutoCount after the ERP wrote them');
    expect(stdout).toContain('VERDICT: ALARM');
  });
});
