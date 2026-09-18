/* The planner behind merge-truncated-ac-codes.mjs.
 *
 * It re-keys sales-order lines and writes off stock, so every refusal below is a
 * case where acting would have moved something real, and each one is a test.
 * The pair census is pinned against the committed book files, because "nine
 * truncated codes" was measured on 2026-09-14 and a test is how that number
 * stays true instead of going stale in a comment.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readMappingCsv } from '../scripts/lib/ac-mapping-csv.mjs';
import {
  isTruncatedAcCode,
  truncatedPairs,
  duplicateCatalogueRows,
  planTruncatedCodeMerge,
} from '../scripts/lib/truncated-code-merge-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'scripts', 'data');

const K_TRUNC = 'DL-CS2 NN-WINTER SLEEP MATT (K';
const K_LONG = 'DUNLOPILLO COOLSILK 2.0 NANO-G WINTER SLEEP MATT (K)';
const Q_TRUNC = 'DL-CS2 NN-WINTER SLEEP MATT (Q';
const Q_LONG = 'DUNLOPILLO COOLSILK 2.0 NANO-G WINTER SLEEP MATT (Q)';
const SNAPSHOT = '2026-09-10T15:59:59.000Z';
const BEFORE = '2026-08-29T13:00:00.000Z';

const product = (code, over = {}) => ({ id: `p-${code}`, code, status: 'ACTIVE', category: 'MATTRESS', ...over });
const line = (i, code = K_TRUNC, over = {}) => ({ id: `l${i}`, docNo: `HC-SO-00000${i}`, itemCode: code, itemGroup: 'mattress', ...over });
const bal = (itemCode, warehouseCode, qty, over = {}) => ({ itemCode, warehouseCode, variantKey: '', qty, lastMovementAt: BEFORE, ...over });
const lot = (id, itemCode, warehouseCode, qtyRemaining, over = {}) => ({ id, itemCode, warehouseCode, variantKey: '', batchNo: null, qtyRemaining, unitCostSen: 189000, ...over });
const book = (entries) => new Map(entries);

const plan = (over) => planTruncatedCodeMerge({
  pairs: [{ acCode: K_TRUNC, survivorCode: K_LONG }],
  products: [product(K_TRUNC), product(K_LONG)],
  soLines: [],
  otherRefs: [],
  balances: [],
  lots: [],
  acBalance: book([]),
  snapshotAt: SNAPSHOT,
  ...over,
});

describe('isTruncatedAcCode - the 30-character cap cut inside a parenthesis', () => {
  it('is the Winter Sleep King code the owner searched for', () => {
    expect(K_TRUNC.length).toBe(30);
    expect(isTruncatedAcCode(K_TRUNC)).toBe(true);
  });
  it('is not the paren-closed name, a balanced 30-character code, or a short unbalanced one', () => {
    expect(isTruncatedAcCode(`${K_TRUNC})`)).toBe(false);
    expect(isTruncatedAcCode('DL-CS2 COOL EXTRA FIRM MATT(K)')).toBe(false);
    expect(isTruncatedAcCode('ABC (K')).toBe(false);
  });
});

describe('truncatedPairs - measured from the committed book, not typed', () => {
  const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, 'autocount-erp-mapping-1561.csv'), 'utf8'));
  const items = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'ac-live-item-master.json.gz'))).toString('utf8').replace(/^﻿/, ''));
  const { pairs, unmapped } = truncatedPairs(items.map((r) => r.ItemCode), mapping);

  it('finds the nine truncated book codes and a survivor for each', () => {
    expect(pairs.map((p) => p.acCode)).toEqual([
      'DL-CS2 NN-WINTER DREAM MATT (K',
      'DL-CS2 NN-WINTER DREAM MATT (Q',
      'DL-CS2 NN-WINTER FROST MATT (K',
      'DL-CS2 NN-WINTER FROST MATT (Q',
      K_TRUNC,
      Q_TRUNC,
      'HL-DT-GERALD 114/109 (900X1800',
      'HL-DT-LOFTUS 102/112 (800X1500',
      'HL-DT-LOFTUS 102/112 (900X1800',
    ]);
    expect(unmapped).toEqual([]);
  });
  it('sends the King to the long name the stock sits on', () => {
    expect(pairs.find((p) => p.acCode === K_TRUNC)?.survivorCode).toBe(K_LONG);
  });
  it('reports a truncated code the sheet is silent about instead of guessing one', () => {
    expect(truncatedPairs([K_TRUNC], new Map())).toEqual({ pairs: [], unmapped: [K_TRUNC] });
  });
});

describe('the King: lines on one code, stock on the other', () => {
  const r = plan({
    soLines: [1, 2, 3, 4, 5, 6].map((i) => line(i)),
    balances: [bal(K_TRUNC, 'PG WAREHOUSE', 0), bal(K_LONG, 'PG WAREHOUSE', 2)],
    lots: [lot('long-1', K_LONG, 'PG WAREHOUSE', 2)],
    acBalance: book([[`${K_LONG}|PG WAREHOUSE`, 2]]),
  });
  const [p] = r.pairs;

  it('re-keys all six lines and retires the empty row without writing anything off', () => {
    expect(p.refusals).toEqual([]);
    expect(p.rekey.map((x) => x.id)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
    expect(p.writeOffs).toEqual([]);
    expect(p.retireInLines).toBe(true);
    expect(p.retireInWriteoff).toBe(false);
    expect(r.totals).toMatchObject({ linesToRekey: 6, unitsToWriteOff: 0, writeOffValueSen: 0, retireInLines: 1 });
  });
});

describe('the Queen: a display unit counted on both codes', () => {
  const r = planTruncatedCodeMerge({
    pairs: [{ acCode: Q_TRUNC, survivorCode: Q_LONG }],
    products: [product(Q_TRUNC), product(Q_LONG)],
    soLines: [],
    otherRefs: [],
    balances: [bal(Q_TRUNC, 'PG DISPLAY', 1), bal(Q_LONG, 'PG DISPLAY', 1), bal(Q_LONG, 'PG WAREHOUSE', 4)],
    lots: [lot('trunc-disp', Q_TRUNC, 'PG DISPLAY', 1)],
    acBalance: book([[`${Q_LONG}|PG DISPLAY`, 1], [`${Q_LONG}|PG WAREHOUSE`, 4]]),
    snapshotAt: SNAPSHOT,
  });
  const [p] = r.pairs;

  it('writes off the unit on the truncated code, at its cost, and retires the row in that part', () => {
    expect(p.refusals).toEqual([]);
    expect(p.writeOffs).toEqual([expect.objectContaining({ lotId: 'trunc-disp', warehouseCode: 'PG DISPLAY', qty: 1, unitCostSen: 189000 })]);
    expect(p.retireInLines).toBe(false);
    expect(p.retireInWriteoff).toBe(true);
    expect(r.totals).toMatchObject({ unitsToWriteOff: 1, writeOffValueSen: 189000, retireInWriteoff: 1 });
  });
});

describe('refusals - each empties the whole pair', () => {
  const kingLines = [line(1), line(2)];

  it('real units that must MOVE are reported and not written off', () => {
    const r = plan({
      soLines: kingLines,
      balances: [bal(K_TRUNC, 'PG WAREHOUSE', 2), bal(K_LONG, 'PG WAREHOUSE', 0)],
      lots: [lot('t', K_TRUNC, 'PG WAREHOUSE', 2)],
      acBalance: book([[`${K_LONG}|PG WAREHOUSE`, 2]]),
    });
    const [p] = r.pairs;
    expect(p.moves).toEqual([{ warehouseCode: 'PG WAREHOUSE', qty: 2 }]);
    expect(p.writeOffs).toEqual([]);
    expect(p.rekey).toEqual([]);
    expect(p.retireInLines || p.retireInWriteoff).toBe(false);
    expect(r.totals.refused).toBe(1);
  });

  it('a balance that is neither a double count nor a move', () => {
    const [p] = plan({
      balances: [bal(K_TRUNC, 'PG WAREHOUSE', 1), bal(K_LONG, 'PG WAREHOUSE', 3)],
      lots: [lot('t', K_TRUNC, 'PG WAREHOUSE', 1)],
      acBalance: book([[`${K_LONG}|PG WAREHOUSE`, 2]]),
    }).pairs;
    expect(p.refusals.join()).toMatch(/neither a double count nor a move/);
    expect(p.writeOffs).toEqual([]);
  });

  it('the two ledgers disagree on the truncated code', () => {
    const [p] = plan({
      soLines: kingLines,
      balances: [bal(K_TRUNC, 'PG DISPLAY', 1)],
      lots: [],
    }).pairs;
    expect(p.refusals.join()).toMatch(/movement ledger says 1 and the lots say 0/);
    expect(p.rekey).toEqual([]);
  });

  it('stock moved after the AutoCount snapshot', () => {
    const [p] = plan({
      balances: [bal(K_TRUNC, 'PG DISPLAY', 1), bal(K_LONG, 'PG DISPLAY', 1, { lastMovementAt: '2026-09-12T02:00:00.000Z' })],
      lots: [lot('t', K_TRUNC, 'PG DISPLAY', 1)],
      acBalance: book([[`${K_LONG}|PG DISPLAY`, 1]]),
    }).pairs;
    expect(p.refusals.join()).toMatch(/moved after the AutoCount snapshot/);
    expect(p.writeOffs).toEqual([]);
  });

  it('a document other than a sales order still carries the truncated code', () => {
    const [p] = plan({
      soLines: kingLines,
      otherRefs: [{ itemCode: K_TRUNC, table: 'purchase_order_items', rows: 1 }],
    }).pairs;
    expect(p.refusals.join()).toMatch(/scm\.purchase_order_items/);
    expect(p.rekey).toEqual([]);
  });

  it('the survivor is missing or switched off', () => {
    expect(plan({ products: [product(K_TRUNC)] }).pairs[0].refusals.join()).toMatch(/not in the catalogue/);
    expect(plan({ products: [product(K_TRUNC), product(K_LONG, { status: 'INACTIVE' })] }).pairs[0].refusals.join()).toMatch(/INACTIVE, not ACTIVE/);
  });

  it('a line whose group is not the survivor category', () => {
    const [p] = plan({ soLines: [line(1, K_TRUNC, { itemGroup: 'bedframe' })] }).pairs;
    expect(p.refusals.join()).toMatch(/group "bedframe"/);
  });

  it('a lot with no variant key cannot be aimed at', () => {
    const [p] = plan({
      balances: [bal(K_TRUNC, 'PG DISPLAY', 1), bal(K_LONG, 'PG DISPLAY', 1)],
      lots: [lot('t', K_TRUNC, 'PG DISPLAY', 1, { variantKey: null })],
      acBalance: book([[`${K_LONG}|PG DISPLAY`, 1]]),
    }).pairs;
    expect(p.refusals.join()).toMatch(/no variant key/);
  });
});

describe('a row already switched off is not retired twice', () => {
  it('re-keys its lines and plans no retirement', () => {
    const [p] = plan({ products: [product(K_TRUNC, { status: 'INACTIVE' }), product(K_LONG)], soLines: [line(1)] }).pairs;
    expect(p.rekey).toHaveLength(1);
    expect(p.retireInLines).toBe(false);
    expect(p.retireInWriteoff).toBe(false);
  });
});

describe('duplicateCatalogueRows - one product under two codes', () => {
  const mapping = readMappingCsv([
    'ac_code,erp_code,status,category,supplier',
    `${K_TRUNC},${K_LONG},EXISTS(1st-pass),MATTRESS,400-D001`,
    'DL-CS2 COOL FRESH (K),DUNLOPILLO CS2 COOL FRESH MATT (K),EXISTS,MATTRESS,400-D001',
    'JAGER-(Q),JAGER-(Q),EXISTS,BEDFRAME,400-O002',
  ].join('\n'));

  it('lists a book-coded row whose survivor also exists, and flags truncation', () => {
    const rows = duplicateCatalogueRows(mapping, [
      product(K_TRUNC), product(K_LONG),
      product('DL-CS2 COOL FRESH (K)'),
      product('JAGER-(Q)'),
    ]);
    expect(rows).toEqual([
      { bookCode: K_TRUNC, bookStatus: 'ACTIVE', survivorCode: K_LONG, survivorStatus: 'ACTIVE', truncated: true },
    ]);
  });
});
