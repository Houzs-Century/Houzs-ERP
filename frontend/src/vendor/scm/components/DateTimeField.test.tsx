/* DateTimeField — the INPUT half of "one date format".
 *
 * These pin the two things that make a display fix dangerous rather than the
 * thing it fixes: a field that stops CLEARING, and a field that shifts a day
 * across a timezone. Both are asserted directly below, and the whole file is
 * written so it passes identically under any TZ — the suite is run once under
 * a negative-offset zone in CI-equivalent form (see the round-trip test). */

import { useState } from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateTimeField, splitDateTimeLocal, joinDateTimeLocal } from './DateTimeField';

/* A controlled parent, because the interesting failure mode only exists when
   the emitted value round-trips back in as a prop. */
function Harness({ initial, onChange }: { initial: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <DateTimeField
        value={v}
        onChange={(next) => { setV(next); onChange?.(next); }}
        aria-label="Arrival"
      />
      <output data-testid="value">{v}</output>
    </>
  );
}

const dateBox = () => screen.getByLabelText('Arrival date') as HTMLInputElement;
const timeBox = () => screen.getByLabelText('Arrival time') as HTMLInputElement;
const emitted = () => screen.getByTestId('value').textContent;

describe('splitDateTimeLocal / joinDateTimeLocal', () => {
  test('splits a wall-clock value', () => {
    expect(splitDateTimeLocal('2026-05-31T14:30')).toEqual({ date: '2026-05-31', time: '14:30' });
  });

  test('tolerates the TIMESTAMPTZ shapes the callers slice down', () => {
    // DeliveryFieldsDrawer's toDtLocal is `iso.slice(0, 16)`, but a caller that
    // forgets the slice must degrade to a readable field, not a blank one.
    expect(splitDateTimeLocal('2026-05-31T14:30:00.000Z')).toEqual({ date: '2026-05-31', time: '14:30' });
    expect(splitDateTimeLocal('2026-05-31 14:30')).toEqual({ date: '2026-05-31', time: '14:30' });
  });

  test('a date-only value keeps its date and reports no time', () => {
    expect(splitDateTimeLocal('2026-05-31')).toEqual({ date: '2026-05-31', time: '' });
  });

  test('empty and malformed values are empty, never a fabricated date', () => {
    expect(splitDateTimeLocal('')).toEqual({ date: '', time: '' });
    expect(splitDateTimeLocal(null)).toEqual({ date: '', time: '' });
    expect(splitDateTimeLocal(undefined)).toEqual({ date: '', time: '' });
    expect(splitDateTimeLocal('not a date')).toEqual({ date: '', time: '' });
  });

  test('join emits nothing unless BOTH halves are present — native parity', () => {
    expect(joinDateTimeLocal('2026-05-31', '14:30')).toBe('2026-05-31T14:30');
    expect(joinDateTimeLocal('2026-05-31', '')).toBe('');
    expect(joinDateTimeLocal('', '14:30')).toBe('');
    expect(joinDateTimeLocal('', '')).toBe('');
  });

  test('split and join round-trip without touching the value', () => {
    const v = '2026-01-01T00:00';
    const { date, time } = splitDateTimeLocal(v);
    expect(joinDateTimeLocal(date, time)).toBe(v);
  });
});

describe('DateTimeField rendering', () => {
  test('shows the date half day-first, never in the OS locale', () => {
    render(<Harness initial="2026-05-31T14:30" />);
    // 31/05/2026 — not 05/31/2026, which is what a native datetime-local
    // renders on a US-locale machine and is the bug this component exists for.
    expect(dateBox().value).toBe('31/05/2026');
    expect(timeBox().value).toBe('14:30');
  });

  test('an empty value renders both halves empty', () => {
    render(<Harness initial="" />);
    expect(dateBox().value).toBe('');
    expect(timeBox().value).toBe('');
  });

  test('a stored date-only value shows the date with an empty time', () => {
    render(<Harness initial="2026-05-31" />);
    expect(dateBox().value).toBe('31/05/2026');
    expect(timeBox().value).toBe('');
  });
});

