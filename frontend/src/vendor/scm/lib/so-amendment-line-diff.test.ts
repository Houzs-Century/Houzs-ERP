// Regression cover for the SO-amendment LINE diff — Owner 2026-07-18,
// SO-2607-018/A1 ("customer change colour").
//
// The live report was that a colour-only amendment on a BEDFRAME line had wiped
// the rest of the line's spec:
//   WAS         PC151-14 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"
//   REQUESTING  PC151-01 / LEG 1"
// The persisted blob was intact the whole time — the Requesting side was being
// FORMATTED with the wrong branch of buildVariantSummary because the diff module
// passed '' as the item group, so divanHeight / gap / totalHeight were never
// read. The Was side, built from the server-stamped description2, did read them.
//
// These tests pin the invariant the owner actually asked for: an amendment
// changes ONLY the field the user edited, and every other part of the spec
// survives byte-identical on BOTH sides of the card.

import { describe, it, expect } from 'vitest';
import {
  amendmentLineChangedFields,
  amendmentLineIsChange,
  amendmentUnrenderedAxes,
  amendmentVariantSummaries,
  resolveVariantGroup,
  unrenderedVariantAxes,
  visibleAmendmentLines,
  type DiffableAmendmentLine,
} from './so-amendment-line-diff';

/* The live line, as the builders record it: a full four-axis bedframe spec with
   ONE field edited — the fabric/colour code PC151-14 -> PC151-01. */
const BEDFRAME_SPEC = {
  fabricCode:   'PC151-14',
  divanHeight:  '8"',
  legHeight:    '1"',
  gap:          '12"',
  totalHeight:  '21"',
};

const colourOnlyLine = (
  overrides: Partial<DiffableAmendmentLine> = {},
  snapshotOverrides: Record<string, unknown> = {},
): DiffableAmendmentLine => ({
  change_type: 'SPEC',
  new_item_code: 'DIVAN ONLY-(Q)',
  new_qty: 1,
  new_unit_price_sen: 120000,
  new_variants: { ...BEDFRAME_SPEC, fabricCode: 'PC151-01' },
  old_snapshot: {
    itemCode: 'DIVAN ONLY-(Q)',
    qty: 1,
    unitPriceSen: 120000,
    itemGroup: 'bedframe',
    variants: { ...BEDFRAME_SPEC },
    description2: 'PC151-14 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"',
    ...snapshotOverrides,
  },
  ...overrides,
});

describe('SO-2607-018/A1 — a colour-only amendment keeps the rest of the spec', () => {
  it('renders every other part of the spec identically on both sides', () => {
    const { from, to } = amendmentVariantSummaries(colourOnlyLine());

    expect(from).toBe('PC151-14 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"');
    // The whole point: only the fabric code moves. Divan, leg, gap and total
    // height are byte-identical to the Was side.
    expect(to).toBe('PC151-01 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"');

    // Stated as the invariant rather than as a literal, so this still fails if
    // the format changes but the data loss returns.
    const stripFabric = (s: string) => s.split(' / ').slice(1).join(' / ');
    expect(stripFabric(to)).toBe(stripFabric(from));
  });

  it('does not drop DIVAN / GAP / T.Heights from the requested side', () => {
    const { to } = amendmentVariantSummaries(colourOnlyLine());
    expect(to).toContain('DIVAN 8"');
    expect(to).toContain('GAP 12"');
    expect(to).toContain('T.Heights 21"');
    expect(to).toContain('LEG 1"');
  });

  it('flags the variants as the only changed field', () => {
    const changed = amendmentLineChangedFields(colourOnlyLine());
    expect(changed).toEqual({
      itemCode: false, qty: false, unitPrice: false, variants: true, remark: false,
    });
  });

  it('reports nothing unrenderable — the card shows the whole spec', () => {
    expect(amendmentUnrenderedAxes(colourOnlyLine())).toEqual({ from: [], to: [] });
  });
});

