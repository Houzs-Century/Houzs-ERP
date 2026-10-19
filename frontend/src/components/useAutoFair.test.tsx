/* A new order starts with the KEYER's fair (owner 2026-10-19, the boss's rule):
 * the fair they stand at today, else the latest one within a month. The rule is
 * the server's (GET /fair-default); the hook only fills the picker ONCE and
 * words the line under it. These pin what the form does with the answer:
 *
 *   - a blank form, or one holding only the place it defaulted to, gets the fair;
 *   - a fair someone already picked is never replaced, and a cleared one is not
 *     filled back in;
 *   - with no fair, nothing is filled and the line says why, in the owner's
 *     approved English, and the reason travels to /validate;
 *   - No fair ticked, or an edit: nothing at all.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FairDefaultResponse } from '../vendor/scm/lib/fair-options-queries';

const fixture = vi.hoisted(() => ({ data: null as FairDefaultResponse | null }));

vi.mock('../vendor/scm/lib/fair-options-queries', async (orig) => ({
  ...(await orig<typeof import('../vendor/scm/lib/fair-options-queries')>()),
  useFairDefault: () => ({ data: fixture.data ?? undefined }),
}));

import { useAutoFair, type FairPickValue } from './FairPicker';

afterEach(() => { fixture.data = null; });

const BLANK: FairPickValue = { venue: null, organizer: null, startDate: null, endDate: null, day: null };
const IOI = { key: 'ioigecc|mle|2026-10-17|2026-10-20', venue: 'IOIGECC', organizer: 'MLE', startDate: '2026-10-17', endDate: '2026-10-20', projectIds: [2320] };
const TODAY: FairDefaultResponse = { date: '2026-10-19', event: IOI, how: 'ongoing', why: null, whyMessage: null };
const NO_FAIR_MSG = 'No fair found for you: you are not on Sales Attending for any fair in PMS. Pick a fair yourself, or ask the person in charge to add you.';

function Harness(props: { enabled: boolean; initial: FairPickValue; spy: (v: FairPickValue) => void }) {
  const [value, setValue] = useState(props.initial);
  const onChange = (next: FairPickValue) => { props.spy(next); setValue(next); };
  const auto = useAutoFair(props.enabled, value, onChange);
  return (
    <div>
      <output data-testid="value">{JSON.stringify(value)}</output>
      <output data-testid="why">{JSON.stringify(auto.why)}</output>
      {auto.hint}
      <button type="button" onClick={() => onChange(BLANK)}>clear</button>
    </div>
  );
}

const valueNow = () => JSON.parse(screen.getByTestId('value').textContent ?? 'null') as FairPickValue;

describe("useAutoFair — the keyer's fair on a new order", () => {
  it('fills a blank form with the fair running today, and says so', () => {
    fixture.data = TODAY;
    const spy = vi.fn();
    render(<Harness enabled initial={BLANK} spy={spy} />);
    expect(spy).toHaveBeenCalledTimes(1);
    /* Three days have passed at a 4-day fair, so the day is the operator's to pick. */
    expect(valueNow()).toEqual({ venue: 'IOIGECC', organizer: 'MLE', startDate: '2026-10-17', endDate: '2026-10-20', day: null });
    expect(screen.getByText(/Filled in: your fair today\./)).toBeTruthy();
  });

  it('fills the only day there is to pick, as a pick does', () => {
    fixture.data = { ...TODAY, event: { ...IOI, startDate: '2026-10-19', endDate: '2026-10-19' } };
    render(<Harness enabled initial={BLANK} spy={vi.fn()} />);
    expect(valueNow().day).toBe('2026-10-19');
  });

  it('replaces a place the form defaulted to, but never a fair someone picked', () => {
    fixture.data = { ...TODAY, how: 'latest' };
    render(<Harness enabled initial={{ ...BLANK, venue: 'IOIGECC' }} spy={vi.fn()} />);
    expect(valueNow().organizer).toBe('MLE');
    expect(screen.getByText(/Filled in: your latest fair\./)).toBeTruthy();

    const picked: FairPickValue = { venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-10-15', endDate: '2026-10-18', day: '2026-10-16' };
    const spy = vi.fn();
    render(<Harness enabled initial={picked} spy={spy} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fills ONCE: a fair the operator cleared is not filled back in', () => {
    fixture.data = TODAY;
    const spy = vi.fn();
    render(<Harness enabled initial={BLANK} spy={spy} />);
    act(() => { fireEvent.click(screen.getByText('clear')); });
    expect(valueNow()).toEqual(BLANK);
    expect(spy).toHaveBeenCalledTimes(2); // the fill, then the clear — no second fill
  });

  it('no fair found: fills nothing, says why, and hands the reason to /validate', () => {
    fixture.data = { date: '2026-10-19', event: null, how: null, why: { code: 'no_fair' }, whyMessage: NO_FAIR_MSG };
    const spy = vi.fn();
    render(<Harness enabled initial={BLANK} spy={spy} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toBe(NO_FAIR_MSG);
    expect(JSON.parse(screen.getByTestId('why').textContent ?? 'null')).toEqual({ code: 'no_fair' });
  });

  it('No fair ticked, or an edit: nothing filled, nothing said', () => {
    fixture.data = TODAY;
    const spy = vi.fn();
    render(<Harness enabled={false} initial={BLANK} spy={spy} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Filled in/)).toBeNull();
    expect(screen.getByTestId('why').textContent).toBe('null');
  });

  it('another company (the server answers nulls): nothing filled, nothing said', () => {
    fixture.data = { date: '2026-10-19', event: null, how: null, why: null, whyMessage: null };
    const spy = vi.fn();
    render(<Harness enabled initial={BLANK} spy={spy} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
