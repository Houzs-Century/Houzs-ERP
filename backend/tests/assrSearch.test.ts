import { env } from 'cloudflare:test';
import { describe, expect, test, beforeEach } from 'vitest';
import { listAssrCases } from '../src/services/assr';

// The Service Cases list SEARCH box must find a case by customer NAME, customer
// PHONE, or the linked SO REFERENCE (ref_no). Phones are stored separator-free
// (write path runs cleanPhone), so a dashed/spaced term must still match.

async function seed(id: number, name: string, phone: string, ref: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, customer_name, phone, ref_no)
     VALUES (?, ?, ?, 'pending_review', ?, ?, ?)`,
  )
    .bind(id, `ASSR/SRCH-${id}`, `SO-SRCH-${id}`, name, phone, ref)
    .run();
}

const ids = async (search: string): Promise<number[]> => {
  const r = await listAssrCases(env, { search });
  return (r.data as Array<{ id: number }>).map((x) => x.id).sort((a, b) => a - b);
};

beforeEach(async () => {
  // Multi-company shape (companies table + assr_cases.company_id) lives in the
  // Postgres migration tree, not the D1 test baseline — so re-create it here.
  // The join is a LEFT JOIN, so no company rows are required.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, code TEXT)`,
  );
  try {
    await env.DB.exec(`ALTER TABLE assr_cases ADD COLUMN company_id INTEGER`);
  } catch {
    // Column already added by a prior beforeEach in this suite — ignore.
  }
  await env.DB.exec(`DELETE FROM assr_cases`);
  await seed(1, 'Acme Corp', '60123456789', 'HC11422');
  await seed(2, 'Beta Holdings', '60198887777', 'HC99999');
});

describe('listAssrCases — search matches name / phone / reference', () => {
  test('customer name (partial, case-insensitive)', async () => {
    expect(await ids('acme')).toEqual([1]);
  });

  test('SO reference', async () => {
    expect(await ids('HC11422')).toEqual([1]);
    expect(await ids('hc99999')).toEqual([2]);
  });

  test('phone — exact stored digits', async () => {
    expect(await ids('60123456789')).toEqual([1]);
  });

  test('phone — local 0-prefixed form matches the stored 60… digits', async () => {
    expect(await ids('0123456789')).toEqual([1]);
  });

  test('phone — dashed/spaced term is normalised before matching', async () => {
    expect(await ids('012-345 6789')).toEqual([1]);
  });

  test('a term matching nothing returns no rows', async () => {
    expect(await ids('nomatch-xyz')).toEqual([]);
  });

  test('a supplier-return number (SVC-RTN) finds the case it belongs to', async () => {
    await env.DB.exec(`DELETE FROM assr_supplier_returns`);
    await env.DB.prepare(
      `INSERT INTO assr_supplier_returns (assr_id, round_no, ref_no) VALUES (2, 1, 'SVC-RTN-2609-0007')`,
    ).run();
    expect(await ids('SVC-RTN-2609-0007')).toEqual([2]);
    expect(await ids('svc-rtn-2609-0007')).toEqual([2]);
  });
});

describe('listAssrCases — search matches the DO numbers the DO No column shows', () => {
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM sales_orders`);
    await env.DB.exec(`DELETE FROM autocount_delivery_orders`);
  });

  test('a DO typed on the case itself', async () => {
    await env.DB.prepare(`UPDATE assr_cases SET delivery_order = 'DO-000041' WHERE id = 2`).run();
    expect(await ids('do-000041')).toEqual([2]);
  });

  test('the DO AutoCount transferred the SO to', async () => {
    await env.DB.prepare(
      `INSERT INTO sales_orders (doc_no, region, transfer_to) VALUES ('SO-SRCH-1', 'WEST', 'DO-000555')`,
    ).run();
    expect(await ids('DO-000555')).toEqual([1]);
  });

  test('a cancelled-transfer XS document is not a DO', async () => {
    await env.DB.prepare(
      `INSERT INTO sales_orders (doc_no, region, transfer_to) VALUES ('SO-SRCH-1', 'WEST', 'XS-000555')`,
    ).run();
    expect(await ids('XS-000555')).toEqual([]);
  });

  test('a mirrored AutoCount DO sharing the case reference', async () => {
    await env.DB.prepare(
      `INSERT INTO autocount_delivery_orders (doc_no, ref, cancelled) VALUES ('DO-000777', 'hc99999 ', 0)`,
    ).run();
    expect(await ids('DO-000777')).toEqual([2]);
  });

  test('a cancelled mirrored DO finds nothing', async () => {
    await env.DB.prepare(
      `INSERT INTO autocount_delivery_orders (doc_no, ref, cancelled) VALUES ('DO-000778', 'HC99999', 1)`,
    ).run();
    expect(await ids('DO-000778')).toEqual([]);
  });

  test('a placeholder reference does not glue a DO onto every case that shares it', async () => {
    await seed(3, 'Gamma Trading', '60111111111', '-');
    await env.DB.prepare(
      `INSERT INTO autocount_delivery_orders (doc_no, ref, cancelled) VALUES ('DO-000779', '-', 0)`,
    ).run();
    expect(await ids('DO-000779')).toEqual([]);
  });
});
