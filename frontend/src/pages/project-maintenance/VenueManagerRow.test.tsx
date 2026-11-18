/* Owner 2026-11-18: the venue list squeezed each venue's name into a narrow
 * column, one word per line, because the name shared one row with the State /
 * City / Postcode / size fields. The name and the row menu now sit on their own
 * line and the fields go under them. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/localities-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/localities-queries')>()),
  useLocalities: () => ({ data: [], isLoading: false }),
}));

import { VenueManagerRow } from './VenueManagerRow';

describe('VenueManagerRow layout', () => {
  it('puts the venue name on its own line, not in the row of fields', () => {
    render(
      <ul>
        <VenueManagerRow v={{ id: 1, name: 'AEON BIG PUCHONG', state: 'Selangor', city: 'Puchong', postcode: '47100', size: null }} onPatch={() => {}} onRemove={() => {}} />
      </ul>,
    );
    const name = screen.getByText('AEON BIG PUCHONG');
    const size = screen.getByLabelText('Venue size');
    const fieldsRow = size.parentElement as HTMLElement;
    expect(fieldsRow.contains(name)).toBe(false);
    expect(name.className).toContain('truncate');
    expect(name.getAttribute('title')).toBe('AEON BIG PUCHONG');
  });
});
