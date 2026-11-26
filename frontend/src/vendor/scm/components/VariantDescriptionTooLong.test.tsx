import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VariantDescription } from './VariantDescription';
import { AC_DESC2_MAX } from '../../../lib/acColumnWidths';

const base = { fabricCode: 'PC151-12', divanHeight: '8', legHeight: 'DEFAULT', gap: '2' };
const line = (variants: Record<string, unknown>) => (
  <VariantDescription itemCode="HOK-2008(A) (K)" itemGroup="BEDFRAME" variants={variants} description={null} />
);

describe('a Description 2 the account book cannot store', () => {
  it('says so, with the length and the limit', () => {
    render(line({ ...base, specials: ['ADD 2 INCH FOAM ON TOP', 'CHANGE HEADBOARD TO 48 INCH'] }));
    const warning = screen.getByText(new RegExp(`/${AC_DESC2_MAX} — too long for AutoCount`));
    expect(warning).toBeTruthy();
    expect(warning.textContent).toMatch(/^1\d\d\/100 /);
  });

  it('says nothing when the line fits', () => {
    /* The owner's own shortening of the same spec, 2026-09-09: 93 characters. */
    render(line({ ...base, specials: ['ADD 2" FOAM ON TOP', 'CHANGE HB TO 48 INCH'] }));
    expect(screen.queryByText(/too long for AutoCount/)).toBeNull();
  });

  it('says nothing on a plain line', () => {
    render(line(base));
    expect(screen.queryByText(/too long for AutoCount/)).toBeNull();
  });

  it('still renders the specification itself — the warning never replaces it', () => {
    render(line({ ...base, specials: ['ADD 2 INCH FOAM ON TOP', 'CHANGE HEADBOARD TO 48 INCH'] }));
    expect(screen.getByText(/CHANGE HEADBOARD TO 48 INCH/)).toBeTruthy();
  });
});
