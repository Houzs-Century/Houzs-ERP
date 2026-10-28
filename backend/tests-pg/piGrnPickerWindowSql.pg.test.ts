/* EXECUTES the statements behind `scripts/check-pi-grn-picker-window.mjs`
 * against real Postgres and compares every figure with a brute force computed
 * here, in TypeScript, from the rows the fixture inserted.
 *
 * WHY. The check is a `workflow_dispatch` workflow over production's
 * DATABASE_URL. It cannot be dispatched until it is on main, and there is no
 * local database, so without this suite its first contact with a Postgres
 * parser would be production — probeTransferCensusSql.pg.test.ts records the
 * probe that died on its first dispatch for exactly that reason. This one leans
 * on Postgres-only syntax (`::int` parameters, `IS DISTINCT FROM`,
 * `NULLS FIRST`, `FILTER`, `to_regclass`) and on an optional view join, which
 * is two statement shapes, and both run below.
 *
 * The view is the REAL definition, read from its migration by suffix, so a
 * later change to what "outstanding" means is compared rather than assumed.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  PICKER_WINDOW,
  assessCompany,
  measurePickerWindow,
} from '../scripts/lib/pi-grn-picker-window.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

type Note = { id: string; grn_number: string; received_at: string; status: string; on_hold: boolean; company_id: number };
type Line = { id: string; grn_id: string; company_id: number; qty_accepted: number; invoiced_qty: number | null; returned_qty: number | null };

/* Deterministic, so a failure reproduces. */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function fixture() {
  const rnd = lcg(7);
  const notes: Note[] = [];
  const lines: Line[] = [];
  let seq = 0;
  const addNote = (company: number, day: string, status: string, onHold: boolean, lineSpec: Array<[number, number | null, number | null]>) => {
    const id = uuid(++seq);
    notes.push({ id, grn_number: `GRN-${seq}`, received_at: day, status, on_hold: onHold, company_id: company });
    for (const [acc, inv, ret] of lineSpec) {
      lines.push({ id: uuid(100000 + ++seq), grn_id: id, company_id: company, qty_accepted: acc, invoiced_qty: inv, returned_qty: ret });
    }
    return id;
  };
  const randomLines = (): Array<[number, number | null, number | null]> =>
    Array.from({ length: Math.floor(rnd() * 5) }, () => {
      const acc = Math.floor(rnd() * 4);
      const inv = rnd() < 0.6 ? acc : Math.floor(rnd() * (acc + 1));
      return [acc, rnd() < 0.05 ? null : inv, rnd() < 0.1 ? 1 : 0];
    });

  // Company 1: past the window. 23 notes a day over 25 days, newest day short
  // (8), so the window fills 8 + 21*23 = 491 and takes 9 of the 23 notes on
  // 2026-01-04: the edge date is a real tie, 14 of its notes fall out. Every
  // fourth note carries an unbilled line so no date is without one.
  for (let k = 0; k < 560; k++) {
    const day = `2026-01-${String(1 + Math.floor(k / 23)).padStart(2, '0')}`;
    addNote(1, day, 'POSTED', false, k % 4 === 0 ? [[2, 0, 0], ...randomLines()] : randomLines());
  }
  // The sentinel the whole check exists for: the OLDEST note, still unbilled.
  addNote(1, '2025-01-01', 'POSTED', false, [[5, 0, 0]]);
  // Notes that must not count anywhere: held, draft, cancelled.
  for (let k = 0; k < 15; k++) addNote(1, '2026-09-01', 'POSTED', true, [[3, 0, 0]]);
  for (let k = 0; k < 15; k++) addNote(1, '2026-09-01', 'DRAFT', false, [[3, 0, 0]]);
  for (let k = 0; k < 15; k++) addNote(1, '2026-09-01', 'CANCELLED', false, [[3, 0, 0]]);
  // Company 2: under the window.
  for (let k = 0; k < 60; k++) addNote(2, `2026-08-${String(1 + (k % 28)).padStart(2, '0')}`, 'POSTED', false, randomLines());
  // Three lines stamped with the other company's id.
  const c1Posted = notes.filter((n) => n.company_id === 1 && n.status === 'POSTED' && !n.on_hold);
  for (const n of c1Posted.slice(0, 3)) {
    lines.push({ id: uuid(900000 + ++seq), grn_id: n.id, company_id: 2, qty_accepted: 1, invoiced_qty: 1, returned_qty: 0 });
  }
  return { notes, lines };
}

/* The brute force. Every order PostgREST could legally return is
   "received_at DESC, then any order within a date", so the bounds are computed
   date group by date group, and the point figures with the SQL's own tie-break. */
