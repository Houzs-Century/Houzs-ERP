import { describe, expect, it } from 'vitest';
import { soConfirmDateNote } from './soConfirmDateNote';

describe('soConfirmDateNote — HC-0113', () => {
  const today = '2026-10-13';

  it('says a past Processing Date becomes the confirm date (HC-SO-2609-077)', () => {
    expect(soConfirmDateNote('2026-09-18', '2026-10-26', today))
      .toBe('The Processing Date 18/09/2026 has passed. Confirming today changes it to the confirm date, 13/10/2026.');
  });

  it('says nothing for today, a future date or no date', () => {
    expect(soConfirmDateNote('2026-10-13', '2026-10-26', today)).toBeNull();
    expect(soConfirmDateNote('2026-10-20', '2026-10-26', today)).toBeNull();
    expect(soConfirmDateNote(null, null, today)).toBeNull();
  });

  it('asks for a new Delivery Date when that has passed too', () => {
    expect(soConfirmDateNote('2026-09-18', '2026-10-01', today))
      .toBe('The Delivery Date 01/10/2026 has already passed. Change it to today or later first — the order cannot be confirmed with it.');
  });
});
