// The Bank statements Upload drawer's render contract (the redesign, batch 3).
// What a statement MEANS is pinned on the server; what is proved here is that
// the drawer sends what it was given and says what came back:
//
//   • the Year and month box says what it does and what it does not do
//     (docs/bugs/0794, and the whole-month meaning for a dated file);
//   • a PDF goes up as the text pdf.js read off it, marked PDF; a CSV as its
//     text, marked CSV (docs/bugs/0869);
//   • the result is said as the design's piles, and Done hands the page the
//     account and the month the file starts in.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock('../../vendor/scm/lib/pdf-text', () => ({
  PDF_TEXT_KIND: 'houzs-pdf-text/1',
  extractPdfText: vi.fn(async () => ({ kind: 'houzs-pdf-text/1', pages: [{ lines: [{ y: 693, cells: [{ x: 449, t: '31/08/26' }] }] }] })),
}));

vi.mock('./bank-queries', () => ({
  useBankSetup: () => ({
    data: {
      accounts: [{ account_code: '310-0010', bank_code: 'MBB', bank_name: 'Maybank', account_name: 'MAYBANK CA', account_no: '0000564418610346', statement_format: 'CSV', is_active: true, ready: true }],
      recognises: ['MBB', 'PBB', 'AEON', 'HLB'],
    },
    isLoading: false,
  }),
  useUploadBankStatement: () => ({ mutate: state.upload, isPending: false }),
}));

import { BankUploadDrawer } from './BankUpload';

const pick = async (file: File, account: string | null = null) => {
  render(<BankUploadDrawer account={account} onClose={vi.fn()} />);
  if (!account) fireEvent.change(screen.getByLabelText('Bank account'), { target: { value: '310-0010' } });
  const input = screen.getByLabelText('Bank statement file') as HTMLInputElement;
  expect(input.accept).toContain('.pdf');
  fireEvent.change(input, { target: { files: [file] } });
  const go = () => screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
  await waitFor(() => expect(go().disabled).toBe(false));
  fireEvent.click(go());
  expect(state.upload).toHaveBeenCalledTimes(1);
  return state.upload.mock.calls[0]![0] as { fileName: string; format: string; content: string; accountCode: string };
};

describe('the year-and-month box', () => {
  /* docs/bugs/0794: the month box is ALSO how a file with no transactions is filed. */
  test('says it also files a statement that carries no transactions, and that a dated file it names covers the whole month', () => {
    render(<BankUploadDrawer account="310-0010" onClose={vi.fn()} />);
    expect(screen.getByLabelText('Statement month')).toBeTruthy();
    expect(screen.getByText(/no transactions at all/)).toBeTruthy();
    expect(screen.getByText(/covers that whole month/)).toBeTruthy();
  });

  test('names which acquirers can be recognised at all, and the account it is for', () => {
    render(<BankUploadDrawer account="310-0010" onClose={vi.fn()} />);
    expect(screen.getByText(/Card money is recognised for MBB, PBB, AEON, HLB/)).toBeTruthy();
    expect(screen.getByText('Upload Maybank statement')).toBeTruthy();
    expect(screen.getByText('Maybank · 310-0010 · 0000564418610346')).toBeTruthy();
  });
});

/* The bank's monthly statement PDF (owner 2026-09-14: 也支持 csv，也支持 pdf). */
describe('uploading', () => {
  test('a picked .pdf is sent as its extracted text, marked PDF', async () => {
    state.upload.mockReset();
    const sent = await pick(new File(['%PDF-1.4'], 'MBBcurrent_564418759397_2026-08-31.pdf', { type: 'application/pdf' }));
    expect(sent).toMatchObject({ accountCode: '310-0010', fileName: 'MBBcurrent_564418759397_2026-08-31.pdf', format: 'PDF' });
    expect(JSON.parse(sent.content)).toMatchObject({ kind: 'houzs-pdf-text/1', pages: [{ lines: [{ y: 693 }] }] });
  });

  test('a picked .csv is sent as its text, marked CSV, as it always was', async () => {
    state.upload.mockReset();
    const sent = await pick(new File(['EFFECT DATE|AMOUNT\n20260605|100'], 'aug.csv', { type: 'text/csv' }), '310-0010');
    expect(sent).toMatchObject({ fileName: 'aug.csv', format: 'CSV', content: 'EFFECT DATE|AMOUNT\n20260605|100' });
  });

  test('the result is said as piles, and Done hands the page the account and the month', async () => {
    state.upload.mockReset().mockImplementation((_body: unknown, opts: { onSuccess: (r: unknown) => void }) => opts.onSuccess({
      ok: true, statementId: 77, lines: 41, joinedPairs: 0, skippedLines: 0, alreadyRecorded: 2, autoMatched: 34, contraPairs: 0,
      periodFrom: '2026-10-22', periodTo: '2026-10-28', inSen: 5881800, outSen: 120000, openingBalanceSen: null, closingBalanceSen: 5881800, kinds: {},
    }));
    const onClose = vi.fn();
    render(<BankUploadDrawer account="310-0010" onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Bank statement file'), { target: { files: [new File(['x'], 'mbb-1028.csv', { type: 'text/csv' })] } });
    const go = screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    expect(await screen.findByText('41 movements · 2026/10/22 → 2026/10/28 · RM 58,818.00 in · RM 1,200.00 out')).toBeTruthy();
    expect(screen.getByText('matched automatically')).toBeTruthy();
    expect(screen.getByText('Added to To do as “Decide 5 Maybank lines”')).toBeTruthy();
    expect(screen.getByText('already recorded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith({ accountCode: '310-0010', statementId: 77, month: '2026-10' });
  });

  test('a refusal is the server\'s own sentence, and nothing is said as read', async () => {
    state.upload.mockReset().mockImplementation((_body: unknown, opts: { onError: (e: unknown) => void }) => opts.onError(new Error('This file has no EFFECT DATE column — it is not a Maybank statement.')));
    render(<BankUploadDrawer account="310-0010" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Bank statement file'), { target: { files: [new File(['x'], 'wrong.csv', { type: 'text/csv' })] } });
    const go = screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    expect(await screen.findByText(/it is not a Maybank statement/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });
});
