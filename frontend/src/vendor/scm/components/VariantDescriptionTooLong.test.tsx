// Three sales orders sat outside the account book for four characters each, and
// no screen said so — the refusal was a line in a workflow log. These are the
// cases that decide whether a person can now see it.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VariantDescription } from './VariantDescription';
import { AC_DESC2_MAX } from '../../../lib/acColumnWidths';

/* Specials are what push the line over: measured 2026-09-09, a plain bedframe
   renders 46 characters and two long special-order notes take it to 104. */
const base = { fabricCode: 'PC151-12', divanHeight: '8', legHeight: 'DEFAULT', gap: '2' };
const line = (variants: Record<string, unknown>) => (
  <VariantDescription itemCode="HOK-2008(A) (K)" itemGroup="BEDFRAME" variants={variants} description={null} />
);

describe('a Description 2 the account book cannot store', () => {
  it('says so, with the length and the limit', () => {
    render(line({ ...base, specials: ['ADD 2 INCH FOAM ON TOP', 'CHANGE HEADBOARD TO 48 INCH'] }));
    const warning = screen.getByText(new RegExp(`/${AC_DESC2_MAX} — too long for AutoCount`));
    expect(warning).toBeTruthy();
    /* The NUMBER is the useful half: "104/100" tells somebody they are four
       characters away, which is what they act on. */
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
    /* Desc2 is what the factory builds from. A warning that hid it would be
       worse than the refusal it is warning about. */
    render(line({ ...base, specials: ['ADD 2 INCH FOAM ON TOP', 'CHANGE HEADBOARD TO 48 INCH'] }));
    expect(screen.getByText(/CHANGE HEADBOARD TO 48 INCH/)).toBeTruthy();
  });
});
