
import { useState } from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateTimeField, splitDateTimeLocal, joinDateTimeLocal } from './DateTimeField';

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
    expect(dateBox().value).toBe('2026/05/31');
    expect(timeBox().value).toBe('14:30');
  });

  test('an empty value renders both halves empty', () => {
    render(<Harness initial="" />);
    expect(dateBox().value).toBe('');
    expect(timeBox().value).toBe('');
  });

  test('a stored date-only value shows the date with an empty time', () => {
    render(<Harness initial="2026-05-31" />);
    expect(dateBox().value).toBe('2026/05/31');
    expect(timeBox().value).toBe('');
  });
});

describe('DateTimeField value contract', () => {
  test('the emitted string is byte-identical to the wall clock — no timezone shift', () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-05-31T00:00" onChange={onChange} />);
    expect(dateBox().value).toBe('2026/05/31');

    fireEvent.change(timeBox(), { target: { value: '23:59' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-05-31T23:59');
    expect(emitted()).toBe('2026-05-31T23:59');

    fireEvent.change(timeBox(), { target: { value: '00:00' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-05-31T00:00');
    expect(emitted()).toBe('2026-05-31T00:00');
  });

  test('typing a date day-first emits ISO', () => {
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(timeBox(), { target: { value: '09:15' } });
    fireEvent.change(dateBox(), { target: { value: '2026/02/01' } });
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
    fireEvent.change(dateBox(), { target: { value: '2026/06/01' } });
    expect(emitted()).toBe('2026-06-01T14:30');
  });
});

describe('DateTimeField half-filled state', () => {
  test('a date entered before a time STAYS on screen while the value is empty', () => {
    render(<Harness initial="" />);
    fireEvent.change(dateBox(), { target: { value: '2026/05/31' } });
    expect(emitted()).toBe('');
    expect(dateBox().value).toBe('2026/05/31');
    fireEvent.change(timeBox(), { target: { value: '08:00' } });
    expect(emitted()).toBe('2026-05-31T08:00');
  });

  test('a time entered before a date STAYS on screen while the value is empty', () => {
    render(<Harness initial="" />);
    fireEvent.change(timeBox(), { target: { value: '08:00' } });
    expect(emitted()).toBe('');
    expect(timeBox().value).toBe('08:00');
    fireEvent.change(dateBox(), { target: { value: '2026/05/31' } });
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
    expect(dateBox().value).toBe('2026/05/31');
    fireEvent.click(screen.getByText('load other row'));
    expect(dateBox().value).toBe('2027/12/25');
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

describe('DateTimeField half-filled disclosure', () => {
  test('a date with no time flags the TIME half, because nothing is being saved', () => {
    render(<Harness initial="" />);
    fireEvent.change(dateBox(), { target: { value: '2026/05/31' } });
    expect(emitted()).toBe('');
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
    expect(dateBox().value).toBe('2026/05/31');
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
