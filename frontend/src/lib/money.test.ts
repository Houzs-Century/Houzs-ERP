/**
 * Every case here is a real way a price gets keyed at HOUZS, and the assertion
 * is always one of two things: the amount we read is EXACTLY right, or we
 * refused and said why. There is deliberately no case that returns a
 * best-guess number for input we could not read — that behaviour is the bug
 * this module replaced.
 */
import { describe, it, expect } from 'vitest';
import { parseMoneyToSen, parseQuantity, senToRm } from './money';

function sen(raw: unknown): number {
  const r = parseMoneyToSen(raw, 'Price');
  if (!r.ok) throw new Error(`expected ok, got refusal: ${r.message}`);
  return r.sen;
}

function refusal(raw: unknown): string {
  const r = parseMoneyToSen(raw, 'Price');
  if (r.ok) throw new Error(`expected a refusal, got ${r.sen} sen`);
  return r.message;
}

describe('parseMoneyToSen — plain amounts', () => {
  it('reads whole ringgit', () => {
    expect(sen('1200')).toBe(120000);
    expect(sen('0')).toBe(0);
    expect(sen('7')).toBe(700);
  });

  it('reads sen', () => {
    expect(sen('1200.50')).toBe(120050);
    expect(sen('0.05')).toBe(5);
    expect(sen('0.5')).toBe(50);
    expect(sen('.5')).toBe(50);
  });

  it('never loses a sen to float multiplication', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE754. Integer assembly is exact.
    expect(sen('19.99')).toBe(1999);
    expect(sen('1.00')).toBe(100);
    expect(sen('8.29')).toBe(829);
    expect(sen('1234567.89')).toBe(123456789);
  });
});

describe('parseMoneyToSen — what a human plainly meant', () => {
  it('accepts a currency prefix', () => {
    expect(sen('RM 1200')).toBe(120000);
    expect(sen('rm1200')).toBe(120000);
    expect(sen('MYR 1200.50')).toBe(120050);
    expect(sen('$99')).toBe(9900);
  });

  it('accepts surrounding and internal whitespace from a paste', () => {
    expect(sen('  1200  ')).toBe(120000);
    expect(sen('1200 ')).toBe(120000);
    expect(sen('1 200')).toBe(120000);
    expect(sen(' 1200 ')).toBe(120000); // non-breaking spaces, straight out of Excel
  });

  it('accepts thousands separators in an unambiguous grouping', () => {
    expect(sen('1,200')).toBe(120000);
    expect(sen('1,200.50')).toBe(120050);
    expect(sen('12,345,678')).toBe(1234567800);
    expect(sen('999,999')).toBe(99999900);
  });

  it('accepts full-width digits and punctuation from an IME', () => {
    expect(sen('１２００')).toBe(120000);
    expect(sen('１２００．５０')).toBe(120050);
    expect(sen('１，２００')).toBe(120000);
  });

  it('combines all of the above', () => {
    expect(sen('  RM １，２００．５０  ')).toBe(120050);
  });
});

describe('parseMoneyToSen — blank is "nothing entered", not zero', () => {
  it('reports empty for a blank field', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const r = parseMoneyToSen(blank, 'Price');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.empty).toBe(true);
        expect(r.sen).toBe(0);
      }
    }
  });

  it('does not report empty for a real zero', () => {
    const r = parseMoneyToSen('0', 'Price');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.empty).toBe(false);
  });
});

describe('parseMoneyToSen — refuses rather than guessing', () => {
  it('refuses text that is not a number', () => {
    expect(refusal('abc')).toMatch(/isn't a number/i);
    expect(refusal('12a')).toMatch(/isn't a number/i);
    expect(refusal('--5')).toMatch(/isn't a number/i);
  });

  it('refuses more than one decimal point', () => {
    expect(refusal('1.2.3')).toMatch(/more than one decimal point/i);
  });

  it('refuses comma placement it cannot read', () => {
    // The historic silent failure: parseFloat("1,20") is 1, i.e. RM 1.00.
    expect(refusal('1,20')).toMatch(/commas in a place we can't read/i);
    expect(refusal('12,34,567')).toMatch(/commas in a place we can't read/i);
    expect(refusal('1.2,5')).toMatch(/comma after the decimal point/i);
  });

  it('refuses more precision than money has', () => {
    expect(refusal('1.005')).toMatch(/too many decimal places/i);
    expect(refusal('10.999')).toMatch(/too many decimal places/i);
  });

  it('refuses a negative price by default', () => {
    expect(refusal('-5')).toMatch(/can't be negative/i);
    expect(refusal('−5')).toMatch(/can't be negative/i); // U+2212 from a paste
  });

  it('allows a negative when the caller opts in', () => {
    const r = parseMoneyToSen('-5.50', 'Adjustment', { allowNegative: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sen).toBe(-550);
  });

  it('refuses a figure larger than we can handle', () => {
    expect(refusal('99999999999999')).toMatch(/larger than we can handle/i);
  });

  it('refuses a number value that is already NaN or Infinity', () => {
    expect(refusal(Number.NaN)).toMatch(/isn't a number/i);
    expect(refusal(Number.POSITIVE_INFINITY)).toMatch(/isn't a number/i);
  });

  it('names the field in every refusal, so the user knows which box', () => {
    const r = parseMoneyToSen('1.2.3', 'Unit price on line 2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('Unit price on line 2');
  });

  it('never puts a code or jargon in a message', () => {
    for (const bad of ['abc', '1.2.3', '1,20', '1.005', '-5', '99999999999999']) {
      const m = refusal(bad);
      expect(m).not.toMatch(/NaN|parseFloat|undefined|null|error|invalid|[A-Z]{3,}\d/);
      expect(m.endsWith('.')).toBe(true);
    }
  });
});

describe('parseMoneyToSen — accepts an already-parsed number', () => {
  it('reads a finite number the same as its text', () => {
    expect(sen(1200)).toBe(120000);
    expect(sen(1200.5)).toBe(120050);
    expect(sen(0)).toBe(0);
  });
});

describe('parseQuantity', () => {
  it('scales by 1000 and allows three decimals', () => {
    const r = parseQuantity('2.5', 'Qty');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sen).toBe(2500);
  });

  it('refuses the same ambiguity money does', () => {
    const r = parseQuantity('1.2.3', 'Qty');
    expect(r.ok).toBe(false);
  });

  it('refuses a negative quantity', () => {
    const r = parseQuantity('-1', 'Qty');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/can't be negative/i);
  });
});

describe('senToRm', () => {
  it('round-trips every amount the parser can produce', () => {
    for (const text of ['0', '0.05', '1200', '1200.50', '19.99', '1234567.89']) {
      const s = sen(text);
      expect(senToRm(s)).toBeCloseTo(Number(text), 10);
    }
  });
});
