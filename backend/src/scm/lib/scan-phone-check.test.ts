import { describe, expect, it } from 'vitest';
import { hasUnexpectedDigitCount, phoneDigitCountWarnings } from './scan-phone-check';

describe('hasUnexpectedDigitCount', () => {
  it('acceptsA012MobileWithSevenSubscriberDigits', () => {
    expect(hasUnexpectedDigitCount('+60126945676')).toBe(false);
  });

  it('acceptsA011MobileWithEightSubscriberDigits', () => {
    expect(hasUnexpectedDigitCount('+601121456629')).toBe(false);
  });

  it('acceptsA015NumberWithEightSubscriberDigits', () => {
    expect(hasUnexpectedDigitCount('+601512345678')).toBe(false);
  });

  it('flagsA011MobileThatLostADigit', () => {
    expect(hasUnexpectedDigitCount('+60113456629')).toBe(true);
  });

  it('flagsA012MobileWithAnExtraDigit', () => {
    expect(hasUnexpectedDigitCount('+601269456761')).toBe(true);
  });

  it('flagsA017MobileThatLostADigit', () => {
    expect(hasUnexpectedDigitCount('+6017627811')).toBe(true);
  });

  it('acceptsKualaLumpurAndStateLandlines', () => {
    expect(hasUnexpectedDigitCount('+60321234567')).toBe(false);
    expect(hasUnexpectedDigitCount('+6041234567')).toBe(false);
  });

  it('leavesForeignNumbersAlone', () => {
    expect(hasUnexpectedDigitCount('+6591234567')).toBe(false);
  });
});

describe('phoneDigitCountWarnings', () => {
  it('namesOnlyTheSuspectNumbersInLocalForm', () => {
    expect(phoneDigitCountWarnings(['+60126945676', '+60113456629'])).toEqual([
      'Check phone 0113456629 against the slip: it looks like a digit was dropped or doubled.',
    ]);
  });

  it('returnsNothingWhenAllNumbersLookRight', () => {
    expect(phoneDigitCountWarnings(['+60126945676'])).toEqual([]);
  });
});