describe('a bedframe change confined to ONE non-fabric axis stays visible', () => {
  /* The dangerous half of the same defect: variantsChanged compared both sides
     under the '' group, which never reads divanHeight — so a divan-only request
     scored as no-change and visibleAmendmentLines DROPPED the card. The approver
     saw an amendment with no line changes and a "0 changes" count. */
  const divanOnly = colourOnlyLine({
    new_variants: { ...BEDFRAME_SPEC, divanHeight: '10"' },
  });

  it('is detected as a change', () => {
    expect(amendmentLineChangedFields(divanOnly).variants).toBe(true);
    expect(amendmentLineIsChange(divanOnly)).toBe(true);
  });

  it('survives the visible-lines filter instead of vanishing', () => {
    expect(visibleAmendmentLines([divanOnly])).toHaveLength(1);
  });

  it('shows the moved axis and leaves the others alone', () => {
    const { from, to } = amendmentVariantSummaries(divanOnly);
    expect(from).toContain('DIVAN 8"');
    expect(to).toContain('DIVAN 10"');
    for (const untouched of ['PC151-14', 'LEG 1"', 'GAP 12"', 'T.Heights 21"']) {
      expect(from).toContain(untouched);
      expect(to).toContain(untouched);
    }
  });

  it('still reports gap and total height as unchanged fields', () => {
    const { from, to } = amendmentVariantSummaries(divanOnly);
    const seg = (s: string, prefix: string) =>
      s.split(' / ').find((p) => p.startsWith(prefix));
    expect(seg(to, 'GAP')).toBe(seg(from, 'GAP'));
    expect(seg(to, 'T.Heights')).toBe(seg(from, 'T.Heights'));
  });
});

describe('a genuinely unchanged line is still not a change', () => {
  it('scores no changed fields when nothing moved', () => {
    const noop = colourOnlyLine({ new_variants: { ...BEDFRAME_SPEC } });
    expect(amendmentLineIsChange(noop)).toBe(false);
    expect(visibleAmendmentLines([noop])).toHaveLength(0);
  });
});

describe('resolveVariantGroup', () => {
  it('trusts the group stamped on the snapshot', () => {
    expect(resolveVariantGroup(colourOnlyLine())).toBe('bedframe');
  });

  it('recovers bedframe from the blob when the stamp predates the fix', () => {
    // Legacy row: no itemGroup recorded. The bedframe-only axes are in the data,
    // so this is read, not guessed.
    const legacy = colourOnlyLine({}, { itemGroup: undefined });
    expect(resolveVariantGroup(legacy)).toBe('bedframe');
    expect(amendmentVariantSummaries(legacy).to).toContain('GAP 12"');
  });

  it('accepts the snake_case key so-revision already writes', () => {
    const snake = colourOnlyLine({}, { itemGroup: undefined, item_group: 'bedframe' });
    expect(resolveVariantGroup(snake)).toBe('bedframe');
  });

  it('leaves a sofa line on the non-bedframe branch', () => {
    const sofa: DiffableAmendmentLine = {
      change_type: 'SPEC',
      new_variants: { fabricCode: 'SF-02', seatHeight: '24', legHeight: '6"' },
      old_snapshot: {
        itemGroup: 'sofa',
        variants: { fabricCode: 'SF-01', seatHeight: '24', legHeight: '6"' },
      },
    };
    expect(resolveVariantGroup(sofa)).toBe('sofa');
    const { from, to } = amendmentVariantSummaries(sofa);
    expect(from).toBe('SF-01 / SEAT 24 / LEG 6"');
    expect(to).toBe('SF-02 / SEAT 24 / LEG 6"');
  });

  it('infers nothing — and loses nothing — from a blob with no bedframe axis', () => {
    const sofa = {
      change_type: 'SPEC',
      new_variants: { fabricCode: 'SF-02', seatHeight: '24' },
      old_snapshot: { variants: { fabricCode: 'SF-01', seatHeight: '24' } },
    } satisfies DiffableAmendmentLine;
    expect(resolveVariantGroup(sofa)).toBe('');
    expect(amendmentUnrenderedAxes(sofa)).toEqual({ from: [], to: [] });
  });
});

