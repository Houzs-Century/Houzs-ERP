/* EXECUTES the statements behind `scripts/check-so-amendment-bound-po-reads.mjs`
 * against real Postgres and compares every figure with a brute force computed
 * here, in TypeScript, by walking the handler's own three steps over the rows the
 * fixture inserted.
 *
 * WHY. The check is a `workflow_dispatch` workflow over production's DATABASE_URL.
 * It cannot be dispatched until it is on main, and there is no local database, so
 * without this suite its first contact with a Postgres parser would be production
 * (probeTransferCensusSql.pg.test.ts records a probe that died on its first
 * dispatch for exactly that reason). This one leans on Postgres-only syntax
 * (`FILTER`, `<> ALL(text[])`, `array_agg … ORDER BY`, `IS DISTINCT FROM`,
 * `pg_index.indkey[0]`), and the script runs it inside a READ ONLY transaction —
 * so does this suite, which is what proves it never writes.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ASSUMED_ROW_CEILING,
  CLOSED_STATUSES,
  LIST_WINDOW,
  assessCompany,
  assessScope,
  measureBoundPoReads,
} from '../scripts/lib/so-amendment-bound-po-reads.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

type Amendment = { id: string; company_id: number | null; so_doc_no: string; lane: string | null; status: string; created_at: string };
type Order = { doc_no: string; company_id: number };
type Line = { id: string; doc_no: string; company_id: number | null };
type PoLine = { id: string; purchase_order_id: string; so_item_id: string; company_id: number };
type Po = { id: string; po_number: string; company_id: number };

/* Deterministic, so a failure reproduces. */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const DAY = 86_400_000;
const NOW = Date.now();
const LANES = ['LINES', 'LINES', 'DELIVERY', null] as const;
const STATUSES = ['REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'REJECTED'] as const;

function fixture() {
  const rnd = lcg(11);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const amendments: Amendment[] = [];
  const orders: Order[] = [];
  const lines: Line[] = [];
  const poLines: PoLine[] = [];
  const pos: Po[] = [];
  let seq = 0;

  const addOrder = (company: number, docNo: string, lineCount: number) => {
    orders.push({ doc_no: docNo, company_id: company });
    const ids: string[] = [];
    for (let k = 0; k < lineCount; k++) {
      const id = uuid(++seq);
      lines.push({ id, doc_no: docNo, company_id: company });
      ids.push(id);
    }
    return ids;
  };
  const addPo = (company: number, boundLines: string[]) => {
    const id = uuid(++seq);
    pos.push({ id, po_number: `PO-${seq}`, company_id: company });
    for (const so_item_id of boundLines) poLines.push({ id: uuid(++seq), purchase_order_id: id, so_item_id, company_id: company });
    return id;
  };

  // Company 1: past the 500-row page, and past the assumed row ceiling on read A.
  const c1Orders: string[][] = [];
  for (let k = 0; k < 400; k++) c1Orders.push(addOrder(1, `HC-SO-${String(k).padStart(6, "0")}`, 3 + Math.floor(rnd() * 5)));
  // Two of every three orders are purchased, over POs of about five lines, some
  // of which span two orders so one PO serves both.
  let pending: string[] = [];
  c1Orders.forEach((ids, k) => {
    if (k % 3 === 2) return;
    pending.push(...ids);
    if (pending.length >= 5) { addPo(1, pending); pending = []; }
  });
  if (pending.length) addPo(1, pending);
  // 520 amendments over those orders, newest first by index. Rows 498..501 share
  // one timestamp, so the page edge is a real tie and only the id breaks it.
  for (let k = 0; k < 520; k++) {
    const at = k >= 498 && k <= 501 ? NOW - 498 * 3_600_000 : NOW - k * 3_600_000;
    amendments.push({
      id: uuid(++seq), company_id: 1,
      so_doc_no: `HC-SO-${String(Math.floor(rnd() * 400)).padStart(6, '0')}`,
      lane: pick(LANES), status: pick(STATUSES), created_at: new Date(at).toISOString(),
    });
  }

  // Company 2: well under the page, with the drift a company predicate would hide.
  const c2Orders: string[][] = [];
  for (let k = 0; k < 20; k++) c2Orders.push(addOrder(2, `2990-SO-${String(k).padStart(4, '0')}`, 2));
  c2Orders.slice(0, 10).forEach((ids) => addPo(2, ids));
  // An SO line of company 2 bound to a PO of company 1: the unscoped chain shows
  // company 1's PO in company 2's queue.
  addPo(1, [c2Orders[15]![0]!]);
  // A line of company 1's order stamped with company 2, and the newest amendment
  // of company 1 on that order, so the stamped line is on the page by construction.
  lines.push({ id: uuid(++seq), doc_no: 'HC-SO-000007', company_id: 2 });
  amendments.push({ id: uuid(++seq), company_id: 1, so_doc_no: 'HC-SO-000007', lane: 'LINES', status: 'REQUESTED', created_at: new Date(NOW).toISOString() });
  // A PO line whose PO row does not exist: read C is sent its id and returns nothing.
  poLines.push({ id: uuid(++seq), purchase_order_id: uuid(990_000), so_item_id: c2Orders[19]![0]!, company_id: 2 });
  for (let k = 0; k < 30; k++) {
    amendments.push({
      id: uuid(++seq), company_id: 2, so_doc_no: `2990-SO-${String(k % 20).padStart(4, '0')}`,
      lane: pick(LANES), status: pick(STATUSES),
      // Some inside the last 30 days, some well outside it — never near the edge.
      created_at: new Date(NOW - (k % 2 === 0 ? 5 : 90) * DAY - k * 60_000).toISOString(),
    });
  }
  // An amendment filed under company 2 against company 1's order.
  amendments.push({ id: uuid(++seq), company_id: 2, so_doc_no: 'HC-SO-000003', lane: 'LINES', status: 'REQUESTED', created_at: new Date(NOW - 2 * DAY).toISOString() });
  // Amendments with no company: never on any page, counted on their own.
  for (let k = 0; k < 3; k++) {
    amendments.push({ id: uuid(++seq), company_id: null, so_doc_no: 'HC-SO-000001', lane: 'LINES', status: 'REQUESTED', created_at: new Date(NOW).toISOString() });
  }
  return { amendments, orders, lines, poLines, pos };
}

/* The brute force: the handler's steps, in order, over plain arrays. */
function brute(data: ReturnType<typeof fixture>, company: number) {
  const all = data.amendments.filter((a) => a.company_id === company);
  const page = [...all]
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : (a.created_at < b.created_at ? 1 : -1)))
    .slice(0, LIST_WINDOW);
  const docs = [...new Set(page.map((a) => a.so_doc_no))];
  const docSet = new Set(docs);
  const lines = data.lines.filter((l) => docSet.has(l.doc_no));                 // read A
  const lineDoc = new Map(lines.map((l) => [l.id, l.doc_no]));
  const poLines = data.poLines.filter((p) => lineDoc.has(p.so_item_id));        // read B
  const poList = [...new Set(poLines.map((p) => p.purchase_order_id))];
  const poById = new Map(data.pos.map((p) => [p.id, p]));
  const pos = poList.map((id) => poById.get(id)).filter((p): p is Po => !!p);   // read C
  const boundBySo = new Map<string, Po[]>();
  for (const p of poLines) {
    const po = poById.get(p.purchase_order_id);
    if (!po) continue;
    const doc = lineDoc.get(p.so_item_id)!;
    boundBySo.set(doc, [...(boundBySo.get(doc) ?? []), po]);
  }
  const perDoc = new Map<string, number>();
  for (const l of lines) perDoc.set(l.doc_no, (perDoc.get(l.doc_no) ?? 0) + 1);
  const inQueue = (a: Amendment) => (boundBySo.get(a.so_doc_no)?.length ?? 0) > 0 && a.lane !== 'DELIVERY';
  return {
    amendmentsTotal: all.length,
    createdLast30Days: all.filter((a) => Date.parse(a.created_at) >= NOW - 30 * DAY).length,
    pageRows: page.length,
    pageDocs: docs.length,
    queueRows: page.filter(inQueue).length,
    queueRowsRequested: page.filter((a) => inQueue(a) && !CLOSED_STATUSES.includes(a.status)).length,
    pageRowsWithForeignPo: page.filter((a) => (boundBySo.get(a.so_doc_no) ?? []).some((po) => po.company_id !== company)).length,
    lineRows: lines.length,
    linesOtherCompany: lines.filter((l) => l.company_id !== company).length,
    maxLinesOneOrder: Math.max(0, ...perDoc.values()),
    poLineRows: poLines.length,
    poRows: pos.length,
    posOtherCompany: pos.filter((p) => p.company_id !== company).length,
    deliveryRowsWithBoundPo: page.filter((a) => a.lane === 'DELIVERY' && (boundBySo.get(a.so_doc_no)?.length ?? 0) > 0).length,
    docNos: [...docs].sort(),
    itemIds: lines.map((l) => l.id).sort(),
    poIds: [...poList].sort(),
  };
}