function brute({ notes, lines }: { notes: Note[]; lines: Line[] }, company: number) {
  const posted = notes.filter((n) => n.company_id === company && n.status === 'POSTED' && !n.on_hold);
  const per = new Map(posted.map((n) => [n.id, { note: n, lines: 0, out: 0, mismatch: 0 }]));
  for (const l of lines) {
    const p = per.get(l.grn_id);
    if (!p) continue;
    p.lines += 1;
    if ((l.qty_accepted ?? 0) - (l.invoiced_qty ?? 0) - (l.returned_qty ?? 0) > 0) p.out += 1;
    if (l.company_id !== company) p.mismatch += 1;
  }
  const all = [...per.values()];
  const ordered = [...all].sort((a, b) =>
    a.note.received_at === b.note.received_at
      ? (a.note.id < b.note.id ? -1 : 1)
      : (a.note.received_at < b.note.received_at ? 1 : -1));
  const inWindow = ordered.slice(0, PICKER_WINDOW);
  const outWindow = ordered.slice(PICKER_WINDOW);

  let taken = 0; let hidMin = 0; let hidMax = 0; let linesMin = 0; let linesMax = 0;
  const dates = [...new Set(all.map((p) => p.note.received_at))].sort().reverse();
  for (const d of dates) {
    const group = all.filter((p) => p.note.received_at === d);
    const slots = Math.max(0, Math.min(group.length, PICKER_WINDOW - taken));
    const outs = group.filter((p) => p.out > 0).length;
    hidMin += Math.max(0, outs - slots);
    hidMax += outs - Math.max(0, slots - (group.length - outs));
    const asc = group.map((p) => p.lines).sort((x, y) => x - y);
    linesMin += asc.slice(0, slots).reduce((s, x) => s + x, 0);
    linesMax += asc.slice(asc.length - slots).reduce((s, x) => s + x, 0);
    taken += slots;
  }
  const sum = (xs: typeof all, f: (p: (typeof all)[number]) => number) => xs.reduce((s, p) => s + f(p), 0);
  return {
    postedNotes: all.length,
    postedLines: sum(all, (p) => p.lines),
    outstandingNotes: all.filter((p) => p.out > 0).length,
    outstandingLines: sum(all, (p) => p.out),
    hiddenNotes: outWindow.filter((p) => p.out > 0).length,
    hiddenLines: sum(outWindow, (p) => p.out),
    visibleNotes: inWindow.filter((p) => p.out > 0).length,
    visibleLines: sum(inWindow, (p) => p.out),
    windowLines: sum(inWindow, (p) => p.lines),
    hiddenNotesMin: all.length > PICKER_WINDOW ? hidMin : 0,
    hiddenNotesMax: all.length > PICKER_WINDOW ? hidMax : 0,
    windowLinesMin: linesMin,
    windowLinesMax: linesMax,
    lineCompanyMismatch: sum(all, (p) => p.mismatch),
    maxLinesOneNote: Math.max(0, ...all.map((p) => p.lines)),
    boundaryDate: all.length >= PICKER_WINDOW ? ordered[PICKER_WINDOW - 1]!.note.received_at : null,
    notesWithoutUnbilled: all.filter((p) => p.out === 0).length,
  };
}

let sql: Sql;
const data = fixture();

