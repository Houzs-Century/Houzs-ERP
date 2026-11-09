/* The layout editor (owner 2026-09-14, docs/bugs/0911: 我要能自己调动排版，然后能
   自己加大 categories … 做公用然后选要不要，类似 chart of account). Pinned:
     · the tree renders per block, a tick column per company, the block's
       unplaced accounts under Unassigned;
     · rename, add, delete (what it held moves up), ↑ ↓, tick and Place change
       the DRAFT, and Save sends exactly that tree;
     · Reset asks first, then calls the reset;
     · nothing is sent until Save;
     · the Cash Flow (owner 2026-09-18): a side per top category, a direction
       per line, a category's own subtotal name, subtotal rows, spares per side;
     · the redesign (batch 6 §5.12): an "Unsaved changes" tag after an edit,
       a side renamed in place with its subtotal line beside it, and Close
       asks before it drops unsaved changes.
   The operations themselves: vendor/scm/lib/report-layout.test.ts; the
   server: tests/reportLayouts.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Layout, LayoutCategory, LayoutItem, ReportLayoutResponse } from '../../vendor/scm/lib/report-layout';

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

const co = { 1: { active: true }, 2: { active: true } };
/* The Cash Flow: RECEIPTS (In) and PAYMENTS (Out); 300-0000 sits on both sides; 910-0000 on neither. */
const RP: ReportLayoutResponse = {
  report: 'rp',
  blocks: [{ key: 'accounts', title: 'Accounts', sections: ['CURRENT ASSETS', 'COST OF GOODS SOLD', 'EXPENSES'] }],
  stored: true, updatedAt: '2026-09-18T10:00:00Z', updatedBy: 'Finance',
  layout: {
    version: 1,
    blocks: {
      accounts: [
        { kind: 'category', id: 'side:in', label: 'RECEIPTS', flow: 'in', totalLabel: 'Total receipts', children: [
          { kind: 'category', id: 'in:sec:CURRENT ASSETS', label: 'CURRENT ASSETS', children: [{ kind: 'account', code: '300-0000', flow: 'in' }] },
        ] },
        { kind: 'category', id: 'side:out', label: 'PAYMENTS', flow: 'out', totalLabel: 'Total payments', children: [
          { kind: 'account', code: '300-0000', flow: 'out' },
          { kind: 'account', code: '601-0003', flow: 'out' },
        ] },
      ],
    },
  },
  companies: [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }],
  accounts: [
    { code: '300-0000', name: 'ACCOUNT RECEIVABLE', type: 'ASSET', parentCode: null, section: 'CURRENT ASSETS', perCompany: co },
    { code: '601-0003', name: 'PURCHASE OF SOFA', type: 'EXPENSE', parentCode: null, section: 'COST OF GOODS SOLD', perCompany: co },
    { code: '910-0000', name: 'UTILITIES', type: 'EXPENSE', parentCode: null, section: 'EXPENSES', perCompany: co },
  ],
};

const saveAsync = vi.fn(async (_l: Layout) => ({ ok: true, stored: true, layout: RESPONSE.layout, updatedAt: null, updatedBy: 'T' }));
const resetAsync = vi.fn(async () => ({ ok: true, stored: false, layout: RESPONSE.layout, updatedAt: null, updatedBy: null }));
vi.mock('../../vendor/scm/lib/report-layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/report-layout')>()),
  useReportLayout: (report: string) => ({ data: report === 'rp' ? RP : RESPONSE, isLoading: false, isError: false }),
  useSaveReportLayout: () => ({ mutateAsync: saveAsync, isPending: false }),
  useResetReportLayout: () => ({ mutateAsync: resetAsync, isPending: false }),
}));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));

import { ReportLayoutEditor } from './ReportLayoutEditor';

const shape = (items: LayoutItem[]): unknown[] =>
  items.map((it) => (it.kind === 'account' ? it.code : it.kind === 'subtotal' ? { subtotal: it.id } : { [it.id]: shape(it.children) }));