function bruteScope(data: ReturnType<typeof fixture>) {
  const orderCompany = new Map(data.orders.map((o) => [o.doc_no, o.company_id]));
  const lineCompanies = new Map<string, Set<string>>();
  for (const l of data.lines) {
    lineCompanies.set(l.doc_no, (lineCompanies.get(l.doc_no) ?? new Set()).add(String(l.company_id)));
  }
  const lineById = new Map(data.lines.map((l) => [l.id, l]));
  const poById = new Map(data.pos.map((p) => [p.id, p]));
  return {
    orderDocNosDuplicated: 0,
    lineDocNosInTwoCompanies: [...lineCompanies.values()].filter((s) => s.size > 1).length,
    linesCompanyNotOrderCompany: data.lines.filter((l) => orderCompany.has(l.doc_no) && orderCompany.get(l.doc_no) !== l.company_id).length,
    poLinesBoundAcrossCompanies: data.poLines.filter((p) => {
      const line = lineById.get(p.so_item_id);
      const po = poById.get(p.purchase_order_id);
      return !!line && !!po && po.company_id !== line.company_id;
    }).length,
    // A company-less amendment is its own fact (amendmentsWithoutCompany), not this one.
    amendmentsCompanyNotOrderCompany: data.amendments.filter((a) =>
      a.company_id != null && orderCompany.has(a.so_doc_no) && orderCompany.get(a.so_doc_no) !== a.company_id).length,
    amendmentsWithoutCompany: data.amendments.filter((a) => a.company_id == null).length,
  };
}

