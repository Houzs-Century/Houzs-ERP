// NumberInput keeps the displayed text apart from the numeric value, so a typed
// leading zero never sticks ("0100") and, only where the field is 'signed', a
// lone "-" is not wiped. Everywhere else a minus is refused. These pin both.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { NumberInput, cleanNumericText, parseNumericText, type NumberSign } from './NumberInput';

function Harness({ sign, decimal, initial, emptyAs }: { sign: NumberSign; decimal: boolean; initial: number | null; emptyAs: number | null }) {
  const [v, setV] = useState<number | null>(initial);
  return (
    <>
      <NumberInput value={v} sign={sign} decimal={decimal} aria-label="n" onValueChange={(n) => setV(n ?? emptyAs)} />
      <span data-testid="v">{String(v)}</span>
    </>
  );
}

const box = () => screen.getByLabelText('n') as HTMLInputElement;
const val = () => screen.getByTestId('v').textContent;

describe('NumberInput — leading zero and sign', () => {
  test('a leading zero does not stick: "0100" shows while focused, normalises to "100" on blur', () => {
    render(<Harness sign="unsigned" decimal={false} initial={0} emptyAs={0} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '0100' } });
    expect(box().value).toBe('0100');
    expect(val()).toBe('100');
    fireEvent.blur(box());
    expect(box().value).toBe('100');
  });

  test('unsigned refuses a typed minus', () => {
    render(<Harness sign="unsigned" decimal={false} initial={0} emptyAs={0} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '-5' } });
    expect(box().value).toBe('5');
    expect(val()).toBe('5');
  });

  test('signed keeps a lone "-" then commits a negative', () => {
    render(<Harness sign="signed" decimal={false} initial={1} emptyAs={0} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '-' } });
    expect(box().value).toBe('-');
    expect(val()).toBe('0');
    fireEvent.change(box(), { target: { value: '-5' } });
    expect(box().value).toBe('-5');
    expect(val()).toBe('-5');
  });

  test('decimal keeps one dot and drops a second', () => {
    render(<Harness sign="unsigned" decimal initial={0} emptyAs={0} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '0012.5' } });
    expect(box().value).toBe('0012.5');
    expect(val()).toBe('12.5');
    fireEvent.change(box(), { target: { value: '12.5.3' } });
    expect(box().value).toBe('12.53');
  });

  test('an empty box emits null; a nullable caller stays empty on blur', () => {
    render(<Harness sign="unsigned" decimal={false} initial={7} emptyAs={null} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '' } });
    expect(val()).toBe('null');
    fireEvent.blur(box());
    expect(box().value).toBe('');
  });

  test('an external change updates the box while it is not focused', () => {
    function Ext() {
      const [v, setV] = useState<number | null>(1);
      return (
        <>
          <NumberInput value={v} sign="unsigned" decimal={false} aria-label="n" onValueChange={(n) => setV(n ?? 0)} />
          <button type="button" onClick={() => setV(99)}>cap</button>
        </>
      );
    }
    render(<Ext />);
    expect(box().value).toBe('1');
    fireEvent.click(screen.getByText('cap'));
    expect(box().value).toBe('99');
  });
});

describe('cleanNumericText / parseNumericText', () => {
  test('unsigned int strips minus and dot', () => {
    expect(cleanNumericText('-1.5abc', 'unsigned', false)).toBe('15');
  });
  test('signed int keeps only a leading minus', () => {
    expect(cleanNumericText('1-2-3', 'signed', false)).toBe('123');
    expect(cleanNumericText('-1-2', 'signed', false)).toBe('-12');
  });
  test('decimal keeps a single dot', () => {
    expect(cleanNumericText('1.2.3', 'unsigned', true)).toBe('1.23');
  });
  test('mid-type tokens parse to null', () => {
    expect(parseNumericText('')).toBeNull();
    expect(parseNumericText('-')).toBeNull();
    expect(parseNumericText('.')).toBeNull();
    expect(parseNumericText('12')).toBe(12);
    expect(parseNumericText('-3.5')).toBe(-3.5);
  });
});
