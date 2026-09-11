// ----------------------------------------------------------------------------
// allowed-options-check.test.ts — the gate had NO test at all until this file.
//
// Grepping `variant_not_allowed` across every *.test.ts in backend/src and
// frontend/src returned zero hits before this PR, so nothing pinned the
// behaviour of the ten refusal sites that produce the SO add-line 400.
//
// Two things are pinned here:
//   1. THE GLYPH TRAP (measured on prod 2026-08-17, run 32048732641). The one
//      `total_heights` pool shared by all 10 restricted BEDFRAME Models stores
//      its EVEN values with an ASCII inch mark (U+0022) and its ODD values
//      17/19/23/27 with U+201C and 21/25 with U+201D. The line editor can only
//      ever emit U+0022 (SoLineCard.tsx:436, `${d + l + g}"`), so every odd
//      total was refused by a pool that visibly lists that number. Restricting
//      to the gaps the picker can actually offer, 94 of the 280 pickable
//      divan x leg x gap combinations refused ON THE QUOTE CHARACTER ALONE.
//      The pricing engine already folds these (mfg-pricing.ts:165-192); this
//      gate never did.
//   2. THE DERIVED-FIELD CONTEXT. `total_height` is arithmetic with no input on
//      the form, so a refusal naming only `total_height` names nothing the
//      salesperson can touch. The refusal now carries `derivedFrom` — the three
//      inputs he CAN change — so the client can say which boxes to move.
// ----------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { checkAllowedOptions } from './allowed-options-check';

/** The live prod pool, verbatim, including the mixed inch glyphs. */
const PROD_TOTAL_HEIGHTS = [
  '10"', '12"', '14"', '16"', '17“', '18"', '19“', '20"',
  '21”', '22"', '23“', '24"', '25”', '26"', '27“', '28"',
];
const PROD_DIVAN_HEIGHTS = ['4"', '5"', '6"', '8"', '10"', '11"', '12"', '13"', '14"', '16"'];
const PROD_LEG_HEIGHTS = ['No Leg', '1"', '2"', '4"'];
const PROD_GAPS = [
  '4"', '5"', '6"', '7"', '8"', '9"', '10"',
  '11”', '12“', '13”', '14“', '15”', '16“',
  '17”', '18“', '19”', '20“',
];

const bedframe: NonNullable<Parameters<typeof checkAllowedOptions>[0]> = {
  code: 'BF-DEMO-K',
  category: 'BEDFRAME',
  model_id: 'model-demo',
  size_code: 'K',
};

const model = (allowed: Record<string, string[] | null>) => ({
  id: 'model-demo',
  allowed_options: allowed,
} as Parameters<typeof checkAllowedOptions>[1]);

const prodModel = model({
  total_heights: PROD_TOTAL_HEIGHTS,
  divan_heights: PROD_DIVAN_HEIGHTS,
  leg_heights: PROD_LEG_HEIGHTS,
  gaps: PROD_GAPS,
  sizes: ['K', 'Q', 'S'],
});

const product = (over: Partial<typeof bedframe> = {}) =>
  ({ ...bedframe, ...over }) as Parameters<typeof checkAllowedOptions>[0];