let sql: Sql;
const data = fixture();

async function inBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
}

async function resetSchema(db: Sql) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  /* Targeted drops rather than DROP SCHEMA: other suites keep their own objects
     in scm. No foreign keys: other suites drop these tables in their own order,
     and a constraint left behind here would fail them. */
  await db.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.so_amendments CASCADE;
    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;
    DROP TABLE IF EXISTS scm.purchase_orders CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_orders CASCADE;
    DO $$ BEGIN CREATE TYPE scm.so_amendment_status AS ENUM ('REQUESTED','SUPPLIER_PENDING','SO_APPROVED','PO_APPROVED','SENT','REJECTED');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    -- The widest shape any pg suite gives this table, because the suites share
    -- one database and run in cache order: a narrower table left here failed
    -- probeTransferCensusSql's insert of name and is_active (CI run 34948309132).
    -- The insert below uses the two columns every suite's shape has.
    CREATE TABLE IF NOT EXISTS public.companies (id bigint PRIMARY KEY, code text, name text, is_active int);
    INSERT INTO public.companies (id, code) VALUES (1, 'HOUZS'), (2, '2990') ON CONFLICT (id) DO NOTHING;

    CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, company_id bigint);
    CREATE TABLE scm.mfg_sales_order_items (id uuid PRIMARY KEY, doc_no text NOT NULL, company_id bigint);
    CREATE TABLE scm.purchase_orders (id uuid PRIMARY KEY, po_number text NOT NULL, company_id bigint);
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY, purchase_order_id uuid NOT NULL, so_item_id uuid, company_id bigint
    );
    CREATE TABLE scm.so_amendments (
      id uuid PRIMARY KEY, so_doc_no text NOT NULL, company_id bigint, lane text,
      status scm.so_amendment_status NOT NULL, created_at timestamptz NOT NULL
    );
  `);
  await inBatches(data.orders, (b) => db`INSERT INTO scm.mfg_sales_orders ${db(b, 'doc_no', 'company_id')}`);
  await inBatches(data.lines, (b) => db`INSERT INTO scm.mfg_sales_order_items ${db(b, 'id', 'doc_no', 'company_id')}`);
  await inBatches(data.pos, (b) => db`INSERT INTO scm.purchase_orders ${db(b, 'id', 'po_number', 'company_id')}`);
  await inBatches(data.poLines, (b) => db`INSERT INTO scm.purchase_order_items ${db(b, 'id', 'purchase_order_id', 'so_item_id', 'company_id')}`);
  await inBatches(data.amendments, (b) => db`INSERT INTO scm.so_amendments ${db(b, 'id', 'so_doc_no', 'company_id', 'lane', 'status', 'created_at')}`);
}

describePg('check-so-amendment-bound-po-reads SQL, executed', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await resetSchema(sql);
  });
  /* Leave nothing behind: several suites build these tables in their own shapes. */
  afterAll(async () => {
    await sql?.unsafe(`
      DROP TABLE IF EXISTS scm.so_amendments;
      DROP TABLE IF EXISTS scm.purchase_order_items;
      DROP TABLE IF EXISTS scm.purchase_orders;
      DROP TABLE IF EXISTS scm.mfg_sales_order_items;
      DROP TABLE IF EXISTS scm.mfg_sales_orders;
    `);
    await sql?.end({ timeout: 5 });
  });

  const measureReadOnly = () => sql.begin('read only', (tx) => measureBoundPoReads(tx as unknown as Sql));

  test('the fixture exercises what is being measured', () => {
    const c1 = brute(data, 1);
    const c2 = brute(data, 2);
    expect(c1.amendmentsTotal).toBeGreaterThan(LIST_WINDOW);          // the page is full
    expect(c1.lineRows).toBeGreaterThan(ASSUMED_ROW_CEILING);         // read A is past the ceiling
    expect(c1.queueRows).toBeGreaterThan(c1.queueRowsRequested);      // closed statuses really filtered
    expect(c1.queueRowsRequested).toBeGreaterThan(0);
    expect(c1.linesOtherCompany).toBeGreaterThan(0);                  // the stamped line
    expect(c2.posOtherCompany).toBeGreaterThan(0);                    // company 1's POs in company 2's chain
    expect(c2.pageRowsWithForeignPo).toBeGreaterThan(0);
    expect(c2.poIds.length).toBe(c2.poRows + 1);                      // the dangling PO id is sent, not returned
    expect(c1.deliveryRowsWithBoundPo).toBeGreaterThan(0);            // the DELIVERY exclusion is not vacuous
  });

  test('every per-company figure matches the brute force, inside a READ ONLY transaction', async () => {
    const { companies } = await measureReadOnly();
    expect(companies.map((r: { company_id: string }) => Number(r.company_id))).toEqual([1, 2]);
    for (const row of companies) {
      const company = Number(row.company_id);
      const b = brute(data, company);
      const { facts } = assessCompany(row, { lines: null, poLines: null, pos: null, reference: null });
      expect({
        amendmentsTotal: facts.amendmentsTotal,
        createdLast30Days: facts.createdLast30Days,
        pageRows: facts.pageRows,
        pageDocs: facts.pageDocs,
        queueRows: facts.queueRows,
        queueRowsRequested: facts.queueRowsRequested,
        pageRowsWithForeignPo: facts.pageRowsWithForeignPo,
        lineRows: facts.lineRows,
        linesOtherCompany: facts.linesOtherCompany,
        maxLinesOneOrder: facts.maxLinesOneOrder,
        poLineRows: facts.poLineRows,
        poRows: facts.poRows,
        posOtherCompany: facts.posOtherCompany,
      }).toEqual({
        amendmentsTotal: b.amendmentsTotal,
        createdLast30Days: b.createdLast30Days,
        pageRows: b.pageRows,
        pageDocs: b.pageDocs,
        queueRows: b.queueRows,
        queueRowsRequested: b.queueRowsRequested,
        pageRowsWithForeignPo: b.pageRowsWithForeignPo,
        lineRows: b.lineRows,
        linesOtherCompany: b.linesOtherCompany,
        maxLinesOneOrder: b.maxLinesOneOrder,
        poLineRows: b.poLineRows,
        poRows: b.poRows,
        posOtherCompany: b.posOtherCompany,
      });
    }
  });

  test('the lists the request sizes are built from are exactly the handler\'s lists', async () => {
    const { companies } = await measureReadOnly();
    for (const row of companies) {
      const b = brute(data, Number(row.company_id));
      expect([...row.doc_nos].sort()).toEqual(b.docNos);
      expect([...row.item_ids].sort()).toEqual(b.itemIds);
      expect([...row.po_ids].sort()).toEqual(b.poIds);
    }
  });

  test('the verdicts follow the executed figures', async () => {
    const { companies } = await measureReadOnly();
    const kinds = (company: number) => {
      const row = companies.find((r: { company_id: string }) => Number(r.company_id) === company);
      return assessCompany(row, { lines: 100, poLines: 100, pos: 100, reference: 100 }).verdicts.map((v) => v.kind);
    };
    expect(kinds(1)).toContain('ROW_CEILING_EXCEEDED');
    expect(kinds(1)).toContain('CROSS_COMPANY');
    expect(kinds(2)).toContain('CROSS_COMPANY');
    expect(kinds(2)).not.toContain('ROW_CEILING_EXCEEDED');
  });

  test('whole-table company facts match the brute force, and the unique index is seen', async () => {
    const { scope } = await measureReadOnly();
    const { facts, verdicts } = assessScope(scope);
    expect(facts.orderDocNoUniqueIndex).toBe(true);
    const b = bruteScope(data);
    expect({
      orderDocNosDuplicated: facts.orderDocNosDuplicated,
      lineDocNosInTwoCompanies: facts.lineDocNosInTwoCompanies,
      linesCompanyNotOrderCompany: facts.linesCompanyNotOrderCompany,
      poLinesBoundAcrossCompanies: facts.poLinesBoundAcrossCompanies,
      amendmentsCompanyNotOrderCompany: facts.amendmentsCompanyNotOrderCompany,
      amendmentsWithoutCompany: facts.amendmentsWithoutCompany,
    }).toEqual(b);
    expect(b.poLinesBoundAcrossCompanies).toBe(1);
    expect(b.amendmentsCompanyNotOrderCompany).toBe(1);
    expect(verdicts.map((v) => v.kind)).toEqual(['DOC_NO_COLLISION', 'COMPANY_DRIFT']);
  });

  /* The other direction: a checker that can only say "unique" proves nothing. */
  test('without the unique index, and with a duplicate SO number, both are reported', async () => {
    await sql.unsafe(`
      ALTER TABLE scm.mfg_sales_orders DROP CONSTRAINT mfg_sales_orders_pkey;
      INSERT INTO scm.mfg_sales_orders (doc_no, company_id) VALUES ('HC-SO-000009', 2);
    `);
    const { scope } = await measureReadOnly();
    const { facts, verdicts } = assessScope(scope);
    expect(facts.orderDocNoUniqueIndex).toBe(false);
    expect(facts.orderDocNosDuplicated).toBe(1);
    expect(verdicts.map((v) => v.kind)).toContain('DOC_NO_NOT_UNIQUE_BY_INDEX');
  });
});
