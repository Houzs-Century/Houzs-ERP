/* The shared "submit this amendment?" ask (owner 2026-09-15, option B). Pinned:
   the dialog SHOWS the desk the server will route to, in the approver's own
   word; a blank reason cannot be confirmed; the requester is NOT asked to flag
   the approver (owner 2026-09-17 — that is the approver's call); Cancel answers null;
   and a preview that failed still lets the requester submit — the server
   routes by the rule either way. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useState } from 'react';

const previewState = vi.hoisted(() => ({
  data: null as null | { lanes: string[]; perLane: Record<string, { lineCount: number; headerKeys: string[] }> },
  isLoading: false,
  isError: false,
}));

vi.mock('../lib/so-amendment-queries', () => ({
  useAmendmentLanePreview: () => previewState,
}));

const { useAmendmentSubmitDialog, describeLanePreview } = await import('./AmendmentSubmitDialog');
const { AMENDMENT_REASON_REQUIRED } = await import('../lib/so-amendment-submit');

const Asker = () => {
  const dialog = useAmendmentSubmitDialog();
  const [answer, setAnswer] = useState('unasked');
  return (
    <div>
      <button type="button" onClick={async () => {
        const r = await dialog.ask({ docNo: 'HC-SO-012757', lines: [{ changeType: 'ADD', newItemCode: 'TRANSPORTATION CHARGES' }] });
        setAnswer(r === null ? 'null' : JSON.stringify(r));
      }}>ask</button>
      <output>{answer}</output>
      {dialog.element}
    </div>
  );
};

const open = () => {
  render(<Asker />);
  fireEvent.click(screen.getByText('ask'));
};
const answer = () => screen.getByRole('status').textContent;

describe('AmendmentSubmitDialog', () => {
  test('names the desk the server will route to, per lane, in the approver word', () => {
    previewState.data = {
      lanes: ['LINES', 'DELIVERY'],
      perLane: {
        LINES: { lineCount: 2, headerKeys: ['processingDate'] },
        DELIVERY: { lineCount: 1, headerKeys: [] },
      },
    };
    previewState.isError = false;
    open();
    const box = screen.getByTestId('lane-preview');
    expect(box.textContent).toContain('Purchaser');
    expect(box.textContent).toContain('approves 2 line changes, Processing Date');
    expect(box.textContent).toContain('Logistic');
    expect(box.textContent).toContain('approves 1 line change');
    expect(box.textContent).toContain('2 desks are involved');
    expect(box.textContent).toContain('2 amendments');
  });

  test('a blank reason cannot be confirmed; a reason alone is the whole answer', async () => {
    previewState.data = { lanes: ['DELIVERY'], perLane: { LINES: { lineCount: 0, headerKeys: [] }, DELIVERY: { lineCount: 1, headerKeys: [] } } };
    open();
    fireEvent.click(screen.getByText('Submit amendment'));
    expect(screen.getByText(AMENDMENT_REASON_REQUIRED)).toBeTruthy();
    expect(answer()).toBe('unasked');

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  last min cancellation penalty ' } });
    fireEvent.click(screen.getByText('Submit amendment'));
    await waitFor(() => expect(answer()).toBe(JSON.stringify({ reason: 'last min cancellation penalty' })));
  });

  /* Owner 2026-09-17: the requester cannot judge the desk, so the submit dialog
     no longer asks. The flag lives on the approver's job card (WrongApproverFlagButton). */
  test('the requester is not asked whether the approver looks wrong', () => {
    previewState.data = { lanes: ['LINES'], perLane: { LINES: { lineCount: 1, headerKeys: [] }, DELIVERY: { lineCount: 0, headerKeys: [] } } };
    open();
    expect(screen.queryByText(/approver looks wrong/i)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  test('Cancel answers null', async () => {
    previewState.data = { lanes: ['LINES'], perLane: { LINES: { lineCount: 1, headerKeys: [] }, DELIVERY: { lineCount: 0, headerKeys: [] } } };
    open();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(answer()).toBe('null'));
  });

  test('a failed preview says so and still lets the requester submit', async () => {
    previewState.data = null;
    previewState.isError = true;
    open();
    expect(screen.getByTestId('lane-preview').textContent).toContain('Could not work out the approver yet');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'penalty' } });
    fireEvent.click(screen.getByText('Submit amendment'));
    await waitFor(() => expect(answer()).toBe(JSON.stringify({ reason: 'penalty' })));
    previewState.isError = false;
  });
});

describe('describeLanePreview', () => {
  test('lists only the lanes present, counting lines and naming header fields', () => {
    expect(describeLanePreview({
      lanes: ['DELIVERY'],
      perLane: {
        LINES: { lineCount: 0, headerKeys: [] },
        DELIVERY: { lineCount: 0, headerKeys: ['customerDeliveryDate', 'postcode'] },
        PRICE: { lineCount: 0, headerKeys: [] },
      },
    })).toEqual([{ lane: 'DELIVERY', text: 'Delivery Date, Postcode' }]);
  });

  test('describes a PRICE lane (2990 price-only) by its line count', () => {
    expect(describeLanePreview({
      lanes: ['PRICE'],
      perLane: {
        LINES: { lineCount: 0, headerKeys: [] },
        DELIVERY: { lineCount: 0, headerKeys: [] },
        PRICE: { lineCount: 1, headerKeys: [] },
      },
    })).toEqual([{ lane: 'PRICE', text: '1 line change' }]);
  });
});