describe('checkAllowedOptions — typographic inch marks', () => {
  it('accepts the ASCII total the editor emits when the pool spells it curly (prod pool, Divan 4" + Leg 4" + Gap 9" = 17")', () => {
    const err = checkAllowedOptions(product(), prodModel, {
      divanHeight: '4"',
      legHeight: '4"',
      gap: '9"',
      totalHeight: '17"',
    });
    expect(err).toBeNull();
  });

  it('accepts every odd total the prod pool lists curly', () => {
    for (const n of [17, 19, 21, 23, 25, 27]) {
      const err = checkAllowedOptions(product(), prodModel, { totalHeight: `${n}"` });
      expect(err, `total ${n}" must be accepted — the pool lists it`).toBeNull();
    }
  });

  it('still accepts the straight-quoted evens (nothing that matched today stops matching)', () => {
    for (const n of [10, 12, 14, 16, 18, 20, 22, 24, 26, 28]) {
      expect(checkAllowedOptions(product(), prodModel, { totalHeight: `${n}"` })).toBeNull();
    }
  });

  it('folds the gaps pool the same way (10 of the 17 prod gap values are curly)', () => {
    expect(checkAllowedOptions(product(), prodModel, { gap: '12"' })).toBeNull();
    expect(checkAllowedOptions(product(), prodModel, { gap: '17"' })).toBeNull();
  });

  it('DOES NOT weaken the gate — a height the pool does not list in ANY spelling is still refused', () => {
    const err = checkAllowedOptions(product(), prodModel, { totalHeight: '31"' });
    expect(err).not.toBeNull();
    expect(err!.error).toBe('variant_not_allowed');
    expect(err!.field).toBe('total_height');
    expect(err!.value).toBe('31"');
  });

  it('does not fold anything but quote characters — no trim, no case folding', () => {
    const m = model({ specials: ['Hydraulic'], sizes: null });
    expect(checkAllowedOptions(product(), m, { specials: ['hydraulic'] })).not.toBeNull();
  });
});