describe('DateTimeField value contract', () => {
  test('the emitted string is byte-identical to the wall clock — no timezone shift', () => {
    // The whole component is string arithmetic; nothing parses through Date.
    // A value on the far side of midnight is where a Date round-trip would
    // lose or gain a day west of Greenwich, so assert exactly that one.
    const onChange = vi.fn();
    render(<Harness initial="2026-05-31T00:00" onChange={onChange} />);
    expect(dateBox().value).toBe('31/05/2026');

    fireEvent.change(timeBox(), { target: { value: '23:59' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-05-31T23:59');
    expect(emitted()).toBe('2026-05-31T23:59');

    fireEvent.change(timeBox(), { target: { value: '00:00' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-05-31T00:00');
    // Same day out as went in.
    expect(emitted()).toBe('2026-05-31T00:00');
  });

  test('typing a date day-first emits ISO', () => {
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(timeBox(), { target: { value: '09:15' } });
    fireEvent.change(dateBox(), { target: { value: '01/02/2026' } });
    // 1 February, not 2 January.
    expect(onChange).toHaveBeenLastCalledWith('2026-02-01T09:15');
  });
});

describe('DateTimeField clearing', () => {
  test('CLEARING THE DATE empties the value, so the row saves null', () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-05-31T14:30" onChange={onChange} />);
    fireEvent.change(dateBox(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(emitted()).toBe('');
  });

  test('CLEARING THE TIME empties the value — native datetime-local parity, and it never invents 00:00', () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-05-31T14:30" onChange={onChange} />);
    fireEvent.change(timeBox(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(emitted()).toBe('');
  });

  test('a cleared field can be filled in again', () => {
    render(<Harness initial="2026-05-31T14:30" />);
    fireEvent.change(dateBox(), { target: { value: '' } });
    expect(emitted()).toBe('');
    fireEvent.change(dateBox(), { target: { value: '01/06/2026' } });
    expect(emitted()).toBe('2026-06-01T14:30');
  });
});

describe('DateTimeField half-filled state', () => {
  /* The regression this component could most easily have introduced: the
     emitted value is '' while only one half is filled, so a naive
     derive-from-props would wipe the half the operator just entered. */
  test('a date entered before a time STAYS on screen while the value is empty', () => {
    render(<Harness initial="" />);
    fireEvent.change(dateBox(), { target: { value: '31/05/2026' } });
    expect(emitted()).toBe('');            // incomplete — nothing saved yet
    expect(dateBox().value).toBe('31/05/2026'); // but still visible
    fireEvent.change(timeBox(), { target: { value: '08:00' } });
    expect(emitted()).toBe('2026-05-31T08:00');
  });

  test('a time entered before a date STAYS on screen while the value is empty', () => {
    render(<Harness initial="" />);
    fireEvent.change(timeBox(), { target: { value: '08:00' } });
    expect(emitted()).toBe('');
    expect(timeBox().value).toBe('08:00');
    fireEvent.change(dateBox(), { target: { value: '31/05/2026' } });
    expect(emitted()).toBe('2026-05-31T08:00');
  });

  test('clearing the date leaves the time visible, as a native control does', () => {
    render(<Harness initial="2026-05-31T14:30" />);
    fireEvent.change(dateBox(), { target: { value: '' } });
    expect(timeBox().value).toBe('14:30');
  });
});

describe('DateTimeField external updates', () => {
  test('a new value from the parent replaces both halves', () => {
    function Outer() {
      const [v, setV] = useState('2026-05-31T14:30');
      return (
        <>
          <DateTimeField value={v} onChange={setV} aria-label="Arrival" />
          <button onClick={() => setV('2027-12-25T06:45')}>load other row</button>
        </>
      );
    }
    render(<Outer />);
    expect(dateBox().value).toBe('31/05/2026');
    fireEvent.click(screen.getByText('load other row'));
    expect(dateBox().value).toBe('25/12/2027');
    expect(timeBox().value).toBe('06:45');
  });

  test('a parent that resets to empty clears both halves', () => {
    function Outer() {
      const [v, setV] = useState('2026-05-31T14:30');
      return (
        <>
          <DateTimeField value={v} onChange={setV} aria-label="Arrival" />
          <button onClick={() => setV('')}>reset</button>
        </>
      );
    }
    render(<Outer />);
    fireEvent.click(screen.getByText('reset'));
    expect(dateBox().value).toBe('');
    expect(timeBox().value).toBe('');
  });
});

describe('DateTimeField disabled', () => {
  test('disabled reaches both halves', () => {
    render(<DateTimeField value="2026-05-31T14:30" onChange={() => {}} disabled aria-label="Arrival" />);
    expect(dateBox().disabled).toBe(true);
    expect(timeBox().disabled).toBe(true);
  });
});

/* A HALF-FILLED control emits '' — that contract is native parity, is asserted
 * above, and does NOT change here. What changes is that the field now SAYS so.
 *
 * The gap it closes, found on the PMS stock-transfer form 2026-08-21: an
 * operator picks a date, leaves the time blank, and the date they picked STAYS
 * ON SCREEN while '' is what the form sends. The screen and the payload
 * disagree and nothing marks the difference — so the transfer saved with no
 * date at all, and its auto-created schedule task with no due date.
 *
 * Flagging the EMPTY half (never the filled one) is what makes the disagreement
 * visible without inventing a value the operator did not choose. */
describe('DateTimeField half-filled disclosure', () => {
  test('a date with no time flags the TIME half, because nothing is being saved', () => {
    render(<Harness initial="" />);
    fireEvent.change(dateBox(), { target: { value: '31/05/2026' } });
    // The contract is unchanged: still nothing emitted.
    expect(emitted()).toBe('');
    // ...but the field no longer stays silent about it.
    expect(timeBox().getAttribute('aria-invalid')).toBe('true');
    expect(dateBox().getAttribute('aria-invalid')).not.toBe('true');
  });

  test('a time with no date flags the DATE half', () => {
    render(<Harness initial="" />);
    fireEvent.change(timeBox(), { target: { value: '09:15' } });
    expect(emitted()).toBe('');
    expect(dateBox().getAttribute('aria-invalid')).toBe('true');
    expect(timeBox().getAttribute('aria-invalid')).not.toBe('true');
  });

  test('CLEARING THE TIME on a saved value flags it — the exact stock-transfer case', () => {
    render(<Harness initial="2026-05-31T14:30" />);
    fireEvent.change(timeBox(), { target: { value: '' } });
    expect(emitted()).toBe('');
    // The date is still on screen, so the flag is the only thing telling the
    // operator that what they can see is not what will be saved.
    expect(dateBox().value).toBe('31/05/2026');
    expect(timeBox().getAttribute('aria-invalid')).toBe('true');
  });

  test('a COMPLETE field is not flagged', () => {
    render(<Harness initial="2026-05-31T14:30" />);
    expect(dateBox().getAttribute('aria-invalid')).not.toBe('true');
    expect(timeBox().getAttribute('aria-invalid')).not.toBe('true');
  });

  test('a FULLY EMPTY field is not flagged — empty is a legitimate saved state', () => {
    render(<Harness initial="" />);
    expect(dateBox().getAttribute('aria-invalid')).not.toBe('true');
    expect(timeBox().getAttribute('aria-invalid')).not.toBe('true');
  });
});
