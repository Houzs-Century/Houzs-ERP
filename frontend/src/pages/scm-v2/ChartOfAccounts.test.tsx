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
const renameAsync = vi.fn(async (_b: unknown) => ({ ok: true, moved: { accounts: 2, journal_lines: 3 } }));
const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, code: '305-0010', companies: [1, 2] }));
const updateAsync = vi.fn(async (_b: unknown) => ({ ok: true, companies: 2 }));
const deleteAsync = vi.fn(async (_c: unknown) => ({ ok: true, companies: 2 }));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useChartUnion: () => ({ data: { companies: [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }], accounts: [
    { code: '310-0000', name: 'CASH AT BANK', type: 'ASSET', parentCode: null, accMoney: false, special: null, perCompany: { 1: { active: true } } },
    { code: '310-0010', name: 'CASH AT BANK - MAYBANK', type: 'ASSET', parentCode: '310-0000', accMoney: true, special: 'SBK', perCompany: { 1: { active: true } } },
    { code: '400-0000', name: 'ACCOUNT PAYABLE', type: 'LIABILITY', parentCode: null, accMoney: false, special: 'SCC', perCompany: { 1: { active: true } } },
    { code: '900-A002', name: 'ADVERTISEMENT', type: 'EXPENSE', parentCode: null, accMoney: false, special: null, perCompany: { 1: { active: true }, 2: { active: true } } },
  ] }, isLoading: false, error: null }),
  useChartTick: () => ({ mutateAsync: tickAsync, isPending: false }),
  useChartImport: () => ({ mutateAsync: importAsync, isPending: false }),
  useChartRename: () => ({ mutateAsync: renameAsync, isPending: false }),
  useChartUpdate: () => ({ mutateAsync: updateAsync, isPending: false }),
  useChartDelete: () => ({ mutateAsync: deleteAsync, isPending: false }),
  useChartCreate: () => ({ mutateAsync: createAsync, isPending: false }),
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
    expect(mbb).toMatchObject({ parentCode: '310-0000', accMoney: true, accountType: 'ASSET', shared: false, specialType: 'SBK' });
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

describe('fold / edit / delete — the owner points 1, 2 and 4', () => {
  test('collapsing a header hides its subtree; expanding brings it back', () => {
    draw();
    expect(screen.getByText('310-0010')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Collapse 310-0000'));
    expect(screen.queryByText('310-0010')).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand 310-0000'));
    expect(screen.getByText('310-0010')).toBeTruthy();
  });

  test('a control account wears its badge', () => {
    draw();
    expect(screen.getByText(/SCC · control/)).toBeTruthy();
  });

  test('changing the code confirms 改码全账跟 and calls the rename with both codes', async () => {
    renameAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Edit 310-0010'));
    const codeInput = screen.getByDisplayValue('310-0010');
    fireEvent.change(codeInput, { target: { value: '311-0010' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/改码全账跟/);
    await waitFor(() => expect(renameAsync).toHaveBeenCalledWith({ oldCode: '310-0010', newCode: '311-0010' }));
  });

  test('a name-only change skips the rename and rides the update', async () => {
    renameAsync.mockClear(); updateAsync.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Edit 900-A002'));
    fireEvent.change(screen.getByDisplayValue('ADVERTISEMENT'), { target: { value: 'ADVERTISING' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-A002', name: 'ADVERTISING' }));
    expect(renameAsync).not.toHaveBeenCalled();
  });

  test('SFA derives its SAD twin by the +5 convention and the payload carries both', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Add account'));
    fireEvent.change(screen.getByPlaceholderText('305-0010'), { target: { value: '201-3000' } });
    const name = screen.getAllByDisplayValue('').find((el) => String(el.closest('label')?.textContent).includes('Name'))!;
    fireEvent.change(name, { target: { value: 'F&F (HOSTEL)' } });
    fireEvent.change(screen.getByLabelText('Special type'), { target: { value: 'SFA' } });
    expect(screen.getByLabelText('Depreciation code')).toHaveProperty('value', '201-3005');
    expect(screen.getByLabelText('Depreciation name')).toHaveProperty('value', 'ACCUM. DEPRN. - F&F (HOSTEL)');
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledWith(expect.objectContaining({
      code: '201-3000',
      specialType: 'SFA',
      depreciation: { code: '201-3005', name: 'ACCUM. DEPRN. - F&F (HOSTEL)' },
    })));
  });

  test('picking SBK auto-ticks money — the import equivalence, live on the form', () => {
    draw();
    fireEvent.click(screen.getByText('Add account'));
    fireEvent.change(screen.getByLabelText('Special type'), { target: { value: 'SBK' } });
    const box = screen.getByText(/money \(bank\/cash\/wallet\)/).closest('label')!.querySelector('input')!;
    expect(box.checked).toBe(true);
  });

  test('Add account creates once with the ticked companies and the parent', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Add account'));
    fireEvent.change(screen.getByPlaceholderText('305-0010'), { target: { value: '305-0010' } });
    const name = screen.getAllByDisplayValue('').find((el) => String(el.closest('label')?.textContent).includes('Name'))!;
    fireEvent.change(name, { target: { value: 'AHMAD BIN ALI' } });
    fireEvent.change(screen.getByPlaceholderText('305-0000'), { target: { value: '305-0000' } });
    fireEvent.click(screen.getByLabelText('new account for 2990')); // untick 2990 → HOUZS only
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledWith({
      code: '305-0010', name: 'AHMAD BIN ALI', accountType: 'ASSET',
      parentCode: '305-0000', accMoney: false, companyIds: [1],
    }));
  });

  test('dropping a row onto another confirms, then re-parents through the update', async () => {
    updateAsync.mockClear(); confirmFn.mockClear();
    draw();
    const src = screen.getByText('900-A002').closest('tr')!;
    const target = screen.getByText('310-0000').closest('tr')!;
    fireEvent.dragStart(src);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-A002', parentCode: '310-0000' }));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/挂到 310-0000 下/);
  });

  test('the edit panel moves an account under a parent (and 留空 = root)', async () => {
    updateAsync.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Edit 310-0010'));
    fireEvent.change(screen.getByLabelText('Edit parent'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '310-0010', parentCode: null }));
  });

  test('delete confirms, then sends the code', async () => {
    deleteAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Delete 900-A002'));
    await waitFor(() => expect(deleteAsync).toHaveBeenCalledWith('900-A002'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/NO transactions/);
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
