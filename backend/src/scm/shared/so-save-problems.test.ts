import { describe, expect, it } from 'vitest';
import {
  collectProcessingGateProblems,
  validationFailedBody,
  type SaveProblem,
} from './so-save-problems';
import { meetsDepositGate } from './order-rules';

const codes = (ps: SaveProblem[]) => ps.map((p) => p.code);

describe('collectProcessingGateProblems', () => {
  it('returns [] when every gate passes', () => {
    const ps = collectProcessingGateProblems({
      procDate: '2099-01-10',
      delivDate: '2099-02-10',
      todayMY: '2026-07-18',
      variantOffenders: [],
      deposit: { paidCenti: 100_00, totalCenti: 100_00 },
    });
    expect(ps).toEqual([]);
  });

  it('collects EVERY failing gate in one pass (variants + deposit + past + after-delivery)', () => {
    // proc in the past AND after the (also-past) delivery date, deposit short,
    // two lines each missing a required axis.
    const ps = collectProcessingGateProblems({
      procDate: '2020-05-10',
      delivDate: '2020-05-01', // proc > deliv → after-delivery; both < today → past
      todayMY: '2026-07-18',
      variantOffenders: [
        { itemCode: 'FENRIR-5FT', group: 'bedframe', missing: ['legHeight'] },
        { itemCode: 'TELLUC-2S', group: 'sofa', missing: ['fabricCode'] },
      ],
      deposit: { paidCenti: 0, totalCenti: 300_00 }, // 0% < 30%
    });
    // 2 variant + 1 deposit + proc-past + deliv-past + after-delivery = 6 problems.
    expect(ps).toHaveLength(6);
    expect(codes(ps)).toEqual([
      'variants_incomplete',
      'variants_incomplete',
      'processing_date_unpaid',
      'processing_date_past',
      'delivery_date_past',
      'processing_after_delivery',
    ]);
  });

  it('names the concrete line + axis on each variant problem', () => {
    const ps = collectProcessingGateProblems({
      procDate: '2099-01-10',
      delivDate: '2099-02-10',
      todayMY: '2026-07-18',
      variantOffenders: [
        { itemCode: 'FENRIR-5FT', group: 'bedframe', missing: ['legHeight', 'gap'] },
      ],
    });
    expect(ps).toHaveLength(2);
    // canonical axis key -> human label, and the line is named.
    expect(ps[0]).toMatchObject({ code: 'variants_incomplete', line: 'FENRIR-5FT', field: 'Leg Height' });
    expect(ps[0]!.message).toBe('FENRIR-5FT — Leg Height is required');
    expect(ps[1]).toMatchObject({ line: 'FENRIR-5FT', field: 'Gap' });
    expect(ps[1]!.message).toBe('FENRIR-5FT — Gap is required');
  });

  it('deposit problem carries the concrete amount + threshold', () => {
    const ps = collectProcessingGateProblems({
      procDate: '2099-01-10',
      delivDate: '2099-02-10',
      todayMY: '2026-07-18',
      deposit: { paidCenti: 50_00, totalCenti: 1000_00 }, // RM50 paid, need RM300 (30%)
    });
    expect(ps).toHaveLength(1);
    expect(ps[0]!.code).toBe('processing_date_unpaid');
    expect(ps[0]!.message).toContain('RM 50');
    expect(ps[0]!.message).toContain('RM 300');
    expect(ps[0]!.message).toContain('30%');
  });

  it('grandfathers an unchanged already-past date (edit path)', () => {
    const ps = collectProcessingGateProblems({
      procDate: '2020-01-01',
      delivDate: '2020-02-01',
      todayMY: '2026-07-18',
      origProcDate: '2020-01-01',  // unchanged → not a fresh past entry
      origDelivDate: '2020-02-01',
    });
    // past-date suppressed for both; proc <= deliv so no after-delivery either.
    expect(ps).toEqual([]);
  });

  it('still rejects a MOVED past date even if the old value was also past', () => {
    const ps = collectProcessingGateProblems({
      procDate: '2020-03-01', // moved
      delivDate: '2020-04-01',
      todayMY: '2026-07-18',
      origProcDate: '2020-01-01',
      origDelivDate: '2020-04-01',
    });
    expect(codes(ps)).toContain('processing_date_past');
  });

  it('does not report a deposit shortfall when no processing date is being set', () => {
    const ps = collectProcessingGateProblems({
      procDate: null,
      delivDate: null,
      todayMY: '2026-07-18',
      deposit: { paidCenti: 0, totalCenti: 100_00 },
    });
    expect(ps).toEqual([]);
  });

  /* Colour-KIV gate (owner rule 2026-07-24, after SO-2607-016 reached
     production planning with two KIV sofa lines): a Processing Date may not be
     set or changed while any non-cancelled line's fabric colour is still KIV. */
  describe('fabric_colour_kiv', () => {
    it('KIV line + a Processing Date being set -> rejected, naming the line + series', () => {
      const ps = collectProcessingGateProblems({
        procDate: '2099-01-10',
        delivDate: '2099-02-10',
        todayMY: '2026-07-24',
        kivOffenders: [{ itemCode: 'SOFA-XAMMAR-L', fabricLabel: 'EZ' }],
      });
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({ code: 'fabric_colour_kiv', line: 'SOFA-XAMMAR-L', field: 'Fabrics' });
      expect(ps[0]!.message).toBe(
        'SOFA-XAMMAR-L — fabric colour is still KIV (EZ). Confirm the colour before setting the Processing Date.',
      );
    });

    it('KIV line + a save that does NOT touch the Processing Date -> allowed', () => {
      // Routes only pass kivOffenders when the date genuinely changes, but even
      // if one slips through, no procDate on this save means no block — editing
      // remarks on an old KIV order must still work.
      const ps = collectProcessingGateProblems({
        procDate: null,
        delivDate: null,
        todayMY: '2026-07-24',
        kivOffenders: [{ itemCode: 'SOFA-XAMMAR-L', fabricLabel: 'EZ' }],
      });
      expect(ps).toEqual([]);
    });

    it('resolved colour (no KIV offenders) + a Processing Date -> allowed', () => {
      const ps = collectProcessingGateProblems({
        procDate: '2099-01-10',
        delivDate: '2099-02-10',
        todayMY: '2026-07-24',
        variantOffenders: [],
        kivOffenders: [],
      });
      expect(ps).toEqual([]);
    });

    it('a KIV line also missing the fabricCode axis reports ONE problem (KIV wins), other axes still report', () => {
      const ps = collectProcessingGateProblems({
        procDate: '2099-01-10',
        delivDate: '2099-02-10',
        todayMY: '2026-07-24',
        variantOffenders: [
          { itemCode: 'SOFA-XAMMAR-L', group: 'sofa', missing: ['seatHeight', 'fabricCode'] },
        ],
        kivOffenders: [{ itemCode: 'SOFA-XAMMAR-L', fabricLabel: 'EZ' }],
      });
      expect(codes(ps)).toEqual(['variants_incomplete', 'fabric_colour_kiv']);
      expect(ps[0]!.field).toBe('Seat Height'); // the bare fabricCode axis is suppressed, not the others
    });

    it('a series-less KIV offender still reads as a sentence', () => {
      const ps = collectProcessingGateProblems({
        procDate: '2099-01-10',
        delivDate: '2099-02-10',
        todayMY: '2026-07-24',
        kivOffenders: [{ itemCode: 'SOFA-KATRIN-3S' }],
      });
      expect(ps[0]!.message).toBe(
        'SOFA-KATRIN-3S — fabric colour is still KIV. Confirm the colour before setting the Processing Date.',
      );
    });
  });

  /* Both dates or neither (owner, restated 2026-08-13). The client refuses both
     directions (so-form-validate.ts:94); the server only ever asked for the
     delivery half, inside the completeness block, so a Delivery Date alone got
     through anything that skipped the form. */
  describe('processing_delivery_must_pair', () => {
    it('a delivery date with NO processing date is refused', () => {
      const ps = collectProcessingGateProblems({
        procDate: null,
        delivDate: '2099-02-10',
        todayMY: '2026-08-13',
      });
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({ code: 'processing_delivery_must_pair', field: 'Processing Date' });
    });

    it('grandfathers a stored unpaired delivery date when the save touches neither date', () => {
      // The 19 live orders AutoCount could not pair must stay editable for an
      // unrelated change — the same carve-out the past-date rules use.
      const ps = collectProcessingGateProblems({
        procDate: null,
        delivDate: '2099-02-10',
        todayMY: '2026-08-13',
        origProcDate: null,
        origDelivDate: '2099-02-10',
      });
      expect(ps).toEqual([]);
    });

    it('still refuses when the edit MOVES the lone delivery date', () => {
      const ps = collectProcessingGateProblems({
        procDate: null,
        delivDate: '2099-03-10',
        todayMY: '2026-08-13',
        origProcDate: null,
        origDelivDate: '2099-02-10',
      });
      expect(codes(ps)).toEqual(['processing_delivery_must_pair']);
    });

    it('still refuses when the edit CLEARS the processing date off a paired order', () => {
      const ps = collectProcessingGateProblems({
        procDate: null,
        delivDate: '2099-02-10',
        todayMY: '2026-08-13',
        origProcDate: '2099-01-10',
        origDelivDate: '2099-02-10',
      });
      expect(codes(ps)).toEqual(['processing_delivery_must_pair']);
    });

    it('a paired order, and an order with neither date, both pass', () => {
      expect(collectProcessingGateProblems({
        procDate: '2099-01-10', delivDate: '2099-02-10', todayMY: '2026-08-13',
      })).toEqual([]);
      expect(collectProcessingGateProblems({
        procDate: null, delivDate: null, todayMY: '2026-08-13',
      })).toEqual([]);
    });
  });

  it('treats a total <= 0 order as deposit-satisfied (free order)', () => {
    const ps = collectProcessingGateProblems({
      procDate: '2099-01-10',
      delivDate: '2099-02-10',
      todayMY: '2026-07-18',
      deposit: { paidCenti: 0, totalCenti: 0 },
    });
    expect(ps).toEqual([]);
  });
});

