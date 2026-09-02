/* The pure half of redecode-collapsed-sofa-lines.mjs, under test.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. Each one is a defect this repository has
 * already paid for once:
 *
 *   the missing column   apply-sofa-compartment-corrections.mjs listed
 *                        `warehouse_id` on its purchase-order INSERT and not on
 *                        its sales-order one. Seven prod lines landed with a
 *                        NULL warehouse, matched no allocation bucket, and sat
 *                        at PENDING while their goods were in the right bin
 *                        (tests/sofaCorrectionsWarehouse.test.ts). Here the
 *                        column list is DISCOVERED, so the test asserts the
 *                        rule — copy everything, name every exception — rather
 *                        than a list somebody has to keep in their head.
 *   the money that moved every inserted piece carries 0 in every `%_sen`
 *                        column and the re-coded row's money is not written at
 *                        all, which is what makes the expansion free.
 *   the double-encoded   `$n::text::jsonb`, never `$n::jsonb`. Binding an
 *   jsonb                already-serialized string to a jsonb parameter is what
 *                        put seven prod rows into a shape every reader saw as
 *                        empty (docs/jsonb-double-encoding-coe.md).
 *   the silent overwrite a placeholder line is the line an operator is most
 *                        likely to have filled in by hand; the merge must not
 *                        delete that.
 */
import { describe, expect, test } from 'vitest';
import {
  COLOUR_KEYS, NEVER_CLONE, buildCloneInsert, compartmentOf, isPlaceholderLine,
  mergeVariants, modelOf, multiset, pieceCodes, planRow, quoteIdent, sameBuild, senColumns,
} from '../scripts/lib/redecode-sofa-plan.mjs';

const SO_COLUMNS = [
  'id', 'doc_no', 'line_no', 'item_group', 'item_code', 'description', 'description2',
  'uom', 'location', 'warehouse_id', 'qty', 'unit_price_sen', 'discount_sen', 'total_sen',
  'balance_sen', 'company_id', 'variants', 'custom_specials', 'remark', 'photo_urls',
  'line_delivery_date', 'linked_ac_dtlkey', 'cancelled', 'created_at', 'updated_at',
];

describe('placeholder identity', () => {
  test('BOTH halves are required — the marker AND the bare -1S', () => {
    expect(isPlaceholderLine({ itemCode: '8030-1S', remark: 'SOFA UNPARSED — 按图/原文补件: x' })).toBe(true);
    // a genuine one-seater is also -1S and is NOT a placeholder
    expect(isPlaceholderLine({ itemCode: '8030-1S', remark: 'sofa: no seat size' })).toBe(false);
    // a line somebody has already re-coded keeps the marker but is not one either
    expect(isPlaceholderLine({ itemCode: '8030-1A(LHF)', remark: 'SOFA UNPARSED — x' })).toBe(false);
    expect(isPlaceholderLine({ itemCode: '8030-1S', remark: null })).toBe(false);
  });

  test('a compartment that merely CONTAINS 1S is not the placeholder', () => {
    expect(isPlaceholderLine({ itemCode: '8030-1S(P)', remark: 'SOFA UNPARSED' })).toBe(false);
    expect(isPlaceholderLine({ itemCode: '8030-1S(R)', remark: 'SOFA UNPARSED' })).toBe(false);
  });
});

describe('model and compartment', () => {
  test('the AutoCount model alias is applied', () => {
    expect(modelOf('5537-1S', { 5537: '8030' })).toBe('8030');
    expect(modelOf('9058-1A(LHF)')).toBe('9058');
    expect(compartmentOf('9058-1A(LHF)')).toBe('1A(LHF)');
    expect(compartmentOf('9058')).toBe('');
  });

  test('pieceCodes does not double the model when the decode already carries it', () => {
    expect(pieceCodes('8030', ['1A(LHF)', 'CNR'])).toEqual(['8030-1A(LHF)', '8030-CNR']);
    expect(pieceCodes('8030', ['8030-1A(LHF)'])).toEqual(['8030-1A(LHF)']);
  });
});

describe('two documents describing one build', () => {
  test('ORDER is part of the answer — a sofa is a left-to-right layout', () => {
    expect(sameBuild(['1A(LHF)', 'CNR', '1NA'], ['1A(LHF)', 'CNR', '1NA'])).toBe(true);
    expect(sameBuild(['1A(LHF)', 'CNR', '1NA'], ['1NA', 'CNR', '1A(LHF)'])).toBe(false);
    expect(sameBuild(['1A(LHF)'], ['1A(LHF)', '1NA'])).toBe(false);
  });

  test('the verification asserts a MULTISET, because a SELECT has no plan order', () => {
    expect(multiset(['B', 'A', 'A'])).toBe('A x2 | B x1');
    expect(multiset(['A', 'A', 'B'])).toBe(multiset(['B', 'A', 'A']));
    expect(multiset(['A', 'B'])).not.toBe(multiset(['A', 'A', 'B']));
  });
});