async function resetSchema(db: Sql) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  /* Targeted drops rather than DROP SCHEMA: other suites keep their own
     objects in scm, and this file has no business removing them. */
  await db.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP VIEW IF EXISTS scm.v_grn_outstanding CASCADE;
    DROP TABLE IF EXISTS scm.grn_items CASCADE;
    DROP TABLE IF EXISTS scm.grns CASCADE;
    DROP TYPE IF EXISTS scm.grn_status CASCADE;
    -- (id, code) only: other suites leave this table behind in two shapes, and
    -- these are the two columns both of them have.
    CREATE TABLE IF NOT EXISTS public.companies (id bigint PRIMARY KEY, code text, name text, is_active int);
    INSERT INTO public.companies (id, code) VALUES (1, 'HOUZS'), (2, '2990')
    ON CONFLICT (id) DO NOTHING;
    CREATE TYPE scm.grn_status AS ENUM ('DRAFT', 'POSTED', 'CANCELLED', 'CLOSED');
    CREATE TABLE scm.grns (
      id uuid PRIMARY KEY,
      grn_number text NOT NULL,
      supplier_id uuid,
      received_at date NOT NULL,
      status scm.grn_status NOT NULL DEFAULT 'POSTED',
      on_hold boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      company_id bigint NOT NULL
    );
    -- invoiced_qty / returned_qty nullable on purpose: both the handler and the
    -- check COALESCE them, and a fixture that could not hold a NULL would not
    -- prove that half. No foreign key to scm.grns: other suites in this
    -- database DROP scm.grns without CASCADE, and a constraint left behind by
    -- this file failed grnCancelAtomicity.pg.test.ts on its first CI run.
    CREATE TABLE scm.grn_items (
      id uuid PRIMARY KEY,
      grn_id uuid NOT NULL,
      company_id bigint NOT NULL,
      qty_accepted integer NOT NULL,
      invoiced_qty integer,
      returned_qty integer
    );
  `);
  for (let i = 0; i < data.notes.length; i += 500) {
    const batch = data.notes.slice(i, i + 500);
    await db`INSERT INTO scm.grns ${db(batch, 'id', 'grn_number', 'received_at', 'status', 'on_hold', 'company_id')}`;
  }
  for (let i = 0; i < data.lines.length; i += 500) {
    const batch = data.lines.slice(i, i + 500);
    await db`INSERT INTO scm.grn_items ${db(batch, 'id', 'grn_id', 'company_id', 'qty_accepted', 'invoiced_qty', 'returned_qty')}`;
  }
  await db.unsafe(await migrationSql('_grn_outstanding_line_level.sql'));
}

describePg('check-pi-grn-picker-window SQL, executed', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await resetSchema(sql);
  });
  /* Leave nothing behind. The suites share one database and several build
     scm.grns / scm.grn_items in their own shapes with CREATE TABLE IF NOT
     EXISTS, which would silently inherit this file's columns. */
  afterAll(async () => {
    await sql?.unsafe(`
      DROP VIEW IF EXISTS scm.v_grn_outstanding;
      DROP TABLE IF EXISTS scm.grn_items;
      DROP TABLE IF EXISTS scm.grns;
      DROP TYPE IF EXISTS scm.grn_status;
    `);
    await sql?.end({ timeout: 5 });
  });

  test('the fixture exercises the thing being measured', () => {
    const c1 = brute(data, 1);
    expect(c1.postedNotes).toBeGreaterThan(PICKER_WINDOW);
    expect(c1.hiddenNotesMin).toBeGreaterThan(0);                     // the 2025 sentinel at least
    expect(c1.hiddenNotesMax).toBeGreaterThan(c1.hiddenNotesMin);     // and a real tie at the edge
    expect(brute(data, 2).postedNotes).toBeLessThan(PICKER_WINDOW);
  });

  test('every figure matches the brute force, per company, with the real view', async () => {
    const { hasView, rows } = await measurePickerWindow(sql);
    expect(hasView).toBe(true);
    expect(rows.map((r: { company_id: string }) => Number(r.company_id))).toEqual([1, 2]);

    for (const row of rows) {
      const company = Number(row.company_id);
      const b = brute(data, company);
      const { facts } = assessCompany(row);
      expect({
        postedNotes: facts.postedNotes,
        postedLines: facts.postedLines,
        outstandingNotes: facts.outstandingNotes,
        outstandingLines: facts.outstandingLines,
        hiddenNotes: facts.hiddenNotes,
        hiddenLines: facts.hiddenLines,
        visibleNotes: facts.visibleNotes,
        visibleLines: facts.visibleLines,
        windowLines: facts.windowLines,
        hiddenNotesMin: facts.hiddenNotesMin,
        hiddenNotesMax: facts.hiddenNotesMax,
        windowLinesMin: facts.windowLinesMin,
        windowLinesMax: facts.windowLinesMax,
        lineCompanyMismatch: facts.lineCompanyMismatch,
        maxLinesOneNote: facts.maxLinesOneNote,
        boundaryDate: facts.boundaryDate,
      }).toEqual({
        postedNotes: b.postedNotes,
        postedLines: b.postedLines,
        outstandingNotes: b.outstandingNotes,
        outstandingLines: b.outstandingLines,
        hiddenNotes: b.hiddenNotes,
        hiddenLines: b.hiddenLines,
        visibleNotes: b.visibleNotes,
        visibleLines: b.visibleLines,
        windowLines: b.windowLines,
        hiddenNotesMin: b.hiddenNotesMin,
        hiddenNotesMax: b.hiddenNotesMax,
        windowLinesMin: b.windowLinesMin,
        windowLinesMax: b.windowLinesMax,
        lineCompanyMismatch: b.lineCompanyMismatch,
        maxLinesOneNote: b.maxLinesOneNote,
        boundaryDate: b.boundaryDate,
      });
      // mig 0267's view and the line arithmetic are the same predicate.
      expect(facts.viewDisagreements).toBe(0);
      expect(row.company_code).toBe(company === 1 ? 'HOUZS' : '2990');
    }
  });

  test('a view that means something else is reported, not averaged away', async () => {
    await sql.unsafe(`
      CREATE OR REPLACE VIEW scm.v_grn_outstanding AS
      SELECT g.id, g.grn_number, g.supplier_id, g.received_at, g.status, g.created_at,
             (g.status = 'POSTED') AS is_outstanding, g.company_id
        FROM scm.grns g`);
    const { rows } = await measurePickerWindow(sql);
    for (const row of rows) {
      const b = brute(data, Number(row.company_id));
      expect(assessCompany(row).facts.viewDisagreements).toBe(b.notesWithoutUnbilled);
    }
  });

  test('with no view the comparison is ABSENT, and nothing else moves', async () => {
    await sql.unsafe('DROP VIEW scm.v_grn_outstanding');
    const { hasView, rows } = await measurePickerWindow(sql);
    expect(hasView).toBe(false);
    for (const row of rows) {
      const { facts } = assessCompany(row);
      expect(facts.viewDisagreements).toBeNull();
      expect(facts.hiddenNotesMin).toBe(brute(data, Number(row.company_id)).hiddenNotesMin);
    }
  });
});