describe('validationFailedBody', () => {
  it('single problem → message is that problem', () => {
    const body = validationFailedBody([
      { code: 'processing_date_past', message: 'Processing Date cannot be in the past — today or a future date only.' },
    ]);
    expect(body.error).toBe('validation_failed');
    expect(body.problems).toHaveLength(1);
    expect(body.message).toBe('Processing Date cannot be in the past — today or a future date only.');
  });

  it('multiple problems → a count summary, full list preserved', () => {
    const body = validationFailedBody([
      { code: 'a', message: 'one' },
      { code: 'b', message: 'two' },
    ]);
    expect(body.message).toBe('2 things need fixing before this can be saved.');
    expect(body.problems).toHaveLength(2);
  });
});

/* Per-company deposit threshold (owner 2026-07-31: Houzs 30%, 2990 50%).
   Before this, both constants applied to every company and a 2990 order was
   gated at the Houzs 30% — the refusal the owner hit on a 2990 SO. */
describe('deposit threshold is per company', () => {
  const facts = (companyCode: string | null, paidCenti: number) => ({
    procDate: '2026-12-01',
    delivDate: '2026-12-20',
    todayMY: '2026-07-31',
    companyCode,
    deposit: { paidCenti, totalCenti: 1000_00 },
  });
  const unpaid = (f: Parameters<typeof collectProcessingGateProblems>[0]) =>
    collectProcessingGateProblems(f).filter((p) => p.code === 'processing_date_unpaid');

  it('HOUZS clears at 30%', () => {
    expect(unpaid(facts('HOUZS', 300_00))).toHaveLength(0);
  });

  it('2990 does NOT clear at 30% — its rule is 50%', () => {
    const [p] = unpaid(facts('2990', 300_00));
    expect(p).toBeDefined();
    /* The MESSAGE must carry 50%, not the 30% a hard-coded constant would
       print: a 2990 operator told "30%" while being refused at 50% cannot act
       on it. */
    expect(p.message).toContain('50%');
    expect(p.message).toContain('RM 500');
  });

  it('2990 clears at 50%', () => {
    expect(unpaid(facts('2990', 500_00))).toHaveLength(0);
  });

  it('an unknown or absent company falls back to the LOOSER 30%, never the stricter', () => {
    expect(unpaid(facts(null, 300_00))).toHaveLength(0);
    expect(unpaid(facts('SOMETHING-NEW', 300_00))).toHaveLength(0);
  });

  it('company code is matched case-insensitively and trimmed', () => {
    expect(unpaid(facts(' 2990 ', 300_00))).toHaveLength(1);
  });

  /* This report and the Proceed gate must never disagree about whether the
     deposit is in — they describe the same act (a Processing Date IS Proceed),
     so they read the same predicate. Reporting is all they may differ on. */
  it('reports the shortfall exactly when meetsDepositGate refuses', () => {
    for (const companyCode of ['HOUZS', '2990', null, 'FUTURE-CO']) {
      for (const paidCenti of [0, 299_99, 300_00, 499_99, 500_00, 1000_00]) {
        expect(unpaid(facts(companyCode, paidCenti)).length === 0)
          .toBe(meetsDepositGate(paidCenti, 1000_00, companyCode));
      }
    }
  });
});

