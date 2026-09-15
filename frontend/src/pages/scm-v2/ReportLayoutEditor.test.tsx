/* The layout editor (owner 2026-09-14, docs/bugs/0911: 我要能自己调动排版，然后能
   自己加大 categories … 做公用然后选要不要，类似 chart of account). Pinned:
     · the tree renders per block, a tick column per company, the block's
       unplaced accounts under Unassigned;
     · rename, add, delete (what it held moves up), ↑ ↓, tick and Place change
       the DRAFT, and Save sends exactly that tree;
     · Reset asks first, then calls the reset;
     · nothing is sent until Save. The operations themselves:
       vendor/scm/lib/report-layout.test.ts; the server: tests/reportLayouts.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Layout, LayoutItem, ReportLayoutResponse } from '../../vendor/scm/lib/report-layout';

const RESPONSE: ReportLayoutResponse = {
  report: 'pnl',
  blocks: [
    { key: 'tradingIncome', title: 'Trading income', sections: ['SALES', 'SALES ADJUSTMENTS'] },
    { key: 'expenses', title: 'Expenses', sections: ['EXPENSES'] },
  ],
  stored: true,
  updatedAt: '2026-09-14T10:00:00Z',
  updatedBy: 'Finance',
  layout: {
    version: 1,
    blocks: {
      tradingIncome: [{ kind: 'category', id: 'sec:SALES', label: 'SALES', children: [{ kind: 'account', code: '501-0000' }] }],
      expenses: [
        {
          kind: 'category', id: 'acc:900-0000', label: 'Operating Expense', code: '900-0000',
          children: [
            { kind: 'account', code: '900-A001' },
            { kind: 'category', id: 'acc:900-A002', label: 'ADVERTISEMENT', code: '900-A002', hiddenFor: [1], children: [{ kind: 'account', code: '900-A014' }] },
          ],
        },
      ],
    },
  },
  companies: [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }],
  accounts: [
    { code: '501-0000', name: 'SALES', type: 'INCOME', parentCode: null, section: 'SALES', perCompany: { 1: { active: true }, 2: { active: true } } },
    { code: '900-0000', name: 'Operating Expense', type: 'EXPENSE', parentCode: null, section: 'EXPENSES', perCompany: { 1: { active: true }, 2: { active: true } } },
    { code: '900-A001', name: 'ACCOUNTING FEE', type: 'EXPENSE', parentCode: '900-0000', section: 'EXPENSES', perCompany: { 1: { active: true }, 2: { active: true } } },
    { code: '900-A002', name: 'ADVERTISEMENT', type: 'EXPENSE', parentCode: '900-0000', section: 'EXPENSES', perCompany: { 1: { active: true }, 2: { active: true } } },
    { code: '900-A014', name: 'ADVERTISEMENT - SHOWROOM', type: 'EXPENSE', parentCode: '900-A002', section: 'EXPENSES', perCompany: { 1: { active: true } } },
    { code: '900-H010', name: 'HOMESTAY EXPENSES', type: 'EXPENSE', parentCode: '900-0000', section: 'EXPENSES', perCompany: { 1: { active: true } } },
  ],
};

const saveAsync = vi.fn(async (_l: Layout) => ({ ok: true, stored: true, layout: RESPONSE.layout, updatedAt: null, updatedBy: 'T' }));
const resetAsync = vi.fn(async () => ({ ok: true, stored: false, layout: RESPONSE.layout, updatedAt: null, updatedBy: null }));
vi.mock('../../vendor/scm/lib/report-layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/report-layout')>()),
  useReportLayout: () => ({ data: RESPONSE, isLoading: false, isError: false }),
  useSaveReportLayout: () => ({ mutateAsync: saveAsync, isPending: false }),
  useResetReportLayout: () => ({ mutateAsync: resetAsync, isPending: false }),
}));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));

import { ReportLayoutEditor } from './ReportLayoutEditor';

const shape = (items: LayoutItem[]): unknown[] =>
  items.map((it) => (it.kind === 'account' ? it.code : { [it.id]: shape(it.children) }));
const saved = (): Layout => saveAsync.mock.calls[saveAsync.mock.calls.length - 1]![0];
const draw = () => render(<ReportLayoutEditor report="pnl" onClose={() => {}} />);
const rowOf = (text: string | RegExp) => screen.getByText(text).closest('tr')!;

describe('the layout editor', () => {
  test('renders the blocks, the tree, a tick per company, and the unplaced under Unassigned', () => {
    draw();
    expect(screen.getByRole('dialog', { name: 'Layout · P&L' })).toBeTruthy();
    expect(screen.getByText(/Saved by Finance/)).toBeTruthy();
    expect(screen.getByText('Expenses')).toBeTruthy();
    expect(screen.getByText('Operating Expense')).toBeTruthy();
    expect(screen.getByText('900-A001 — ACCOUNTING FEE')).toBeTruthy();
    /* ADVERTISEMENT is unticked for HOUZS, ticked for 2990. */
    expect((screen.getByLabelText('ADVERTISEMENT for HOUZS') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('ADVERTISEMENT for 2990') as HTMLInputElement).checked).toBe(true);
    /* 900-H010 is on the chart (HOUZS) but nowhere in the tree. */
    expect(screen.getByText(/Unassigned — printed at the foot of Expenses/)).toBeTruthy();
    expect(screen.getByText('900-H010 — HOMESTAY EXPENSES')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Place 900-H010' })).toBeTruthy();
    /* Save waits for an edit. */
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('rename, then Save sends the renamed tree — and only then', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Rename ADVERTISEMENT' }));
    const input = screen.getByLabelText('Rename ADVERTISEMENT') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Marketing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Marketing')).toBeTruthy();
    expect(saveAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const cat = (saved().blocks.expenses![0] as { children: Array<{ label?: string }> }).children[1]!;
    expect(cat.label).toBe('Marketing');
  });

  test('↓ moves an account below its sibling; the tick unticks for one company; Place adds the spare at the end', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Move 900-A001 down' }));
    fireEvent.click(screen.getByLabelText('Operating Expense for 2990'));
    fireEvent.click(screen.getByRole('button', { name: 'Place 900-H010' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    expect(shape(saved().blocks.expenses!)).toEqual([
      { 'acc:900-0000': [{ 'acc:900-A002': ['900-A014'] }, '900-A001'] },
      '900-H010',
    ]);
    expect((saved().blocks.expenses![0] as { hiddenFor?: number[] }).hiddenFor).toEqual([2]);
    /* The tick under ADVERTISEMENT (HOUZS) rode along untouched. */
    expect(((saved().blocks.expenses![0] as { children: Array<{ hiddenFor?: number[] }> }).children[0]!).hiddenFor).toEqual([1]);
  });

  test('a new category joins the block; deleting one moves what it held up a level; an unplaced account goes back to Unassigned', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Add a category to Expenses' }));
    expect(screen.getByText('New category')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete ADVERTISEMENT' }));
    expect(screen.queryByText('ADVERTISEMENT')).toBeNull();
    expect(screen.getByText('900-A014 — ADVERTISEMENT - SHOWROOM')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unplace 900-A001' }));
    /* Back among the spares — and 900-A002, the deleted header, is a spare too. */
    const spares = screen.getAllByRole('button', { name: /^Place / }).map((b) => b.getAttribute('aria-label'));
    expect(spares).toEqual(['Place 900-A001', 'Place 900-A002', 'Place 900-H010']);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const items = saved().blocks.expenses!;
    expect(items).toHaveLength(2);
    expect(shape((items[0] as { children: LayoutItem[] }).children)).toEqual(['900-A014']);
    expect(items[1]).toMatchObject({ kind: 'category', label: 'New category' });
  });

  test('Fold all hides every category\'s rows, Unfold all shows them again (docs/bugs/0912)', () => {
    draw();
    expect(screen.getByText('900-A001 — ACCOUNTING FEE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fold all' }));
    expect(screen.queryByText('900-A001 — ACCOUNTING FEE')).toBeNull();
    expect(screen.queryByText('ADVERTISEMENT')).toBeNull();
    expect(screen.getByText('Operating Expense')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unfold all' }));
    expect(screen.getByText('900-A001 — ACCOUNTING FEE')).toBeTruthy();
    expect(screen.getByText('ADVERTISEMENT')).toBeTruthy();
  });

  test('Reset asks first, then calls the reset; a refusal calls nothing', async () => {
    resetAsync.mockClear();
    confirmFn.mockResolvedValueOnce(false);
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to chart' }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(resetAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to chart' }));
    await waitFor(() => expect(resetAsync).toHaveBeenCalledTimes(1));
  });

  test('a refused save is shown, not swallowed', async () => {
    saveAsync.mockRejectedValueOnce(new Error('900-A001 is placed twice.'));
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Move 900-A001 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('900-A001 is placed twice.'));
    const rows = within(rowOf('Operating Expense').parentElement!).getAllByRole('row');
    expect(rows.length).toBeGreaterThan(2);
  });
});
