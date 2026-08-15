// Guards the 2026-08-15 clipping fix for the customer-name typeahead, which was
// four copies of the same JSX across the SO and consignment forms and portalled
// in exactly one of them.
//
// WHAT THIS CANNOT PROVE. jsdom does no layout, so nothing here shows pixels are
// no longer sliced — that was measured in a browser against the real
// `.card { overflow: hidden }` markup. What IS mechanically checkable is the
// property the clip depended on: the list being a descendant of the clipping
// ancestor. Same split the StatePicker and PhoneInput suites document.
//
// Unmount is handled by the global afterEach(cleanup) in src/test-setup.ts.

import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test } from 'vitest';
import { DebtorSuggestList } from './DebtorSuggestList';

const ROWS = [
  { debtor_code: '300-C001', debtor_name: 'Ng Wei Ming', phone: '+60164577123' },
  { debtor_code: null, debtor_name: 'Ng Siew Lan', phone: null },
  ...Array.from({ length: 10 }, (_, i) => ({
    debtor_code: `300-C1${i}`,
    debtor_name: `Filler ${i}`,
    phone: null,
  })),
];

const CLASSES = { list: 'lst', item: 'itm', code: 'cde' };

/** The form's own clipping ancestor — the shape that caused the bug. */
function Host({
  open = true,
  suggestions = ROWS,
  onPick = () => {},
}: {
  open?: boolean;
  suggestions?: typeof ROWS;
  onPick?: (row: (typeof ROWS)[number]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div data-testid="clipper" style={{ overflow: 'hidden', height: 60 }}>
      <input ref={ref} aria-label="Customer Name" />
      <DebtorSuggestList
        anchorRef={ref}
        open={open}
        suggestions={suggestions}
        onPick={onPick}
        classes={CLASSES}
      />
    </div>
  );
}

const list = () => document.querySelector('.lst') as HTMLElement;

describe('DebtorSuggestList placement', () => {
  test('the open list is portalled to <body>, not left inside the clipping ancestor', () => {
    render(<Host />);
    expect(list().parentElement).toBe(document.body);
    expect(screen.getByTestId('clipper').contains(list())).toBe(false);
  });

  test('it is positioned fixed, so no ancestor overflow can clip it', () => {
    render(<Host />);
    expect(list().style.position).toBe('fixed');
    expect(list().style.maxHeight).not.toBe('');
  });

  test('the CSS module`s own margin-top is overridden — the gap is in the measured top', () => {
    render(<Host />);
    expect(list().style.marginTop).toBe('0px');
  });
});

describe('DebtorSuggestList behaviour', () => {
  test('renders nothing when closed', () => {
    render(<Host open={false} />);
    expect(document.querySelector('.lst')).toBeNull();
  });

  test('renders nothing when there are no suggestions', () => {
    render(<Host suggestions={[]} />);
    expect(document.querySelector('.lst')).toBeNull();
  });

  test('caps the list at eight rows', () => {
    render(<Host />);
    expect(list().querySelectorAll('li')).toHaveLength(8);
  });

  test('commits on mouseDown, before the input`s blur can close the list', () => {
    const picked: string[] = [];
    render(<Host onPick={(r) => picked.push(r.debtor_name ?? '')} />);
    fireEvent.mouseDown(screen.getByText('Ng Wei Ming'));
    expect(picked).toEqual(['Ng Wei Ming']);
  });

  test('shows the code + formatted phone line only when there is one', () => {
    render(<Host />);
    const rows = list().querySelectorAll('li');
    expect(rows[0].querySelector('.cde')?.textContent).toContain('300-C001');
    expect(rows[1].querySelector('.cde')).toBeNull();
  });
});