/* ONE gate (owner 2026-07-31: "不要又 Processing Date,又 Proceed... Processing
   Date 就是当天 Proceed 的意思"). Completeness now gates the Processing Date the
   way it always gated Proceed — MINUS email, which the owner dropped and which
   was the only field production was actually missing (12 of 63; zero lacked
   name/address/postcode/delivery date). */
describe('unified Processing-Date gate: completeness', () => {
  const base = {
    procDate: '2026-12-01',
    delivDate: '2026-12-20',
    todayMY: '2026-07-31',
    companyCode: 'HOUZS',
    deposit: { paidCenti: 1000_00, totalCenti: 1000_00 },
  };
  const complete = { hasCustomerName: true, hasAddress: true, hasPostcode: true };
  const codes = (f: Parameters<typeof collectProcessingGateProblems>[0]) =>
    collectProcessingGateProblems(f).filter((p) => p.code === 'processing_date_incomplete');

  it('clears when name, address, postcode and delivery date are present', () => {
    expect(codes({ ...base, completeness: complete })).toHaveLength(0);
  });

  it('reports EVERY missing field at once, not one at a time', () => {
    const out = codes({
      ...base,
      delivDate: null,
      completeness: { hasCustomerName: false, hasAddress: false, hasPostcode: false },
    });
    expect(out).toHaveLength(4);
    expect(out.map((p) => p.field).sort()).toEqual(['Address', 'Customer', 'Delivery date', 'Postcode']);
  });

  it('an email is NOT required — the owner dropped it', () => {
    /* There is no email input at all; a complete order with no email clears. */
    expect(codes({ ...base, completeness: complete })).toHaveLength(0);
  });

  it('does not fire when no Processing Date is being set', () => {
    expect(codes({
      ...base,
      procDate: null,
      completeness: { hasCustomerName: false, hasAddress: false, hasPostcode: false },
    })).toHaveLength(0);
  });

  it('a path that supplies no completeness facts reports none rather than inventing failures', () => {
    expect(codes({ ...base, completeness: null })).toHaveLength(0);
    expect(codes({ ...base })).toHaveLength(0);
  });

  it('completeness and the deposit shortfall are reported TOGETHER, in one response', () => {
    const all = collectProcessingGateProblems({
      ...base,
      deposit: { paidCenti: 0, totalCenti: 1000_00 },
      completeness: { hasCustomerName: true, hasAddress: false, hasPostcode: true },
    });
    expect(all.map((p) => p.code).sort()).toEqual(['processing_date_incomplete', 'processing_date_unpaid']);
  });
});
