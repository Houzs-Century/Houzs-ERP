/* The plan behind set-opening-bill-places.mjs (owner 2026-11-25, 「要，做 A」):
   KEY>PLACE pairs read (an account, @category, - to clear); every supplier,
   bill, account and category checked against the company; a place already
   held is no change (RE-RUN: inert); the re-read's shape check. Made-up codes. */
import { describe, expect, test } from 'vitest';
import { parsePairs, placeText, planFor, shapeProblems, visibleCategories } from '../scripts/lib/opening-bill-places-plan.mjs';

const CO = 2;
const facts = (over = {}) => ({
  supplierIdOf: new Map([['A001', 'sup-a'], ['B001', 'sup-b']]),
  billIdOf: new Map([['API-1', 'bill-1']]),
  accounts: new Map([['900-X001', { money: false, active: true }], ['310-0010', { money: true, active: true }], ['900-X009', { money: false, active: false }]]),
  categories: new Set(['cf:exh', 'cf:exh:lorry']),
  supplierPlaces: new Map([['sup-b', { account: '900-X001', category: null }]]),
  billPlaces: new Map(),
  ...over,
});

describe('opening bill places: the plan', () => {
  test('pairs: an account, a category, a clear; a malformed or repeated pair is refused', () => {
    expect(parsePairs('A001>900-X001, B001>@cf:exh:lorry,C001>-', 'SUPPLIERS')).toEqual({ ok: true, pairs: [
      { key: 'A001', place: { account: '900-X001', category: null } },
      { key: 'B001', place: { account: null, category: 'cf:exh:lorry' } },
      { key: 'C001', place: null },
    ] });
    expect(parsePairs('', 'BILLS')).toEqual({ ok: true, pairs: [] });
    expect(parsePairs('A001', 'SUPPLIERS').ok).toBe(false);
    expect(parsePairs('A001>', 'SUPPLIERS').ok).toBe(false);
    expect(parsePairs('A001>@', 'SUPPLIERS').ok).toBe(false);
    expect(parsePairs('A001>900-X001,A001>@cf:exh', 'SUPPLIERS').ok).toBe(false);
  });

  test('the categories this company prints: an unticked one and all under it left out', () => {
    const tree = { version: 1, blocks: { accounts: [
      { kind: 'category', id: 'cf:out', label: 'OUT', flow: 'out', children: [
        { kind: 'category', id: 'cf:exh', label: 'EXH', children: [{ kind: 'category', id: 'cf:exh:lorry', label: 'LORRY', children: [] }] },
        { kind: 'category', id: 'cf:hid', label: 'HID', hiddenFor: [CO], children: [{ kind: 'category', id: 'cf:hid:sub', label: 'SUB', children: [] }] },
      ] },
      { kind: 'subtotal', id: 'cf:sub', label: 'SUBTOTAL' },
    ] } };
    expect([...visibleCategories(tree, CO)]).toEqual(['cf:out', 'cf:exh', 'cf:exh:lorry']);
    expect(visibleCategories(null, CO).size).toBe(0);
  });

  test('changes from what is held to what is asked; one already held is no change', () => {
    const plan = planFor({
      suppliers: [{ key: 'A001', place: { account: null, category: 'cf:exh' } }, { key: 'B001', place: { account: '900-X001', category: null } }],
      bills: [{ key: 'API-1', place: { account: '900-X001', category: null } }],
    }, facts());
    expect(plan.refused).toEqual([]);
    expect(plan.changes).toEqual([
      { kind: 'supplier', key: 'A001', id: 'sup-a', from: null, to: { account: null, category: 'cf:exh' } },
      { kind: 'bill', key: 'API-1', id: 'bill-1', from: null, to: { account: '900-X001', category: null } },
    ]);
    const clear = planFor({ suppliers: [{ key: 'B001', place: null }], bills: [] }, facts());
    expect(clear.changes).toEqual([{ kind: 'supplier', key: 'B001', id: 'sup-b', from: { account: '900-X001', category: null }, to: null }]);
  });

  test('refused: a supplier with no opening bill, a bill that is not one, a bank, a retired account, a category it does not print', () => {
    const plan = planFor({
      suppliers: [{ key: 'Z999', place: { account: '900-X001', category: null } }, { key: 'A001', place: { account: '310-0010', category: null } }, { key: 'B001', place: { account: null, category: 'cf:nowhere' } }],
      bills: [{ key: 'API-9', place: null }, { key: 'API-1', place: { account: '900-X009', category: null } }],
    }, facts());
    expect(plan.refused).toEqual([
      'supplier Z999: no supplier of this company with that code has an opening bill',
      'supplier A001: 310-0010 is a bank or cash account',
      'supplier B001: @cf:nowhere is not on this company\'s Cash Flow',
      'bill API-9: not an opening bill of this company',
      'bill API-1: 900-X009 is not an active account of this company',
    ]);
  });

  test('the re-read: each change landed, each row one place of the company', () => {
    const changes = [{ kind: 'supplier', key: 'A001', id: 'sup-a', from: null, to: { account: null, category: 'cf:exh' } }];
    const good = { suppliers: new Map([['sup-a', { account: null, category: 'cf:exh' }]]), bills: new Map() };
    expect(shapeProblems(changes, good, facts())).toEqual([]);
    const missed = { suppliers: new Map(), bills: new Map([['bill-1', { account: '999-9999', category: null }]]) };
    expect(shapeProblems(changes, missed, facts())).toEqual([
      'supplier A001 holds (none), planned @cf:exh',
      'bill bill-1 holds 999-9999, not an account of this company',
    ]);
    expect(placeText({ account: '900-X001', category: null })).toBe('900-X001');
  });
});