const saved = (): Layout => saveAsync.mock.calls[saveAsync.mock.calls.length - 1]![0];
const draw = (onClose: () => void = () => {}) => render(<ReportLayoutEditor report="pnl" onClose={onClose} />);
const drawRp = () => render(<ReportLayoutEditor report="rp" onClose={() => {}} />);
const placeButtons = () => screen.getAllByRole('button', { name: /^Place / }).map((b) => b.getAttribute('aria-label'));
const rowOf = (text: string | RegExp) => screen.getByText(text).closest('tr')!;

describe('the layout editor', () => {
  test('renders the blocks, the tree, a tick per company, and the unplaced under Unassigned', () => {
    draw();
    expect(screen.getByRole('dialog', { name: 'Layout · P&L' })).toBeTruthy();
    expect(screen.getByText(/Saved by Finance/)).toBeTruthy();
    expect(screen.getByText('Expenses')).toBeTruthy();
    expect(screen.getByText('Operating Expense')).toBeTruthy();
    /* Account No. and Name are their own cells, the drag handle beside the number (owner 2026-09-18). */
    const fee = within(rowOf('900-A001')).getAllByRole('cell');
    expect(fee[0]!.textContent).toBe('900-A001');
    expect(fee[0]!.querySelector('svg')).not.toBeNull();
    expect(fee[1]!.textContent).toBe('ACCOUNTING FEE');
    const opex = within(rowOf('Operating Expense')).getAllByRole('cell');
    expect(opex[0]!.textContent).toBe('900-0000');
    expect(opex[1]!.textContent).toBe('Operating Expense');
    /* ADVERTISEMENT is unticked for HOUZS, ticked for 2990. */
    expect((screen.getByLabelText('ADVERTISEMENT for HOUZS') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('ADVERTISEMENT for 2990') as HTMLInputElement).checked).toBe(true);
    /* 900-H010 is on the chart (HOUZS) but nowhere in the tree. */
    expect(screen.getByText(/Unassigned — printed at the foot of Expenses/)).toBeTruthy();
    expect(rowOf('900-H010').textContent).toContain('HOMESTAY EXPENSES');
    expect(screen.getByRole('button', { name: 'Place 900-H010' })).toBeTruthy();
    /* Save waits for an edit. */
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  test('rename, then Save sends the renamed tree — and only then', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Rename ADVERTISEMENT' }));
    const input = screen.getByLabelText('Rename ADVERTISEMENT') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Marketing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Marketing')).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
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

  /* Owner 2026-11-05: a long tree cannot be dragged past the screen, so a row is picked
     up, the page scrolled, and the row put down; Esc lets go. Any category names its own Total line. */
  test('Pick up parks a row; Place inside puts it in a category; Esc cancels', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Pick up 900-A001' }));
    expect(screen.getByRole('status').textContent).toContain('Moving 900-A001');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Place inside ADVERTISEMENT' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick up 900-A001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Place inside ADVERTISEMENT' }));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    expect(shape(saved().blocks.expenses!)).toEqual([{ 'acc:900-0000': [{ 'acc:900-A002': ['900-A014', '900-A001'] }] }]);
  });

  test('a category below the top names its own Total line, and Save sends it', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Rename ADVERTISEMENT' }));
    const total = screen.getByLabelText('Subtotal name of ADVERTISEMENT') as HTMLInputElement;
    fireEvent.change(total, { target: { value: 'Total marketing' } });
    fireEvent.keyDown(total, { key: 'Enter' });
    expect(screen.getByText('Subtotal line: Total marketing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const cat = (saved().blocks.expenses![0] as { children: Array<{ totalLabel?: string }> }).children[1]!;
    expect(cat.totalLabel).toBe('Total marketing');
  });

  test('a new category joins the block; deleting one moves what it held up a level; an unplaced account goes back to Unassigned', async () => {
    saveAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Add a category to Expenses' }));
    expect(screen.getByText('New category')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete ADVERTISEMENT' }));
    /* The category row is gone (its header account 900-A002 now sits among the spares under its own name). */
    expect(screen.queryByLabelText('ADVERTISEMENT for HOUZS')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename ADVERTISEMENT' })).toBeNull();
    expect(rowOf('900-A014').textContent).toContain('ADVERTISEMENT - SHOWROOM');
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
    expect(screen.getByText('ACCOUNTING FEE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fold all' }));
    expect(screen.queryByText('ACCOUNTING FEE')).toBeNull();
    expect(screen.queryByText('ADVERTISEMENT')).toBeNull();
    expect(screen.getByText('Operating Expense')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unfold all' }));
    expect(screen.getByText('ACCOUNTING FEE')).toBeTruthy();
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

  test('Close with nothing changed closes; with changes it asks — Keep editing stays, Close without saving drops them', () => {
    saveAsync.mockClear();
    const closed = vi.fn();
    const { unmount } = draw(closed);
    fireEvent.click(screen.getByRole('button', { name: 'Close the layout editor' }));
    expect(closed).toHaveBeenCalledTimes(1);
    unmount();

    closed.mockClear();
    draw(closed);
    fireEvent.click(screen.getByRole('button', { name: 'Move 900-A001 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close the layout editor' }));
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByText(/changes that are not saved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText(/changes that are not saved/)).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close the layout editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(saveAsync).not.toHaveBeenCalled();
  });

  test('a saved layout closes without asking', async () => {
    saveAsync.mockClear();
    const closed = vi.fn();
    draw(closed);
    fireEvent.click(screen.getByRole('button', { name: 'Move 900-A001 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Close the layout editor' }));
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('the Cash Flow layout (owner 2026-09-18)', () => {
  test('a side per top category, a direction per line, the subtotal name, and the spares per side', () => {
    drawRp();
    expect(screen.getByRole('dialog', { name: 'Layout · Cash flow' })).toBeTruthy();
    expect(screen.getByText('Direction', { selector: 'th' })).toBeTruthy();
    expect((screen.getByLabelText('Side of RECEIPTS') as HTMLSelectElement).value).toBe('in');
    expect((screen.getByLabelText('Side of PAYMENTS') as HTMLSelectElement).value).toBe('out');
    /* A category deeper down follows its parent: no side of its own. */
    expect(screen.queryByLabelText('Side of CURRENT ASSETS')).toBeNull();
    expect(screen.getAllByLabelText('Direction of 300-0000').map((e) => (e as HTMLSelectElement).value)).toEqual(['in', 'out']);
    /* A side shows its subtotal line, and names it in place beside its name (Rename). */
    expect(screen.getByText('Subtotal line: Total receipts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename RECEIPTS' }));
    expect((screen.getByLabelText('Subtotal name of RECEIPTS') as HTMLInputElement).value).toBe('Total receipts');
    expect(screen.getByLabelText('Subtotal name of RECEIPTS').getAttribute('title')).toBe('Its subtotal line');
    fireEvent.keyDown(screen.getByLabelText('Rename RECEIPTS'), { key: 'Escape' });
    /* A category deeper down may name its own Total line too (owner 2026-11-05); unnamed, it shows none. */
    expect(screen.queryByText(/Subtotal line: Total CURRENT ASSETS/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rename CURRENT ASSETS' }));
    expect((screen.getByLabelText('Subtotal name of CURRENT ASSETS') as HTMLInputElement).placeholder).toBe('Total CURRENT ASSETS');
    fireEvent.keyDown(screen.getByLabelText('Rename CURRENT ASSETS'), { key: 'Escape' });
    /* 601-0003 reads Out only, 910-0000 nowhere: the In side lacks both, the Out side lacks 910-0000. */
    expect(screen.getByText(/Unassigned receipts/)).toBeTruthy();
    expect(screen.getByText(/Unassigned payments/)).toBeTruthy();
    expect(placeButtons()).toEqual(['Place 601-0003 as In', 'Place 910-0000 as In', 'Place 910-0000 as Out']);
  });

  test('flip a side, turn a line Net, name the subtotal line, add and rename a running subtotal — Save sends the typed tree', async () => {
    saveAsync.mockClear();
    drawRp();
    fireEvent.change(screen.getByLabelText('Side of PAYMENTS'), { target: { value: 'in' } });
    fireEvent.change(screen.getAllByLabelText('Direction of 300-0000')[1]!, { target: { value: 'net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename PAYMENTS' }));
    fireEvent.change(screen.getByLabelText('Subtotal name of PAYMENTS'), { target: { value: 'Net Loan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Subtotal line: Net Loan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a subtotal to Accounts' }));
    expect(screen.getByText('New subtotal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename New subtotal' }));
    const input = screen.getByLabelText('Rename New subtotal') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Net operation surplus / (deficit)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(saveAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const items = saved().blocks.accounts!;
    expect(items[0]).toMatchObject({ kind: 'category', id: 'side:in', flow: 'in', totalLabel: 'Total receipts' });
    expect(items[1]).toMatchObject({ kind: 'category', id: 'side:out', flow: 'in', totalLabel: 'Net Loan' });
    expect((items[1] as { children: LayoutItem[] }).children[0]).toEqual({ kind: 'account', code: '300-0000', flow: 'net' });
    expect(items[2]).toMatchObject({ kind: 'subtotal', label: 'Net operation surplus / (deficit)' });
    expect((items[2] as { id: string }).id).toMatch(/^sub:/);
  });

  test('Place as In lands inside the In side; Unplace frees one direction only; Delete takes a subtotal away', async () => {
    saveAsync.mockClear();
    drawRp();
    fireEvent.click(screen.getByRole('button', { name: 'Place 910-0000 as In' }));
    expect(placeButtons()).toEqual(['Place 601-0003 as In', 'Place 910-0000 as Out']);
    /* The second 300-0000 line is the Out one; unplacing it frees its money out, its money in stays placed. */
    fireEvent.click(screen.getAllByRole('button', { name: 'Unplace 300-0000' })[1]!);
    expect(placeButtons()).toEqual(['Place 601-0003 as In', 'Place 300-0000 as Out', 'Place 910-0000 as Out']);
    fireEvent.click(screen.getByRole('button', { name: 'Add a subtotal to Accounts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete New subtotal' }));
    expect(screen.queryByText('New subtotal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    expect(shape(saved().blocks.accounts!)).toEqual([
      { 'side:in': [{ 'in:sec:CURRENT ASSETS': ['300-0000'] }, '910-0000'] },
      { 'side:out': ['601-0003'] },
    ]);
    expect(((saved().blocks.accounts![0] as { children: LayoutItem[] }).children[1])).toEqual({ kind: 'account', code: '910-0000', flow: 'in' });
  });

  test('a group\'s Settlement / Deposit column: one side, parts like 1 : 2, or as the group above; Save sends it (owner 2026-11-09)', async () => {
    saveAsync.mockClear();
    drawRp();
    expect(screen.getByText('Settlement / Deposit', { selector: 'th' })).toBeTruthy();
    /* A top group with nothing set is not split; one below follows the group above; a line has no choice of its own. */
    const top = screen.getByLabelText('Settlement / Deposit of RECEIPTS') as HTMLSelectElement;
    expect([top.value, top.selectedOptions[0]!.textContent]).toEqual(['', 'Not split']);
    expect((screen.getByLabelText('Settlement / Deposit of CURRENT ASSETS') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('As above');
    expect(screen.queryByLabelText('Settlement / Deposit of 300-0000')).toBeNull();
    fireEvent.change(top, { target: { value: 'deposit' } });
    fireEvent.change(screen.getByLabelText('Settlement / Deposit of PAYMENTS'), { target: { value: 'parts' } });
    /* Parts start at a third Settlement, two thirds Deposit, and are typed as whole numbers. */
    expect((screen.getByLabelText('Settlement parts of PAYMENTS') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Deposit parts of PAYMENTS') as HTMLInputElement).value).toBe('2');
    fireEvent.change(screen.getByLabelText('Deposit parts of PAYMENTS'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Settlement / Deposit of CURRENT ASSETS'), { target: { value: 'settlement' } });
    fireEvent.change(screen.getByLabelText('Settlement / Deposit of CURRENT ASSETS'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const [rin, rout] = saved().blocks.accounts! as [LayoutCategory, LayoutCategory];
    expect(rin.split).toEqual({ settlement: 0, deposit: 1 });
    expect(rout.split).toEqual({ settlement: 1, deposit: 3 });
    expect(rin.children[0]).not.toHaveProperty('split');
  });
});
