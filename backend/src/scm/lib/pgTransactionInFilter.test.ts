/* An approved AMENDMENT must reach AutoCount — asserted through the SAME
 * transport the approve routes hand to enqueueEdit.
 *
 * WHY IT EXISTS. docs/bugs/0888. Both approve routes (so-amendments.ts
 * approveSoCommandHandler, po-amendments.ts approvePoAmendmentHandler) run
 * inside runScmPgCommand and pass ITS client — pgTransactionSupabase, a
 * PostgREST-shaped builder over one postgres.js transaction — to enqueueEdit.
 * #3545 (2026-09-10) moved readMfgProductBindings onto
 * `.filter('item_code', 'in', pgrestInList(batch))`, and that shim's filter()
 * knew six operators and not `in`: it THREW, enqueueEdit's catch handed a plain
 * Error to noteReadFailure, and noteReadFailure returned early for anything that
 * was not a named refusal. No row, no log line. Measured on production (run
 * 34819514473): 12/12 SO and 9/9 PO amendments approved before that deploy
 * queued their edit; 0/32 and 0/15 after it.
 *
 * Every existing enqueueEdit test uses fake-postgrest, whose filter() DOES
 * implement `in` — which is exactly why the suite stayed green. This file drives
 * the real shim over a minimal in-memory SQL executor instead.
 */
import { describe, expect, test, beforeEach } from 'vitest';
import { pgTransactionSupabase } from './pg-supabase-transaction';
import { enqueueEdit } from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';

type Row = Record<string, unknown>;

/** Just enough of postgres.js for the statements pgTransactionSupabase emits.
 *  An operator it does not recognise THROWS — a fake that matched everything
 *  would pass this file for the wrong reason. */
function fakeSql(tables: Record<string, Row[]>) {
  const statements: string[] = [];
  const val = (token: string, values: unknown[]) => values[Number(token.slice(1)) - 1];
  const matches = (row: Row, clause: string, values: unknown[]): boolean => {
    let m: RegExpMatchArray | null;
    if (clause === 'FALSE') return false;
    if ((m = clause.match(/^"(\w+)" = (\$\d+)$/))) return String(row[m[1]!]) === String(val(m[2]!, values));
    if ((m = clause.match(/^"(\w+)" <> (\$\d+)$/))) return String(row[m[1]!]) !== String(val(m[2]!, values));
    if ((m = clause.match(/^"(\w+)" IS NULL$/))) return row[m[1]!] == null;
    if ((m = clause.match(/^"(\w+)" IS NOT NULL$/))) return row[m[1]!] != null;
    if ((m = clause.match(/^"(\w+)" IN \((.+)\)$/))) {
      const wanted = m[2]!.split(',').map((t) => String(val(t.trim(), values)));
      return wanted.includes(String(row[m[1]!]));
    }
    throw new Error(`fakeSql: unsupported predicate ${clause}`);
  };
  const unsafe = async (text: string, values: unknown[] = []): Promise<Row[]> => {
    statements.push(text);
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(text)) return [];
    let m = text.match(/^SELECT .+? FROM scm\."(\w+)"(?: WHERE (.+?))?(?: ORDER BY .+?)?(?: LIMIT (\$\d+))?(?: OFFSET (\$\d+))?$/);
    if (m) {
      const clauses = m[2] ? m[2].split(' AND ') : [];
      let rows = (tables[m[1]!] ?? []).filter((r) => clauses.every((c) => matches(r, c, values)));
      const offset = m[4] ? Number(val(m[4], values)) : 0;
      const limit = m[3] ? Number(val(m[3], values)) : Infinity;
      rows = rows.slice(offset, offset + limit);
      return text.includes('count(*)::bigint AS count') ? [{ count: rows.length }] : rows;
    }
    m = text.match(/^INSERT INTO scm\."(\w+)" \((.+?)\) VALUES \((.+?)\) RETURNING/);
    if (m) {
      const cols = m[2]!.split(', ').map((c) => c.replace(/"/g, ''));
      const toks = m[3]!.split(', ');
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = toks[i] === 'DEFAULT' ? null : val(toks[i]!, values); });
      (tables[m[1]!] ??= []).push(row);
      return [row];
    }
    throw new Error(`fakeSql: unsupported statement ${text}`);
  };
  const sql = { unsafe, json: (v: unknown) => v, typed: (v: unknown) => v };
  return { sql, statements, tables };
}

type FakeSql = ReturnType<typeof fakeSql>['sql'];
type TxClient = ReturnType<typeof pgTransactionSupabase>;
type EnqueueClient = Parameters<typeof enqueueEdit>[0];
// eslint-disable-next-line no-restricted-syntax -- a test double for postgres.js Sql: the shim calls only unsafe / json / typed, which FakeSql implements
const txOver = (sql: FakeSql): TxClient => pgTransactionSupabase(sql as never);
// eslint-disable-next-line no-restricted-syntax -- the approve routes hand this exact client to enqueueEdit through an `any`; the cast restates that, it does not widen it
const forEnqueue = (tx: TxClient): EnqueueClient => tx as never;