describe('what happens to one collapsed row', () => {
  test('the FIRST piece re-codes the existing row; the rest are inserted', () => {
    const p = planRow({ currentCode: '8030-1S', targetCodes: ['8030-1A(LHF)', '8030-CNR', '8030-1A(RHF)'] });
    expect(p).toEqual({ kind: 'expand', update: '8030-1A(LHF)', inserts: ['8030-CNR', '8030-1A(RHF)'] });
  });

  test('a decode that IS the piece the row already is changes nothing', () => {
    expect(planRow({ currentCode: '8069-1S', targetCodes: ['8069-1S'] })).toEqual({ kind: 'noop' });
  });

  test('a single piece that DIFFERS is still a re-code, with no inserts', () => {
    expect(planRow({ currentCode: '8069-1S', targetCodes: ['8069-1B(LHF)'] }))
      .toEqual({ kind: 'expand', update: '8069-1B(LHF)', inserts: [] });
  });

  test('an empty decode is refused, never treated as "nothing to do"', () => {
    expect(planRow({ currentCode: '8030-1S', targetCodes: [] }).kind).toBe('refuse');
  });
});

describe('the clone INSERT', () => {
  const insert = () => buildCloneInsert({
    table: 'scm.mfg_sales_order_items',
    columns: SO_COLUMNS,
    overrides: { item_code: null, description: null, variants: 'text::jsonb', remark: null },
    exprs: { line_no: '(SELECT COALESCE(MAX(x.line_no),0)+1 FROM scm.mfg_sales_order_items x WHERE x.doc_no = i.doc_no)' },
  });

  test('EVERY column is carried except the row identity and its clock', () => {
    const { text } = insert();
    for (const c of SO_COLUMNS) {
      if (NEVER_CLONE.includes(c)) {
        expect(text).not.toMatch(new RegExp(`"${c}"`));
      } else {
        expect(text).toMatch(new RegExp(`"${c}"`));
      }
    }
  });

  test('warehouse_id is COPIED — the column whose omission cost seven prod lines', () => {
    expect(insert().text).toContain('i."warehouse_id"');
  });

  test('every money column is 0 on an inserted piece, and there is more than one', () => {
    const money = senColumns(SO_COLUMNS);
    expect(money.length).toBeGreaterThan(1);
    const { select } = insert();
    for (const c of money) expect(select[c]).toBe('0');
    // and the non-money columns are genuinely COPIED, not zeroed by accident
    expect(select.qty).toBe('i."qty"');
    expect(select.company_id).toBe('i."company_id"');
  });

  test('jsonb arrives as ::text::jsonb — never as a bare ::jsonb parameter', () => {
    const { text, params } = insert();
    expect(text).toMatch(/\$\d+::text::jsonb/);
    expect(text).not.toMatch(/\$\d+::jsonb/);
    expect(params).toContain('variants');
  });

  test('$1 is the source row and the overrides start at $2, in params order', () => {
    const { text, params } = insert();
    expect(text).toContain('WHERE i.id = $1');
    params.forEach((_, i) => expect(text).toContain(`$${i + 2}`));
    expect(params).toEqual(['item_code', 'description', 'variants', 'remark']);
  });

  test('a raw expression wins over a copy — the next line number is not a parameter', () => {
    expect(insert().text).toContain('COALESCE(MAX(x.line_no),0)+1');
  });

  test('naming a column the table does not have is a THROW, not a silent drop', () => {
    expect(() => buildCloneInsert({
      table: 'scm.mfg_sales_order_items', columns: SO_COLUMNS, overrides: { warehouse: null },
    })).toThrow(/warehouse/);
    expect(() => buildCloneInsert({
      table: 'scm.mfg_sales_order_items', columns: SO_COLUMNS, exprs: { line_number: '1' },
    })).toThrow(/line_number/);
  });

  test('an empty column list is a THROW — an INSERT that copies nothing is broken, not clean', () => {
    expect(() => buildCloneInsert({ table: 'scm.x', columns: ['id'] })).toThrow(/no insertable columns/);
  });

  test('identifiers are quoted, so a column called "location" stays a column', () => {
    expect(quoteIdent('location')).toBe('"location"');
    expect(insert().text).toContain('i."location"');
  });
});

describe('merging the decoded variants onto what is already there', () => {
  test('a value a human already entered is never overwritten', () => {
    const out = mergeVariants(
      { seatHeight: 30, legHeight: '4"' },
      { seatHeight: 28, specials: [] },
      { colourResolved: false },
    );
    expect(out.seatHeight).toBe(30);
    expect(out.legHeight).toBe('4"');
  });

  test('an absent or empty key is filled in from the decode', () => {
    const out = mergeVariants({ seatHeight: null, colourLabel: '' }, { seatHeight: 32, specials: ['x'] }, { colourResolved: false });
    expect(out.seatHeight).toBe(32);
    expect(out.specials).toEqual(['x']);
  });

  test('the colour group moves as ONE unit, or not at all', () => {
    const decoded = { fabricId: 'BO315', colourId: 'BO315-5', fabricCode: 'BO315-5', colourLabel: 'Fossil', fabricLabel: 'BO315', specials: [] };
    const kept = mergeVariants({ colourLabel: 'B0315-5 fossil' }, decoded, { colourResolved: false });
    expect(kept.colourLabel).toBe('B0315-5 fossil');
    expect(kept.fabricId).toBeUndefined();

    const taken = mergeVariants({ colourLabel: 'B0315-5 fossil' }, decoded, { colourResolved: true });
    for (const k of COLOUR_KEYS) expect(taken[k]).toBe(decoded[k]);
  });

  test('a variants block that is not an object (the array/string damage) starts clean', () => {
    expect(mergeVariants([{ seatHeight: 1 }], { seatHeight: 28, specials: [] }, { colourResolved: false }))
      .toEqual({ seatHeight: 28, specials: [] });
    expect(mergeVariants(null, { seatHeight: 28, specials: [] }, { colourResolved: false }))
      .toEqual({ seatHeight: 28, specials: [] });
  });
});
