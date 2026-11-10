// The Upload drawer's render contract (the redesign, batch 3). What a report or
// an advice MEANS is pinned on the server; what is proved here is that the
// drawer sends what it was given and says what came back:
//
//   • Public Bank is asked which paper it is; nobody else is;
//   • an advice goes up as base64 under PBB, several one by one, each answered
//     on its own line, a refusal in the server's own words (§2.14);
//   • a report's lines are said as the design's piles, and a refused file
//     stays picked for Try again.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { AcquirerSetup } from './settlement-queries';

const state = vi.hoisted(() => ({
  report: vi.fn(),
  advice: vi.fn(),
}));

vi.mock('./settlement-queries', () => ({
  useUploadStatement: () => ({ mutateAsync: state.report, isPending: false }),
  useUploadPayoutAdvice: () => ({ mutateAsync: state.advice, isPending: false }),
}));

import { MerchantUploadDrawer } from './MerchantUpload';

const acq = (code: string, over: Partial<AcquirerSetup> = {}): AcquirerSetup => ({
  code, display_name: code === 'PBB' ? 'Public Bank card machine' : `${code} card machine`, statement_format: 'csv', has_unique_ref: true,
  fee_method: null, date_tolerance_days: 3, column_map: null, transit_account_code: '320-0000', fee_account_code: '900-T009',
  bank_account_code: '310-0001', is_active: true, ready: true, autoMatchable: true, ...over,
} as AcquirerSetup);
const ACQUIRERS = [acq('MBB'), acq('PBB'), acq('GHL', { autoMatchable: false } as Partial<AcquirerSetup>)];

const csv = (name: string) => {
  const f = new File(['Txn Date,Gross'], name, { type: 'text/csv' });
  /* jsdom's File carries no .text() — the drawer reads the file with it. */
  Object.defineProperty(f, 'text', { value: () => Promise.resolve('Txn Date,Gross') });
  return f;
};
const pdf = (name: string) => new File(['%PDF-1.4 advice bytes'], name, { type: 'application/pdf' });

describe('which paper', () => {
  test('Public Bank is asked whether it is the report or the advice; another acquirer is not', () => {
    const first = render(<MerchantUploadDrawer acq="PBB" acquirers={ACQUIRERS} startWith={null} onClose={vi.fn()} />);
    expect(screen.getByText('What are you uploading?')).toBeTruthy();
    expect(screen.queryByLabelText('Statement files')).toBeNull();
    fireEvent.click(screen.getByText('Payment advice'));
    expect(screen.getByLabelText('Payment advice PDF')).toBeTruthy();
    expect(screen.getByText('Upload PBB payment advice')).toBeTruthy();
    first.unmount();
    render(<MerchantUploadDrawer acq="MBB" acquirers={ACQUIRERS} startWith={null} onClose={vi.fn()} />);
    expect(screen.queryByText('What are you uploading?')).toBeNull();
    expect(screen.getByLabelText('Statement files').hasAttribute('multiple')).toBe(true);
  });
});