const PO_ID = 'po-064';
const world = () => fakeSql({
  app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
  autocount_outbox: [],
  purchase_orders: [{
    id: PO_ID, company_id: 1, po_number: 'HC-PO-2609-064', po_date: '2026-09-11',
    supplier_id: 'sup-1', notes: null, purchase_location_id: null, linked_ac_docno: 'HC-PO-2609-064',
  }],
  suppliers: [{ id: 'sup-1', code: '400-H001', name: 'HOOKKA MANUFACTURING' }],
  purchase_order_items: [{
    id: 'poi-1', purchase_order_id: PO_ID, item_code: 'AKEMI APEX MATT (SP)', item_group: null,
    description: 'M', description2: null, qty: 1, unit_price_sen: 100, variants: null,
    linked_ac_dtlkey: 991, warehouse_id: null, delivery_date: null, photo_urls: null,
    created_at: '2026-09-11T00:00:00Z',
  }],
  supplier_material_bindings: [{
    id: 'b1', company_id: 1, material_kind: 'mfg_product', item_code: 'AKEMI APEX MATT (SP)',
    supplier_id: 'sup-1', supplier_sku: 'AK-APEX MATT (SP)', ac_item_code: null, is_main_supplier: true,
  }],
});

beforeEach(() => resetWritebackFlagCache());

describe('pgTransactionSupabase .filter(col, "in", list)', () => {
  test('compiles the escaped PostgREST in-list to IN, one parameter per value', async () => {
    const { sql, statements } = world();
    const sb = txOver(sql);
    const { data } = await sb.from('supplier_material_bindings')
      .select('item_code')
      .filter('item_code', 'in', '("AKEMI APEX MATT (SP)","DUNLOPILLO 5\\" MATT")');
    expect((data as Row[]).map((r) => r.item_code)).toEqual(['AKEMI APEX MATT (SP)']);
    expect(statements.find((s) => s.startsWith('SELECT'))).toContain('"item_code" IN ($1, $2)');
  });

  test('an empty list matches nothing rather than every row', async () => {
    const { sql } = world();
    const { data } = await txOver(sql)
      .from('supplier_material_bindings').select('item_code').filter('item_code', 'in', '()');
    expect(data).toEqual([]);
  });
});

describe('an amendment approve queues its AutoCount edit through the transaction client', () => {
  test('PO: enqueueEdit over pgTransactionSupabase writes a pending edit', async () => {
    const { sql, tables } = world();
    const sb = txOver(sql);
    const queued = await enqueueEdit(forEnqueue(sb), { companyId: 1, docType: 'PO', docId: PO_ID, docNo: 'HC-PO-2609-064' });
    const rows = tables.autocount_outbox as Row[];
    expect(rows.map((r) => `${r.op}/${r.status}/${r.last_error ?? ''}`)).toEqual(['edit/pending/']);
    expect(queued).toBe(true);
  });

  test('SO: enqueueEdit over pgTransactionSupabase writes a pending edit', async () => {
    const { sql, tables } = world();
    Object.assign(tables, {
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_order_payments: [],
      mfg_sales_orders: [{
        doc_no: 'HC-SO-013497', company_id: 1, so_date: '2026-09-01', debtor_name: 'ACME', agent: null,
        salesperson_id: 'staff-1', sales_location: 'KL', branding: null, venue: null,
        address1: null, address2: null, address3: null, address4: null, city: null, postcode: null,
        customer_state: null, phone: null, emergency_contact_phone: null, ref: null, customer_so_no: null,
        processing_date: null, customer_delivery_date: null, total_revenue_sen: 0, local_total_sen: 0,
        deposit_sen: 0, linked_ac_docno: 'SO-013497',
      }],
      mfg_sales_order_items: [{
        id: 'soi-1', doc_no: 'HC-SO-013497', item_code: 'AKEMI APEX MATT (SP)', item_group: null, branding: null,
        description: 'M', description2: null, qty: 1, unit_price_sen: 100, variants: null, linked_ac_dtlkey: 881,
        cancelled: false, warehouse_id: null, line_delivery_date: null, photo_urls: null, created_at: '2026-09-01T00:00:00Z',
      }],
    });
    const sb = txOver(sql);
    const queued = await enqueueEdit(forEnqueue(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-013497' });
    expect((tables.autocount_outbox as Row[]).map((r) => `${r.op}/${r.status}/${r.last_error ?? ''}`)).toEqual(['edit/pending/']);
    expect(queued).toBe(true);
  });

  test('an UNEXPECTED error in the compose is written down, never dropped without a trace', async () => {
    /* The second half of 0888: the shim turns any statement failure into a
       plain Error, and noteReadFailure used to return early for everything
       that was not a named refusal or an AcReadError — so four days of missed
       amendments left no row and no log. Provoked here by a statement the
       executor refuses, which reaches enqueueEdit exactly as the `in` did. */
    const w = world();
    const unsafe = w.sql.unsafe;
    w.sql.unsafe = async (text: string, values?: unknown[]) => {
      if (/FROM scm\."purchase_order_items"/.test(text)) throw new Error('boom: relation went away');
      return unsafe(text, values);
    };
    const sb = txOver(w.sql);
    expect(await enqueueEdit(forEnqueue(sb), { companyId: 1, docType: 'PO', docId: PO_ID, docNo: 'HC-PO-2609-064' })).toBe(false);
    const rows = w.tables.autocount_outbox as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: 'edit', status: 'skipped', doc_type: 'PO', doc_no: 'HC-PO-2609-064' });
    expect(String(rows[0].last_error)).toContain('compose failed, nothing sent');
    expect(String(rows[0].last_error)).toContain('boom: relation went away');
  });
});
