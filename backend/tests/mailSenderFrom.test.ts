import { describe, expect, test } from 'vitest';
import { formatSenderFrom } from '../src/lib/mail-sender';

describe('formatSenderFrom', () => {
  test('shows the staff name with the company, not the company alone', () => {
    expect(formatSenderFrom('Zaim', 'Houzs Century', 'zaim@houzscentury.com'))
      .toBe('"Zaim (Houzs Century)" <zaim@houzscentury.com>');
  });

  test('falls back to the company name when the staff name is empty', () => {
    expect(formatSenderFrom('  ', "2990's Home", 'hello@2990shome.com'))
      .toBe(`"2990's Home" <hello@2990shome.com>`);
  });

  test('escapes quotes so the address cannot be broken', () => {
    expect(formatSenderFrom('A "B" C', 'Houzs Century', 'x@houzscentury.com'))
      .toBe('"A \\"B\\" C (Houzs Century)" <x@houzscentury.com>');
  });
});
