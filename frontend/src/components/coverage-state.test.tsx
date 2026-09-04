// ----------------------------------------------------------------------------
// "Not loaded yet" must never render as an answer.
//
// Owner, 2026-09-02, two screenshots of the same PO drill-down seconds apart:
// the first showed every line tagged STOCK, the second the same lines carrying
// HC-SO-001162 · PENDING. 「这样很容易误导人 ... 我以为是 bugs」.
//
// Half of this is a BEHAVIOUR test (the cells) and half is a WIRING pin (the
// callers), because the failure mode is a caller that fetches a second query
// and forgets to say so — which no render test can see.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentLinesExpansion, type DocumentDrillLine } from './DocumentLinesExpansion';
import { SoSourceChips } from './SoSourceChips';
import { coverageStateOf } from './coverage-state';

const line: DocumentDrillLine = {
  itemGroup: 'bedframe', code: 'TRION-A-K', description: 'TRION (A)-(K)',
  description2: null, variants: null, qty: 1, amountSen: 0,
  assignedSos: [], deliveredDos: [],
};

describe('a drill-down cell never states an answer it does not have', () => {
  test('LOADING says so — it does not say STOCK', () => {
    render(<DocumentLinesExpansion isLoading={false} coverage="loading" lines={[line]} showAssignment />);
    expect(screen.getByText('WORKING…')).toBeTruthy();
    expect(screen.queryByText('STOCK')).toBeNull();
  });

  test('READY with nothing assigned is the honest empty answer, and still says STOCK', () => {
    render(<DocumentLinesExpansion isLoading={false} coverage="ready" lines={[line]} showAssignment />);
    expect(screen.getByText('STOCK')).toBeTruthy();
    expect(screen.queryByText('WORKING…')).toBeNull();
  });

  test('a FAILED read is not an empty result — it gets its own words', () => {
    render(<DocumentLinesExpansion isLoading={false} coverage="unavailable" lines={[line]} showAssignment />);
    expect(screen.getByText('NOT LOADED')).toBeTruthy();
    expect(screen.queryByText('STOCK')).toBeNull();
  });

  test('the LINES still render while coverage is loading — the list is not held back', () => {
    const { container } = render(
      <DocumentLinesExpansion isLoading={false} coverage="loading" lines={[line]} showAssignment />,
    );
    /* The whole point of the fix: the goods list is NOT held behind the second
       query — only the cell that depends on it says it is still working. */
    expect(container.textContent).toContain('TRION');
    expect(screen.queryByText('Loading lines…')).toBeNull();
  });

  test("Incoming PO shows WORKING, not a dash, before its query lands", () => {
    const { container } = render(<SoSourceChips line={{}} coverage="loading" />);
    expect(screen.getByText('WORKING…')).toBeTruthy();
    expect(container.textContent).not.toContain('—');
  });

  test('Incoming PO keeps the dash once the answer really is none', () => {
    render(<SoSourceChips line={{}} coverage="ready" />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('coverageStateOf maps a query to the three states', () => {
  test('loading beats error beats ready', () => {
    expect(coverageStateOf({ isLoading: true, isError: true })).toBe('loading');
    expect(coverageStateOf({ isLoading: false, isError: true })).toBe('unavailable');
    expect(coverageStateOf({ isLoading: false, isError: false })).toBe('ready');
    /* A caller that passes no isError still gets a usable answer rather than
       silently reading a failure as data. */
    expect(coverageStateOf({ isLoading: false })).toBe('ready');
  });
});
