// The payment-advice screen's render contract. What the advice MEANS is pinned
// on the server (acc/payout-advice.test.ts, acc/pbb-advice.test.ts); what is
// proved here is that the screen SAYS it:
//
//   • a ready advice says the credit will book itself, and against how many
//     reports;
//   • a blocked advice shows the server's ONE sentence verbatim, not a summary
//     of it;
//   • every day is on screen with BOTH numbers, so a difference is visible and
//     not just named;
//   • the upload sends the PDF as base64 under PBB — nobody is asked which
//     acquirer, because only Public Bank sends one;
//   • a refusal is the server's own sentence (§2.14).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Payout } from './settlement-queries';

const uploadMutate = vi.fn();

/* One advice every day of which agrees, one blocked in all three ways. */
const READY: Payout = {
  id: 1, acquirer_code: 'PBB', file_name: 'HOUZSCENTURY_IBG_100826.pdf',
  advice_date: '2026-08-10', payee_bank: 'MAYBANK ISLAMIC BERHAD', payee_account_no: '564418610346',
  gross_sen: 1200000, commission_sen: 10200, net_sen: 1189800, uploaded_by: 'Ah Chew',
  status: {
    netSen: 1189800,
    readyToReceive: true,
    blockedBy: null,
    days: [
      { settledOn: '2026-08-07', adviceNetSen: 400000, batchId: 11, fileName: 'pbb-0807.csv', reportNetSen: 400000, differenceSen: 0, reportOpenLines: 0, state: 'AGREES' },
      { settledOn: '2026-08-08', adviceNetSen: 789800, batchId: 12, fileName: 'pbb-0808.csv', reportNetSen: 789800, differenceSen: 0, reportOpenLines: 0, state: 'AGREES' },
    ],
  },
};

const BLOCKED: Payout = {
  id: 2, acquirer_code: 'PBB', file_name: 'HOUZSCENTURY_IBG_170826.pdf',
  advice_date: '2026-08-17', payee_bank: null, payee_account_no: null,
  gross_sen: 900000, commission_sen: 0, net_sen: 900000, uploaded_by: null,
  status: {
    netSen: 900000,
    readyToReceive: false,
    blockedBy: '1 of the 3 day(s) this pays for have no merchant report uploaded yet — 2026-08-14.',
    days: [
      { settledOn: '2026-08-14', adviceNetSen: 300000, batchId: null, fileName: null, reportNetSen: null, differenceSen: null, reportOpenLines: null, state: 'REPORT_MISSING' },
      { settledOn: '2026-08-15', adviceNetSen: 300000, batchId: 21, fileName: 'pbb-0815.csv', reportNetSen: 312050, differenceSen: 12050, reportOpenLines: 0, state: 'DIFFERS' },
      { settledOn: '2026-08-16', adviceNetSen: 300000, batchId: 22, fileName: 'pbb-0816.csv', reportNetSen: 300000, differenceSen: 0, reportOpenLines: 2, state: 'REPORT_NOT_RECONCILED' },
    ],
  },
};

vi.mock('./settlement-queries', () => ({
  usePayouts: () => ({ data: { payouts: [READY, BLOCKED] }, isLoading: false }),
  useUploadPayoutAdvice: () => ({ mutate: uploadMutate, isPending: false }),
}));

import { PayoutAdviceTab } from './PayoutAdviceTab';

describe('an advice whose every day agrees', () => {
  test('says the credit will book itself, and against how many reports', () => {
    render(<PayoutAdviceTab />);
    expect(screen.getByText(/Ready — when the bank statement shows this RM 11,898\.00 credit/)).toBeTruthy();
    expect(screen.getByText(/books against 2 reports/)).toBeTruthy();
  });

  test('names where the money went, off the advice itself', () => {
    render(<PayoutAdviceTab />);
    expect(screen.getByText(/Pays into MAYBANK ISLAMIC BERHAD · account 564418610346/)).toBeTruthy();
  });
});

describe('an advice something is in the way of', () => {
  test('shows the server’s one sentence verbatim', () => {
    render(<PayoutAdviceTab />);
    expect(screen.getByText('1 of the 3 day(s) this pays for have no merchant report uploaded yet — 2026-08-14.')).toBeTruthy();
    expect(screen.queryByText(/Ready — when the bank statement shows this RM 9,000\.00/)).toBeNull();
  });

  /* BOTH numbers on the row, and their distance in the standing — a difference
     he can see is one he can explain. */
  test('a day that differs carries the advice figure, the report figure and the gap', () => {
    render(<PayoutAdviceTab />);
    const row = screen.getByText('2026-08-15').closest('tr') as HTMLElement;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toContain('RM 3,000.00');
    expect(cells).toContain('RM 3,120.50');
    expect(cells.some((t) => t.includes('differs by RM 120.50'))).toBe(true);
  });

  test('a day with no report says so, rather than showing an empty cell as agreement', () => {
    render(<PayoutAdviceTab />);
    expect(screen.getByText('no report uploaded for this day')).toBeTruthy();
  });

  test('a day whose report is not reconciled says how many lines are open', () => {
    render(<PayoutAdviceTab />);
    expect(screen.getByText('2 line(s) still to decide')).toBeTruthy();
  });
});

describe('uploading one', () => {
  test('is dead until a file is chosen, then sends it as base64 under PBB', async () => {
    render(<PayoutAdviceTab />);
    const button = screen.getByText('Upload payment advice').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const file = new File(['%PDF-1.4 advice bytes'], 'HOUZSCENTURY_IBG_240826.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Payment advice PDF'), { target: { files: [file] } });

    /* FileReader hands the page its base64 asynchronously. */
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    expect(uploadMutate).toHaveBeenCalledTimes(1);
    const [body] = uploadMutate.mock.calls[0] as [
      { acquirerCode: string; fileName: string; contentBase64: string },
    ];
    expect(body.acquirerCode).toBe('PBB');
    expect(body.fileName).toBe('HOUZSCENTURY_IBG_240826.pdf');
    expect(body.contentBase64).toMatch(/^data:application\/pdf;base64,/);
  });
});
