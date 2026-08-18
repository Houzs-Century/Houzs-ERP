// Unit tests for soLineFieldChanges — the SO LINE audit diff.
//
// The regression that matters is the FIRST test: a spec-only edit used to
// produce an empty diff, which made the UPDATE_LINE handler skip the audit
// write entirely (2990-SO-2608-017, owner 2026-08-12).
import { describe, expect, test } from 'vitest';
import { soLineFieldChanges } from './so-line-audit-diff';

/** The 2990-SO-2608-017 sofa line as stored at creation. */
const sofaLine = (variants: Record<string, unknown>) => ({
  item_code: 'XAMMAR-2A(LHF)',
  item_group: 'sofa',
  qty: 1,
  unit_price_sen: 155750,
  discount_sen: 0,
  unit_cost_sen: 99225,
  total_sen: 155750,
  description2: 'EZ-002 / SEAT 24',
  leg_price_sen: 0,
  variants,
});

const BASE_VARIANTS = { fabricCode: 'EZ-002', seatHeight: '24' };
const WITH_LEG = { fabricCode: 'EZ-002', seatHeight: '24', legHeight: '6"' };

const fieldsOf = (changes: ReturnType<typeof soLineFieldChanges>) => changes.map((c) => c.field);

describe('soLineFieldChanges', () => {
  test('REGRESSION: a spec-only change is recorded (was silently dropped)', () => {
    // LEG 6" added; price, qty and cost all unchanged — exactly the shape that
    // produced an EMPTY diff under the old hand-maintained field list.
    const prev = sofaLine(BASE_VARIANTS);
    const changes = soLineFieldChanges(prev, {
      qty: 1,
      unit_price_sen: 155750,
      discount_sen: 0,
      unit_cost_sen: 99225,
      total_sen: 155750,
      variants: WITH_LEG,
      description2: 'EZ-002 / SEAT 24 / LEG 6"',
    });
    expect(changes.length).toBeGreaterThan(0);
    const spec = changes.find((c) => c.field === 'spec');
    expect(spec).toBeDefined();
    expect(String(spec!.from)).not.toContain('LEG');
    expect(String(spec!.to)).toContain('LEG 6"');
  });

  test('the spec change reads as a summary, never as raw JSON', () => {
    const changes = soLineFieldChanges(sofaLine(BASE_VARIANTS), { variants: WITH_LEG });
    const spec = changes.find((c) => c.field === 'spec')!;
    for (const side of [spec.from, spec.to]) {
      expect(String(side)).not.toContain('{');
      expect(String(side)).not.toContain('fabricCode');
    }
  });

  test('an unchanged line produces no changes at all', () => {
    const prev = sofaLine(BASE_VARIANTS);
    const changes = soLineFieldChanges(prev, {
      qty: 1, unit_price_sen: 155750, discount_sen: 0, unit_cost_sen: 99225,
      variants: { ...BASE_VARIANTS }, description2: 'EZ-002 / SEAT 24',
    });
    expect(changes).toEqual([]);
  });

  test('a column with no LABEL entry is still recorded, under its column name', () => {
    // The anti-allow-list guarantee: forgetting a label costs readability, never
    // the record itself. If this ever fails, someone turned LABEL back into a
    // gate — which is the original bug.
    const changes = soLineFieldChanges({ some_future_column: 'old' }, { some_future_column: 'new' });
    expect(changes).toEqual([{ field: 'some_future_column', from: 'old', to: 'new' }]);
  });

  test('derived money columns are suppressed, their inputs are not', () => {
    const changes = soLineFieldChanges(sofaLine(BASE_VARIANTS), {
      qty: 2,
      unit_price_sen: 155750,
      total_sen: 311500,      // derived
      total_inc_sen: 311500,  // derived
      balance_sen: 311500,    // derived
      line_cost_sen: 198450,  // derived
      line_margin_sen: 113050, // derived
    });
    expect(fieldsOf(changes)).toEqual(['qty']);
  });

  test("an addon note change rides the readable spec diff (it does print)", () => {
    // extraAddonNote IS part of the summary — it renders as the "SPECIAL: ..."
    // tail on document lines — so it reports as `spec`, not as a raw key. Pinned
    // because it is the note the 017 sofa lines carry.
    const changes = soLineFieldChanges(
      sofaLine({ ...BASE_VARIANTS, extraAddonNote: 'width max 264cm' }),
      { variants: { ...BASE_VARIANTS, extraAddonNote: 'width max 280cm' } },
    );
    const spec = changes.find((c) => c.field === 'spec');
    expect(spec).toBeDefined();
    expect(String(spec!.to)).toContain('280cm');
  });

  test('a NON-printing variants change still surfaces, key by key', () => {
    // The summary covers the attributes that print. A change outside them —
    // buildKey re-grouping a split sofa, a cell moving — is still a change to
    // the line and must not vanish just because the summary is identical.
    const changes = soLineFieldChanges(
      sofaLine({ ...BASE_VARIANTS, buildKey: 'build-1', cellIndex: 0 }),
      { variants: { ...BASE_VARIANTS, buildKey: 'build-2', cellIndex: 1 } },
    );
    const fields = fieldsOf(changes);
    expect(fields).toContain('variants.buildKey');
    expect(fields).toContain('variants.cellIndex');
    expect(fields).not.toContain('spec');   // summary unchanged → no phantom spec row
  });

  test('scalar comparison is loose: null≡"" and 5≡"5" are not changes', () => {
    const changes = soLineFieldChanges(
      { remark: null, qty: 5 },
      { remark: '', qty: '5' },
    );
    expect(changes).toEqual([]);
  });

  test('spec, price and delivery date are reported together on a combined edit', () => {
    const changes = soLineFieldChanges(
      { ...sofaLine(BASE_VARIANTS), line_delivery_date: '2026-09-15' },
      {
        unit_price_sen: 160000,
        variants: WITH_LEG,
        line_delivery_date: '2026-09-20',
        line_delivery_date_overridden: true,
      },
    );
    const fields = fieldsOf(changes);
    expect(fields).toContain('unitPriceSen');
    expect(fields).toContain('spec');
    expect(fields).toContain('lineDeliveryDate');
    expect(fields).toContain('lineDeliveryDateOverridden');
  });

  test('clearing variants entirely is a spec change, not a silent drop', () => {
    const changes = soLineFieldChanges(sofaLine(WITH_LEG), { variants: null });
    const spec = changes.find((c) => c.field === 'spec');
    expect(spec).toBeDefined();
    expect(spec!.to).toBeNull();
  });

  test('a variants key added with a null value is not a phantom change', () => {
    const changes = soLineFieldChanges(
      sofaLine(BASE_VARIANTS),
      { variants: { ...BASE_VARIANTS, legHeight: null } },
    );
    expect(changes).toEqual([]);
  });
});