describe('unrenderedVariantAxes — the honesty backstop', () => {
  it('names a bedframe axis that a non-bedframe render would swallow', () => {
    expect(unrenderedVariantAxes('sofa', { divanHeight: '8"', gap: '12"' }))
      .toEqual(['divanHeight', 'gap']);
  });

  it('names a seat axis that a bedframe render would swallow', () => {
    expect(unrenderedVariantAxes('bedframe', { seatHeight: '24' })).toEqual(['seatHeight']);
  });

  it('ignores axes that are present but empty', () => {
    expect(unrenderedVariantAxes('sofa', { divanHeight: '', gap: null })).toEqual([]);
  });

  it('is empty for a blob the chosen group renders in full', () => {
    expect(unrenderedVariantAxes('bedframe', BEDFRAME_SPEC)).toEqual([]);
  });
});

describe('ADD and REMOVE are unaffected', () => {
  it('treats an ADD as wholly new and renders its bedframe spec in full', () => {
    const add: DiffableAmendmentLine = {
      change_type: 'ADD',
      new_item_code: 'AK-HP SL MOB MATT (S) -2F',
      new_qty: 1,
      new_variants: { ...BEDFRAME_SPEC },
    };
    expect(amendmentLineIsChange(add)).toBe(true);
    // No old_snapshot at all, so the group comes off the requested blob.
    expect(amendmentVariantSummaries(add).to)
      .toBe('PC151-14 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"');
  });

  it('treats a REMOVE as wholly a change', () => {
    const remove = colourOnlyLine({ change_type: 'REMOVE', new_variants: undefined });
    expect(amendmentLineIsChange(remove)).toBe(true);
  });
});

/* ── REMARK (mig 0280) — owner 2026-08-11, 2990-SO-2608-016 ────────────────
   The operator amended a processing-locked SO purely to put an instruction on a
   SVC-ADDON line: "Please take back Cody Bedframe (King Size) 2 units". The
   remark had no column, so it was dropped on submit AND the line scored as
   no-change — the request reached nobody and the SO showed an RM0 line naming
   only its SKU. These pin the field as carryable and as a real change. */
describe('a remark-only amendment is a request', () => {
  const remarkOnly = colourOnlyLine(
    {
      new_variants: { ...BEDFRAME_SPEC },   // spec untouched
      new_remark: 'Please take back Cody Bedframe (King Size) 2 units',
    },
    { remark: '' },
  );

  it('flags the remark as the only changed field', () => {
    expect(amendmentLineChangedFields(remarkOnly)).toEqual({
      itemCode: false, qty: false, unitPrice: false, variants: false, remark: true,
    });
  });

  it('survives visibleAmendmentLines instead of being filtered as a no-op', () => {
    expect(amendmentLineIsChange(remarkOnly)).toBe(true);
    expect(visibleAmendmentLines([remarkOnly])).toHaveLength(1);
  });

  it('carries the remark on an ADD line — the case that lost the instruction', () => {
    const add: DiffableAmendmentLine = {
      change_type: 'ADD',
      new_item_code: 'SVC-ADDON',
      new_qty: 1,
      new_unit_price_sen: 0,
      new_remark: 'Please take back Cody Bedframe (King Size) 2 units',
    };
    expect(amendmentLineChangedFields(add).remark).toBe(true);
  });
});

describe('a remark the request does not touch is never a change', () => {
  it('ignores an absent new_remark (every row raised before mig 0280)', () => {
    const legacy = colourOnlyLine(
      { new_variants: { ...BEDFRAME_SPEC } },
      { remark: 'Deliver before 5pm' },
    );
    expect(amendmentLineChangedFields(legacy).remark).toBe(false);
    // …and with nothing else moving, the row stays the no-op it always was.
    expect(amendmentLineIsChange(legacy)).toBe(false);
  });

  it('ignores a resubmitted identical remark', () => {
    const same = colourOnlyLine(
      { new_variants: { ...BEDFRAME_SPEC }, new_remark: 'Deliver before 5pm' },
      { remark: 'Deliver before 5pm' },
    );
    expect(amendmentLineChangedFields(same).remark).toBe(false);
  });

  it('treats an emptied remark as a real request to clear it', () => {
    const cleared = colourOnlyLine(
      { new_variants: { ...BEDFRAME_SPEC }, new_remark: '' },
      { remark: 'Deliver before 5pm' },
    );
    expect(amendmentLineChangedFields(cleared).remark).toBe(true);
  });
});