describe('checkAllowedOptions — derived fields carry their inputs', () => {
  it('a refused total_height names the three boxes the operator can actually change', () => {
    const err = checkAllowedOptions(product(), prodModel, {
      divanHeight: '16"',
      legHeight: '4"',
      gap: '10"',
      totalHeight: '30"',
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('total_height');
    expect(err!.derivedFrom).toEqual([
      { field: 'divan_height', value: '16"' },
      { field: 'leg_height', value: '4"' },
      { field: 'gap', value: '10"' },
    ]);
  });

  it('a refusal on a field the operator DOES type carries no derivedFrom', () => {
    const err = checkAllowedOptions(product(), prodModel, { divanHeight: '99"' });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('divan_height');
    expect(err!.derivedFrom).toBeUndefined();
  });
});

describe('checkAllowedOptions — unchanged behaviour', () => {
  it('an empty pool is no restriction', () => {
    expect(checkAllowedOptions(product(), model({ total_heights: [] }), { totalHeight: '99"' })).toBeNull();
  });

  it('no model linkage skips the gate entirely', () => {
    expect(checkAllowedOptions(product({ model_id: null }), prodModel, { totalHeight: '99"' })).toBeNull();
  });

  it('size_code still refuses on the product row, with the raw pool intact', () => {
    const err = checkAllowedOptions(product({ size_code: 'SK' }), prodModel, {});
    expect(err).not.toBeNull();
    expect(err!.field).toBe('size_code');
    expect(err!.value).toBe('SK');
    expect(err!.allowed).toEqual(['K', 'Q', 'S']);
  });

  it('the refusal still reports the pool VERBATIM, curly quotes and all', () => {
    const err = checkAllowedOptions(product(), prodModel, { totalHeight: '31"' });
    expect(err!.allowed).toEqual(PROD_TOTAL_HEIGHTS);
  });
});

/* ── The fabric pool holds SERIES, and the line sends a COLOUR ──────────────
   The owner opened every sofa Model's fabric allow-list and his staff still
   could not pick a fabric. Cause: the screen that FILLS the pool
   (ProductModelDetail's Modular drawer) offers `fabric_library.id` - a fabric
   SERIES - while this gate compared the line's `fabricCode`/`colourId`, a
   COLOUR. One field, two vocabularies.

   MEASURED on production 2026-09-11, company 1: all 79 sofa Models carry the
   SAME 101-entry pool; 91 entries are library ids, 3 are colour ids, 10 are
   library LABELS ("GD2034 (HIVE)"); 851 colours are active. Three of 851 could
   be picked. The pool values and the line shape below are copied from that
   measurement, not invented - `BO315` is in the real pool and
   `{"colourId":"BO315-23","fabricId":"BO315"}` is a real saved line.
   docs/bugs/0814. */
const REAL_POOL_HEAD = ['311', 'A201', 'AH', 'ALPINE-5311', 'AM275', 'AMBER', 'AVANI', 'BN125', 'BO315', 'BYD'];
const sofa = product({ code: '8030-1A(LHF)', category: 'SOFA' });

describe('checkAllowedOptions — the fabric pool speaks SERIES', () => {
  const pool = model({ fabrics: REAL_POOL_HEAD });

  it('accepts a colour whose SERIES is in the pool (the case that was refused)', () => {
    expect(checkAllowedOptions(sofa, pool, {
      fabricCode: 'BO315-23', colourId: 'BO315-23', fabricId: 'BO315',
    })).toBeNull();
  });

  it('still accepts a pool entry that is a COLOUR, so a per-shade allow keeps working', () => {
    expect(checkAllowedOptions(sofa, model({ fabrics: ['BO315-23'] }), {
      fabricCode: 'BO315-23', colourId: 'BO315-23', fabricId: 'BO315',
    })).toBeNull();
  });

  it('STILL REFUSES a fabric whose series is not in the pool — the gate is not switched off', () => {
    const err = checkAllowedOptions(sofa, pool, {
      fabricCode: 'GD2502-11', colourId: 'GD2502-11', fabricId: 'GD2502',
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('fabric');
    expect(err!.value).toBe('GD2502-11');
    expect(err!.allowed).toEqual(REAL_POOL_HEAD);
  });

  it('refuses when the line carries NO series and the colour is not in the pool', () => {
    // A line written before pickFabricColour sent fabricId. Nothing to resolve
    // by, so the old answer stands - the gate must not guess a series from the
    // colour's spelling.
    expect(checkAllowedOptions(sofa, pool, { fabricCode: 'BO315-23' })).not.toBeNull();
  });

  it('an EMPTY pool still gates nothing, series or not', () => {
    expect(checkAllowedOptions(sofa, model({ fabrics: [] }), {
      fabricCode: 'GD2502-11', fabricId: 'GD2502',
    })).toBeNull();
  });

  it('a series that matches nothing does not accidentally pass an unrelated colour', () => {
    expect(checkAllowedOptions(sofa, pool, {
      fabricCode: 'ZZZ-01', colourId: 'ZZZ-01', fabricId: 'ZZZ',
    })).not.toBeNull();
  });

  it('a pool entry stored as a LABEL matches neither colour nor series — the 10 rows a repair must fix', () => {
    // "GD2034 (HIVE)" is fabric_library.label, not .id. Accepting labels here
    // would make the gate guess at display text; the data is repaired instead.
    const err = checkAllowedOptions(sofa, model({ fabrics: ['GD2034 (HIVE)'] }), {
      fabricCode: 'GD2034-01', colourId: 'GD2034-01', fabricId: 'GD2034',
    });
    expect(err).not.toBeNull();
  });
});

describe('checkAllowedOptions — the pool is typed by a person, so it trims too', () => {
  /* `"TARONI "` is verbatim from production: a trailing space, in all 79 of
     company 1's sofa fabric pools. The pickers trim; without the gate trimming,
     the screen offers TARONI and the save refuses it. docs/bugs/0814. */
  it('accepts a fabric whose pool entry carries a trailing space', () => {
    expect(checkAllowedOptions(sofa, model({ fabrics: ['TARONI '] }), {
      fabricCode: 'TARONI-05', colourId: 'TARONI-05', fabricId: 'TARONI',
    })).toBeNull();
  });

  it('accepts a gap whose pool entry is padded AND curly', () => {
    expect(checkAllowedOptions(product(), model({ gaps: [' 11” '] }), { gap: '11"' })).toBeNull();
  });

  it('trims the glyph and the space only — a different value is still refused', () => {
    expect(checkAllowedOptions(product(), model({ gaps: [' 11” '] }), { gap: '12"' })).not.toBeNull();
  });
});