describe('the advice', () => {
  test('is dead until a file is chosen, then goes up as base64 under PBB', async () => {
    state.advice.mockReset().mockResolvedValue({
      ok: true, payoutId: 9,
      status: { netSen: 1189800, readyToReceive: false, blockedBy: null, days: [{ state: 'AGREES' }, { state: 'DIFFERS' }, { state: 'REPORT_MISSING' }] },
    });
    render(<MerchantUploadDrawer acq="PBB" acquirers={ACQUIRERS} startWith="advice" onClose={vi.fn()} />);
    const go = screen.getByRole('button', { name: /Upload advice/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Payment advice PDF'), { target: { files: [pdf('HOUZSCENTURY_IBG_240826.pdf')] } });
    /* FileReader hands the drawer its base64 asynchronously. */
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(state.advice).toHaveBeenCalledTimes(1));
    const [body] = state.advice.mock.calls[0] as [{ acquirerCode: string; fileName: string; contentBase64: string }];
    expect(body.acquirerCode).toBe('PBB');
    expect(body.fileName).toBe('HOUZSCENTURY_IBG_240826.pdf');
    expect(body.contentBase64).toMatch(/^data:application\/pdf;base64,/);
    expect(await screen.findByText(/3 settlement days · RM 11,898\.00/)).toBeTruthy();
    expect(screen.getByText('day agrees with its report')).toBeTruthy();
    expect(screen.getByText('day differs from its report')).toBeTruthy();
    expect(screen.getByText('day waits for its report')).toBeTruthy();
  });

  /* Owner 2026-09-12: 要支持上传多份. Each goes up on its own, in the order picked. */
  test('several go up one by one, each answered on its own line', async () => {
    state.advice.mockReset().mockImplementation(async (b: { fileName: string }) => {
      if (b.fileName.includes('BAD')) throw new Error('The advice names no settlement day.');
      return { ok: true, payoutId: 9, status: { netSen: 1189800, readyToReceive: true, blockedBy: null, days: [{ state: 'AGREES' }, { state: 'AGREES' }] } };
    });
    render(<MerchantUploadDrawer acq="PBB" acquirers={ACQUIRERS} startWith="advice" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Payment advice PDF'), {
      target: { files: ['HOUZSCENTURY_IBG_100826.pdf', 'HOUZSCENTURY_IBG_BAD.pdf', 'HOUZSCENTURY_IBG_170826.pdf'].map(pdf) },
    });
    const go = screen.getByRole('button', { name: /Upload advice/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(state.advice).toHaveBeenCalledTimes(3));
    expect((state.advice.mock.calls as Array<[{ fileName: string }]>).map(([b]) => b.fileName))
      .toEqual(['HOUZSCENTURY_IBG_100826.pdf', 'HOUZSCENTURY_IBG_BAD.pdf', 'HOUZSCENTURY_IBG_170826.pdf']);
    expect(await screen.findByText('The advice names no settlement day.')).toBeTruthy();
    expect(screen.getAllByText(/2 settlement days · RM 11,898\.00/)).toHaveLength(2);
    /* The refused one stays picked, and the button says so. */
    expect(screen.getByRole('button', { name: /Try again \(1\)/ })).toBeTruthy();
  });
});

describe('a merchant report', () => {
  test('its lines are said as the piles they fell into, and Done hands what it made to the page', async () => {
    state.report.mockReset().mockResolvedValue({
      batchId: 41, rows: 11, skippedLines: 0, alreadyOnReport: 0, alreadyOnReportDetail: [], statedNetSen: null, adjustmentSen: 0,
      grossSen: 1868000, feeSen: 10446, netSen: 1857554, periodFrom: '2026-10-27', periodTo: '2026-10-27',
      buckets: { MATCHED: 7, NEEDS_CONFIRM: 3, UNMATCHED: 1 },
    });
    const onClose = vi.fn();
    render(<MerchantUploadDrawer acq="MBB" acquirers={ACQUIRERS} startWith={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Statement files'), { target: { files: [csv('mbb-1027.csv')] } });
    const go = screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    expect(await screen.findByText('11 lines · 2026/10/27 · gross RM 18,680.00 · fees RM 104.46')).toBeTruthy();
    expect(screen.getByText('matched by reference')).toBeTruthy();
    expect(screen.getByText('Added to To do as “Confirm 7 merchant lines”')).toBeTruthy();
    expect(screen.getByText('fit more than one order')).toBeTruthy();
    expect(screen.getByText('has no payment recorded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: 'report', batchIds: [41] }));
  });

  test('a refused file is named in the server\'s words and stays picked for Try again', async () => {
    state.report.mockReset().mockRejectedValue(new Error('This file has no Txn Date column — it is not a MBB merchant report.'));
    render(<MerchantUploadDrawer acq="MBB" acquirers={ACQUIRERS} startWith={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Statement files'), { target: { files: [csv('wrong.csv')] } });
    const go = screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    expect(await screen.findByText(/it is not a MBB merchant report/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again \(1\)/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  /* "1,234.50" through Number() was NaN, went up as null and the statement
     fee total was silently dropped. */
  test('a statement fee typed with a thousands comma goes up as that amount; an unreadable one is refused', async () => {
    const PRO = [acq('MBB', { fee_method: 'prorated-summary' } as Partial<AcquirerSetup>)];
    state.report.mockReset().mockResolvedValue({
      batchId: 42, rows: 1, skippedLines: 0, alreadyOnReport: 0, alreadyOnReportDetail: [], statedNetSen: null, adjustmentSen: 0,
      grossSen: 100, feeSen: 1, netSen: 99, periodFrom: '2026-10-27', periodTo: '2026-10-27', buckets: {},
    });
    const first = render(<MerchantUploadDrawer acq="MBB" acquirers={PRO} startWith={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Statement files'), { target: { files: [csv('mbb.csv')] } });
    fireEvent.change(screen.getByLabelText('Statement fee total'), { target: { value: '1,234.50' } });
    const go = screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(state.report).toHaveBeenCalledWith(expect.objectContaining({ summaryFeeSen: 123450 })));
    first.unmount();

    state.report.mockClear();
    render(<MerchantUploadDrawer acq="MBB" acquirers={PRO} startWith={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Statement files'), { target: { files: [csv('mbb.csv')] } });
    fireEvent.change(screen.getByLabelText('Statement fee total'), { target: { value: 'twelve' } });
    const again = screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);
    expect(await screen.findByText(/The statement fee total isn't a number we can read/)).toBeTruthy();
    expect(state.report).not.toHaveBeenCalled();
  });

  test('an acquirer with no unique reference is called out before anything goes up', () => {
    render(<MerchantUploadDrawer acq="GHL" acquirers={ACQUIRERS} startWith={null} onClose={vi.fn()} />);
    expect(screen.getByText(/sends no unique reference/)).toBeTruthy();
  });
});
