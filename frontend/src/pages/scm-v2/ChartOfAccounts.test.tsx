/* The Chart maintenance page (owner 2026-09-02: 类似recon setup 我tick 后选择
   这个公司要不要用). What is pinned:
     · parseChartXlsx reads the AutoCount report shape — digit AND letter
       codes, 4-space indent → parent, section → type, SBK/SCH → money,
       banks/related-party/directors/HP pre-classified HOUZS-only;
     · the tree renders parents bold with children indented, one tick column
       per company;
     · ticking calls the tick mutation with the right company+code; unticking
       a header warns about its children first;
     · the upload preview counts shared vs HOUZS-only and imports on confirm.
   The server half is backend/tests/accountingChart.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import * as XLSX from 'xlsx';

const tickAsync = vi.fn(async (_b: unknown) => ({}));
const importAsync = vi.fn(async (_b: unknown) => ({ ok: true, imported: 3, shared: 2, sharedTo: [2] }));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  useChartUnion: () => ({ data: { companies: [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }], accounts: [
    { code: '310-0000', name: 'CASH AT BANK', type: 'ASSET', parentCode: null, accMoney: false, perCompany: { 1: { active: true } } },
    { code: '310-0010', name: 'CASH AT BANK - MAYBANK', type: 'ASSET', parentCode: '310-0000', accMoney: true, perCompany: { 1: { active: true } } },
    { code: '900-A002', name: 'ADVERTISEMENT', type: 'EXPENSE', parentCode: null, accMoney: false, perCompany: { 1: { active: true }, 2: { active: true } } },
  ] }, isLoading: false, error: null }),
  useChartTick: () => ({ mutateAsync: tickAsync, isPending: false }),
  useChartImport: () => ({ mutateAsync: importAsync, isPending: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { ChartOfAccounts, parseChartXlsx } from './ChartOfAccounts';

const draw = () => render(<MemoryRouter><ChartOfAccounts /></MemoryRouter>);

describe('parseChartXlsx — the AutoCount report shape', () => {
  test('digit + letter codes, indent → parent, section → type, SBK/SCH → money, exclusives stay home', () => {
    const aoa = [
      ['HOUZS CENTURY SDN BHD (1476832-W)'],
      ['Acc. No.', 'Description', null, 'Currency'],
      ['CURRENT ASSETS'],
      ['310-0000', 'CASH AT BANK', null, 'MYR'],
      ['    310-0010', 'CASH AT BANK - MAYBANK', null, 'MYR', null, null, null, null, 'SBK'],
      ['EXPENSES'],
      ['900-A002', 'ADVERTISEMENT', null, 'MYR'],
      ['LONG TERM LIABILITIES'],
      ['460-0001', 'LOAN - MAYBANK', null, 'MYR'],
      ['MYSTERY SECTION'],
      ['999-0001', 'UNKNOWN THING', null, 'MYR'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet');
    const p = parseChartXlsx(wb);

    expect(p.rows).toHaveLength(5);
    const mbb = p.rows.find((r) => r.code === '310-0010')!;
    expect(mbb).toMatchObject({ parentCode: '310-0000', accMoney: true, accountType: 'ASSET', shared: false });
    const parent = p.rows.find((r) => r.code === '310-0000')!;
    expect(parent).toMatchObject({ parentCode: null, accMoney: false, shared: true });
    expect(p.rows.find((r) => r.code === '900-A002')).toMatchObject({ accountType: 'EXPENSE', shared: true });
    /* 460 = borrowings: named counterparties of ONE company. */
    expect(p.rows.find((r) => r.code === '460-0001')).toMatchObject({ accountType: 'LIABILITY', shared: false });
    /* An unknown section falls back to EXPENSE and is NAMED for the operator. */
    expect(p.rows.find((r) => r.code === '999-0001')).toMatchObject({ accountType: 'EXPENSE' });
    expect(p.unknownSections).toEqual(['MYSTERY SECTION']);
  });
});

describe('the tick grid', () => {
  test('parents render bold-with-header-tag, children indent, and a tick names company + code', async () => {
    tickAsync.mockClear();
    draw();
    expect(screen.getByText('header')).toBeTruthy();
    /* Tick 310-0010 ON for 2990 — the empty cell of the second company. */
    fireEvent.click(screen.getByLabelText('310-0010 for 2990'));
    await waitFor(() => expect(tickAsync).toHaveBeenCalledWith({ companyId: 2, code: '310-0010', active: true }));
  });

  test('unticking a HEADER warns about its children before anything moves', async () => {
    tickAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('310-0000 for HOUZS'));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/1 active sub-account/);
    await waitFor(() => expect(tickAsync).toHaveBeenCalledWith({ companyId: 1, code: '310-0000', active: false }));
  });
});

describe('the upload preview', () => {
  test('counts shared vs HOUZS-only and imports on confirm', async () => {
    importAsync.mockClear();
    draw();
    const aoa = [
      ['CURRENT ASSETS'],
      ['310-0000', 'CASH AT BANK', null, 'MYR'],
      ['    310-0010', 'CASH AT BANK - MAYBANK', null, 'MYR', null, null, null, null, 'SBK'],
      ['EXPENSES'],
      ['900-A002', 'ADVERTISEMENT', null, 'MYR'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const file = new File([buf], 'chart.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => buf });

    fireEvent.change(screen.getByLabelText(/Upload AutoCount chart/), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/3 account\(s\) read/)).toBeTruthy());
    expect(screen.getByText(/2 will be SHARED/)).toBeTruthy();
    expect(screen.getByText(/1 stay HOUZS-only/)).toBeTruthy();

    fireEvent.click(screen.getByText('Import 3 accounts'));
    await waitFor(() => expect(importAsync).toHaveBeenCalled());
    const sent = importAsync.mock.calls[0]![0] as { companyId: number; rows: Array<{ code: string; shared: boolean }> };
    expect(sent.companyId).toBe(1);
    expect(sent.rows.map((r) => [r.code, r.shared])).toEqual([
      ['310-0000', true], ['310-0010', false], ['900-A002', true],
    ]);
  });
});
