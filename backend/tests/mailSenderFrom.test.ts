import { describe, expect, test } from 'vitest';
import { senderFrom } from '../src/lib/mail-sender';

describe('senderFrom', () => {
  test('shows the staff name with the company, not the company alone', () => {
    expect(senderFrom('Zaim', 'Houzs Century', 'zaim@houzscentury.com'))
      .toBe('"Zaim (Houzs Century)" <zaim@houzscentury.com>');
  });

  test('falls back to the company name when the staff name is empty', () => {
    expect(senderFrom('  ', "2990's Home", 'hello@2990shome.com'))
      .toBe(`"2990's Home" <hello@2990shome.com>`);
  });

  test('escapes quotes so the address cannot be broken', () => {
    expect(senderFrom('A "B" C', 'Houzs Century', 'x@houzscentury.com'))
      .toBe('"A \\"B\\" C (Houzs Century)" <x@houzscentury.com>');
  });
});
