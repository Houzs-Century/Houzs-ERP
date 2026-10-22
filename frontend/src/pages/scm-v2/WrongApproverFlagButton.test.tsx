/* "This is not mine to approve" — the APPROVER passing a request to the other
   desk (owner 2026-09-17, option B). It first shipped as a checkbox in the
   requester's submit dialog, where nobody can judge it. Pinned: only someone who
   can sign a still-REQUESTED lane row is offered it, once; the note is required
   and is what gets sent; the ask names the desk it goes to; and a refusal from
   the server (a change the PO must follow) is shown in the server's own words. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  promptAnswer: null as string | null,
  promptArgs: null as null | { validate?: (v: string) => string | null; body?: string; title?: string; confirmLabel?: string },
  sent: [] as Array<{ id: string; note: string }>,
  fail: null as null | { status: number; body: string },
  notices: [] as Array<{ title: string; body?: string; tone?: string }>,
}));

vi.mock('../../vendor/scm/components/PromptDialog', () => ({
  usePrompt: () => async (args: { validate?: (v: string) => string | null; body?: string; title?: string; confirmLabel?: string }) => {
    state.promptArgs = args;
    return state.promptAnswer;
  },
}));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({
  useNotify: () => async (n: { title: string; body?: string; tone?: string }) => { state.notices.push(n); },
}));
// Not a super admin: the admin's "change approver" stays hidden in these tests.
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => false }) }));
vi.mock('../../vendor/scm/lib/so-amendment-queries', () => ({
  useChangeAmendmentLane: () => ({ isPending: false, mutateAsync: async () => {} }),
  useFlagAmendmentLane: () => ({
    isPending: false,
    mutateAsync: async (v: { id: string; note: string }) => {
      if (state.fail) throw state.fail;
      state.sent.push(v);
    },
  }),
}));

const { WrongApproverFlagButton, canFlagWrongApprover, WRONG_APPROVER_NOTE_TOO_SHORT } = await import('./WrongApproverFlagButton');

const open = { id: 'a1', amendment_no: 'HC-SO-1/A1', status: 'REQUESTED', lane: 'DELIVERY', lane_flag_note: null };

beforeEach(() => {
  state.promptAnswer = null; state.promptArgs = null; state.sent = []; state.fail = null; state.notices = [];
});

describe('canFlagWrongApprover', () => {
  test('only a signer, only on a REQUESTED lane row, only once', () => {
    expect(canFlagWrongApprover(open, true)).toBe(true);
    expect(canFlagWrongApprover(open, false)).toBe(false);
    expect(canFlagWrongApprover({ ...open, status: 'SO_APPROVED' }, true)).toBe(false);
    expect(canFlagWrongApprover({ ...open, lane: null }, true)).toBe(false);
    expect(canFlagWrongApprover({ ...open, lane_flag_note: 'Purchaser approves these' }, true)).toBe(false);
    expect(canFlagWrongApprover(null, true)).toBe(false);
  });
});

describe('WrongApproverFlagButton', () => {
  test('someone who cannot sign the row is offered nothing', () => {
    const { container } = render(<WrongApproverFlagButton amendment={open} canSign={false} variant="desktop" />);
    expect(container.textContent).toBe('');
  });

  test('the approver flags it with a note, which names the OTHER desk and is sent trimmed', async () => {
    state.promptAnswer = '  fabric change, Purchaser approves these ';
    render(<WrongApproverFlagButton amendment={open} canSign variant="desktop" />);
    fireEvent.click(screen.getByText('This is not mine to approve'));
    await waitFor(() => expect(state.sent).toEqual([{ id: 'a1', note: 'fabric change, Purchaser approves these' }]));
    expect(state.promptArgs?.title).toBe('Pass amendment HC-SO-1/A1 to Purchaser?');
    expect(state.promptArgs?.confirmLabel).toBe('Pass to Purchaser');
    expect(state.promptArgs?.body).toContain('moves to the Purchaser desk');
    expect(state.promptArgs?.validate?.('  ')).toBe(WRONG_APPROVER_NOTE_TOO_SHORT);
    expect(state.promptArgs?.validate?.('Purchaser approves these')).toBeNull();
    expect(state.notices[0].title).toBe('Passed to Purchaser');
  });

  test('cancelling the ask sends nothing', async () => {
    render(<WrongApproverFlagButton amendment={open} canSign variant="mobile" />);
    fireEvent.click(screen.getByText('This is not mine to approve'));
    await waitFor(() => expect(state.promptArgs).not.toBeNull());
    expect(state.sent).toEqual([]);
    expect(state.notices).toEqual([]);
  });

  test('a refusal is shown in the server\'s own words', async () => {
    state.promptAnswer = 'Logistic approves these';
    state.fail = { status: 409, body: JSON.stringify({ error: 'po_must_follow', reason: 'This request carries 1 product line change that the Purchase Order has to follow.' }) };
    render(<WrongApproverFlagButton amendment={{ ...open, lane: 'LINES' }} canSign variant="desktop" />);
    fireEvent.click(screen.getByText('This is not mine to approve'));
    await waitFor(() => expect(state.notices[0]?.tone).toBe('error'));
    expect(state.notices[0].title).toBe('Not passed to Logistic');
    expect(state.notices[0].body).toContain('the Purchase Order has to follow');
  });

  test('on the phone a saved note is shown to everyone, in place of the button', () => {
    render(<WrongApproverFlagButton amendment={{ ...open, lane_flag_note: 'Purchaser approves these' }} canSign={false} variant="mobile" />);
    expect(screen.getByText(/Passed here by the other approver: "Purchaser approves these"/)).toBeTruthy();
    expect(screen.queryByText('This is not mine to approve')).toBeNull();
  });
});
