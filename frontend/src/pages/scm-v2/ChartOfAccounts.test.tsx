/* The Chart maintenance page (owner 2026-09-02: 类似recon setup 我tick 后选择
   这个公司要不要用), in the redesign (Finance-1a-Setup, batch 6 §6.1). What is
   pinned:
     · parseChartXlsx reads the AutoCount report shape — digit AND letter
       codes, 4-space indent → parent, section → type, SBK/SCH → money,
       banks/related-party/directors/HP pre-classified HOUZS-only;
     · the tree renders parents with the header tag, children stepped in behind
       the six-dot mark, one tick column per company;
     · ticking calls the tick mutation with the right company+code; unticking
       a header warns about its children first;
     · the forms are modals (New account, Edit) and the asks are the app's
       confirm, in the design's words;
     · the upload preview counts new vs known and imports on confirm.
   The server half is backend/tests/accountingChart.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import * as XLSX from 'xlsx';

/* The server's section vocabulary (one home: backend lib/account-sections.ts),
   as the union hands it down — the page never carries a copy. */
const SECTIONS = [
  { section: 'CAPITAL', type: 'EQUITY' },
  { section: 'CURRENT ASSETS', type: 'ASSET' },
  { section: 'CURRENT LIABILITIES', type: 'LIABILITY' },
  { section: 'LONG TERM LIABILITIES', type: 'LIABILITY' },
  { section: 'SALES', type: 'INCOME' },
  { section: 'OTHER INCOMES', type: 'INCOME' },
  { section: 'EXPENSES', type: 'EXPENSE' },
] as const;
const tickAsync = vi.fn(async (_b: unknown) => ({}));
const importAsync = vi.fn(async (_b: unknown) => ({ ok: true, imported: 3, shared: 2, sharedTo: [2] }));
const renameAsync = vi.fn(async (_b: unknown) => ({ ok: true, moved: { accounts: 2, journal_lines: 3 } }));
const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, code: '305-0010', companies: [1, 2] }));
const updateAsync = vi.fn(async (_b: unknown) => ({ ok: true, companies: 2 }));
const deleteAsync = vi.fn(async (_c: unknown) => ({ ok: true, companies: 2 }));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useChartUnion: () => ({ data: { companies: [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }], sections: SECTIONS, accounts: [
    { code: '310-0000', name: 'CASH AT BANK', type: 'ASSET', parentCode: null, accMoney: false, special: null, section: 'CURRENT ASSETS', perCompany: { 1: { active: true } } },
    { code: '310-0010', name: 'CASH AT BANK - MAYBANK', type: 'ASSET', parentCode: '310-0000', accMoney: true, special: 'SBK', section: 'CURRENT ASSETS', perCompany: { 1: { active: true } } },
    { code: '400-0000', name: 'ACCOUNT PAYABLE', type: 'LIABILITY', parentCode: null, accMoney: false, special: 'SCC', section: 'CURRENT LIABILITIES', perCompany: { 1: { active: true } } },
    { code: '900-A002', name: 'ADVERTISEMENT', type: 'EXPENSE', parentCode: null, accMoney: false, special: null, section: 'EXPENSES', perCompany: { 1: { active: true }, 2: { active: true } } },
    { code: '500-0000', name: 'SALES', type: 'INCOME', parentCode: null, accMoney: false, special: null, section: 'SALES', perCompany: { 1: { active: true } } },
    { code: '700-0000', name: 'Other Income', type: 'INCOME', parentCode: null, accMoney: false, special: null, section: 'OTHER INCOMES', perCompany: { 1: { active: true } } },
    { code: '590-0000', name: 'TRANSPORT INCOME', type: 'INCOME', parentCode: '700-0000', accMoney: false, special: null, section: 'OTHER INCOMES', perCompany: { 1: { active: true } } },
    { code: '900-R032', name: 'RENTAL - EXHIBITION', type: 'EXPENSE', parentCode: null, accMoney: false, special: null, section: 'EXPENSES', needsEvent: true, pmsRow: 'rental', logisticsRow: 'outsource_pg', perCompany: { 1: { active: true } } },
  ], pmsRows: [{ row: 'rental', label: 'Rental' }, { row: 'setup', label: 'Setup' }, { row: 'others', label: 'Others Costing' }],
  logisticsRows: [
    { row: 'outsource_pg', label: 'Outsource – Penang', type: 'EXPENSE' }, { row: 'petrol', label: 'Petrol', type: 'EXPENSE' },
    { row: 'instalment', label: 'Lorry Installment', type: 'LIABILITY' }, { row: 'income_kl', label: 'Transport Income – KL', type: 'INCOME' },
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
const notifyFn = vi.fn();
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifyFn }));

import { ChartOfAccounts, parseChartXlsx } from './ChartOfAccounts';

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/chart-of-accounts']}>
    <Routes>
      <Route path="/scm/chart-of-accounts" element={<ChartOfAccounts />} />
      <Route path="/scm/accounting" element={<div>the active company&apos;s list</div>} />
    </Routes>
  </MemoryRouter>,
);
const rowOf = (container: HTMLElement, code: string) => container.querySelector(`tr[data-code="${code}"]`) as HTMLElement;

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
    const p = parseChartXlsx(wb, SECTIONS);

    expect(p.rows).toHaveLength(5);
    const mbb = p.rows.find((r) => r.code === '310-0010')!;
    /* The heading travels with the row now — the server stores it. */
    expect(mbb).toMatchObject({ parentCode: '310-0000', accMoney: true, accountType: 'ASSET', section: 'CURRENT ASSETS', shared: false, specialType: 'SBK' });
    const parent = p.rows.find((r) => r.code === '310-0000')!;
    expect(parent).toMatchObject({ parentCode: null, accMoney: false, shared: true });
    expect(p.rows.find((r) => r.code === '900-A002')).toMatchObject({ accountType: 'EXPENSE', shared: true });
    /* 460 = borrowings: named counterparties of ONE company. */
    expect(p.rows.find((r) => r.code === '460-0001')).toMatchObject({ accountType: 'LIABILITY', shared: false });
    /* An unknown section falls back to EXPENSE, carries NO section (the server
       shelves it by type) and is NAMED for the operator. */
    expect(p.rows.find((r) => r.code === '999-0001')).toMatchObject({ accountType: 'EXPENSE', section: null });
    expect(p.unknownSections).toEqual(['MYSTERY SECTION']);
  });
});

describe('the header and the bar', () => {
  test('Finance · Setup, the design subtitle, and a count of what each company uses', () => {
    draw();
    expect(screen.getByText('Finance · Setup')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Chart of accounts' })).toBeTruthy();
    expect(screen.getByText('Every account any company carries · tick per company')).toBeTruthy();
    expect(screen.getByText('8 accounts · HOUZS uses 8 · 2990 uses 1')).toBeTruthy();
  });

  test('the search keeps the matching accounts under their sections; a miss says so', () => {
    const { container } = draw();
    fireEvent.change(screen.getByLabelText('Find an account'), { target: { value: 'maybank' } });
    expect(rowOf(container, '310-0010')).toBeTruthy();
    expect(rowOf(container, '310-0000')).toBeNull();
    expect(screen.getByLabelText('Collapse section CURRENT ASSETS')).toBeTruthy();
    expect(screen.queryByLabelText('Collapse section EXPENSES')).toBeNull();
    fireEvent.change(screen.getByLabelText('Find an account'), { target: { value: 'zzz' } });
    expect(screen.getByText('No account matches.')).toBeTruthy();
  });

  test('the header ⋯ opens the active company’s own list (the legacy view)', () => {
    draw();
    fireEvent.click(screen.getByLabelText('More for the chart'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'This company’s accounts' }));
    expect(screen.getByText('the active company\'s list')).toBeTruthy();
  });
});

describe('the tick grid', () => {
  test('parents render with the header tag, and a tick names company + code', async () => {
    tickAsync.mockClear();
    draw();
    expect(screen.getAllByText('header').length).toBeGreaterThan(0);
    /* Tick 310-0010 ON for 2990 — the empty cell of the second company. */
    fireEvent.click(screen.getByLabelText('310-0010 for 2990'));
    await waitFor(() => expect(tickAsync).toHaveBeenCalledWith({ companyId: 2, code: '310-0010', active: true }));
  });

  test('unticking a HEADER warns about its children before anything moves', async () => {
    tickAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('310-0000 for HOUZS'));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const asked = confirmFn.mock.calls[0]![0] as { title: string; body: string; danger?: boolean };
    expect(asked.title).toBe('Untick 310-0000 CASH AT BANK for HOUZS?');
    expect(asked.body).toMatch(/Its 1 child is unticked too, and ticking the header again does not bring it back/);
    expect(asked.danger).toBe(true);
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

  test('the tree reads as a tree (owner 2026-09-04: 父子account 不清楚) — code AND name step 18px a level, a child wears the six-dot mark', () => {
    const { container } = draw();
    const cells = (code: string) => [...rowOf(container, code).children] as HTMLElement[];
    expect(cells('310-0000')[1]!.style.paddingLeft).toBe('10px');
    expect(cells('310-0000')[2]!.style.paddingLeft).toBe('10px');
    expect(cells('310-0010')[1]!.style.paddingLeft).toBe('28px'); // 10 + depth 1 × 18
    expect(cells('310-0010')[2]!.style.paddingLeft).toBe('28px');
    expect(cells('310-0010')[1]!.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(cells('310-0000')[1]!.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  test('income splits by the TREE (owner: 就做一个 header 分类) — under 700-0000 wears · other, trading income stays unlabelled', () => {
    const { container } = draw();
    const typeCellOf = (code: string) => rowOf(container, code).children[3] as HTMLElement;
    expect(typeCellOf('590-0000').textContent).toBe('Income · other');
    expect(typeCellOf('700-0000').textContent).toBe('Income · other');
    expect(typeCellOf('500-0000').textContent).toBe('Income');
  });

  test('the AutoCount sections head the list in the server\'s order, each foldable (owner 2026-09-06: 每个 account type 的 header)', () => {
    const { container } = draw();
    const headers = [...container.querySelectorAll('tbody td[data-section]')]
      .map((td) => td.getAttribute('data-section'));
    expect(headers).toEqual(['CURRENT ASSETS', 'CURRENT LIABILITIES', 'SALES', 'OTHER INCOMES', 'EXPENSES']);
    /* Each in sentence case with its type and count. */
    expect(screen.getByText('ASSET · 2 accounts')).toBeTruthy();
    /* Fold a section: its rows vanish, the header stays. */
    fireEvent.click(screen.getByLabelText('Collapse section CURRENT ASSETS'));
    expect(screen.queryByText('310-0010')).toBeNull();
    expect(screen.getByText('Current assets')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Expand section CURRENT ASSETS'));
    expect(screen.getByText('310-0010')).toBeTruthy();
  });

  test('dragging a header-level account onto a section row re-shelves it (换节); a child is refused, its header named', async () => {
    updateAsync.mockClear(); confirmFn.mockClear(); notifyFn.mockClear();
    const { container } = draw();
    const sectionRow = (section: string) => screen.getByLabelText(`Collapse section ${section}`).closest('tr') as HTMLElement;
    /* 500-0000 SALES → OTHER INCOMES: confirm, then the update names the section. */
    fireEvent.dragStart(rowOf(container, '500-0000'));
    fireEvent.drop(sectionRow('OTHER INCOMES'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '500-0000', section: 'OTHER INCOMES' }));
    expect((confirmFn.mock.calls[0]![0] as { title: string }).title).toBe('Move 500-0000 SALES to Other incomes?');
    /* A child (310-0010 under 310-0000) does not move on its own. */
    updateAsync.mockClear();
    fireEvent.dragStart(rowOf(container, '310-0010'));
    fireEvent.drop(sectionRow('CURRENT LIABILITIES'));
    await new Promise((r) => setTimeout(r, 0));
    expect(updateAsync).not.toHaveBeenCalled();
    expect(JSON.stringify(notifyFn.mock.calls.at(-1)![0])).toMatch(/drag 310-0000 instead/);
  });

  test('the LIST scrolls inside its card and the header row sticks (owner 2026-09-04: 往下滑时看不到 header / 按 edit 时要跑回上去)', () => {
    const { container } = draw();
    /* The table's scroll container is the card body, not the page — that is
       what gives sticky a scroll context .card{overflow:hidden} can't swallow. */
    const scroller = container.querySelector('table')!.parentElement as HTMLElement;
    expect(scroller.style.overflowY).toBe('auto');
    expect(scroller.style.maxHeight).not.toBe('');
    /* Flush: the scroller has no padding, so the stuck header sits tight
       under the card's top with no strip of scrolled rows peeking above it
       (the owner's 不好看). And borderCollapse must stay SEPARATE — Chromium
       mis-offsets sticky th cells under collapsed borders. */
    expect(scroller.style.padding).toBe('0px');
    expect((container.querySelector('table') as HTMLElement).style.borderCollapse).toBe('separate');
    /* Every header cell sticks with a solid background — a transparent
       sticky th lets rows show through it. */
    const ths = [...container.querySelectorAll('thead th')] as HTMLElement[];
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) {
      expect(th.style.position).toBe('sticky');
      expect(th.style.top).toBe('0px');
      expect(th.style.background).not.toBe('');
    }
  });

  test('quick mode: leaf untick and delete skip the confirm; a HEADER untick still asks; default is confirms ON', async () => {
    tickAsync.mockClear(); deleteAsync.mockClear(); confirmFn.mockClear();
    draw();
    const quick = screen.getByRole('switch', { name: 'Quick mode · no confirms' });
    expect(quick.getAttribute('aria-checked')).toBe('false'); // 默认都是要弹的 (owner 2026-09-04)
    fireEvent.click(quick);
    expect(quick.getAttribute('aria-checked')).toBe('true');

    /* Leaf untick — straight through, no dialog. */
    fireEvent.click(screen.getByLabelText('310-0010 for HOUZS'));
    await waitFor(() => expect(tickAsync).toHaveBeenCalledWith({ companyId: 1, code: '310-0010', active: false }));
    expect(confirmFn).not.toHaveBeenCalled();

    /* Delete — straight through too; the server's guard is the net. */
    fireEvent.click(screen.getByLabelText('Delete 310-0010'));
    await waitFor(() => expect(deleteAsync).toHaveBeenCalledWith('310-0010'));
    expect(confirmFn).not.toHaveBeenCalled();

    /* A HEADER untick sweeps children — it asks even in quick mode. */
    fireEvent.click(screen.getByLabelText('310-0000 for HOUZS'));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/child/);
  });

  test('edit is a centred modal (owner: 做成一个 pop out 出来 edit) — and a backdrop click does not eat the form', () => {
    draw();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByLabelText('Edit 310-0010'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Edit 310-0010');
    expect(within(dialog).getByText('A new code moves every journal line, voucher, settlement link and role binding with it.')).toBeTruthy();
    /* A stray click outside must not discard a half-typed rename. */
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('changing the code asks to rename everywhere and calls the rename with both codes', async () => {
    renameAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Edit 310-0010'));
    fireEvent.change(screen.getByLabelText('Edit code'), { target: { value: '311-0010' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const asked = confirmFn.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string };
    expect(asked.title).toBe('Rename 310-0010 to 311-0010 everywhere?');
    expect(asked.body).toMatch(/in one step, or none of it does/);
    expect(asked.confirmLabel).toBe('Rename everywhere');
    await waitFor(() => expect(renameAsync).toHaveBeenCalledWith({ oldCode: '310-0010', newCode: '311-0010' }));
  });

  test('a code in the wrong shape is refused in the form, nothing sent', async () => {
    renameAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Edit 310-0010'));
    fireEvent.change(screen.getByLabelText('Edit code'), { target: { value: '3110010' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The code must look like 305-0010.');
    expect(confirmFn).not.toHaveBeenCalled();
    expect(renameAsync).not.toHaveBeenCalled();
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
    const dialog = screen.getByRole('dialog', { name: 'New account' });
    fireEvent.change(screen.getByPlaceholderText('305-0010'), { target: { value: '201-3000' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'F&F (HOSTEL)' } });
    fireEvent.change(screen.getByLabelText('New account section'), { target: { value: 'CURRENT ASSETS' } });
    fireEvent.change(screen.getByLabelText('Special type'), { target: { value: 'SFA' } });
    expect(screen.getByLabelText('Depreciation code')).toHaveProperty('value', '201-3005');
    expect(screen.getByLabelText('Depreciation name')).toHaveProperty('value', 'ACCUM. DEPRN. - F&F (HOSTEL)');
    fireEvent.click(within(dialog).getByText('Add account'));
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
    expect((screen.getByLabelText(/Money — a bank, cash or e-wallet account/) as HTMLInputElement).checked).toBe(true);
  });

  test('a new account starts ticked for every company (g6: today’s default) and says so', () => {
    draw();
    fireEvent.click(screen.getByText('Add account'));
    const dialog = screen.getByRole('dialog', { name: 'New account' });
    expect(within(dialog).getByText('Ticked for HOUZS and 2990 when it is created; untick a company that does not use it.')).toBeTruthy();
    expect((screen.getByLabelText('new account for HOUZS') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('new account for 2990') as HTMLInputElement).checked).toBe(true);
  });

  test('Add account with nothing filled names the first gap in the form', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Add account'));
    const dialog = screen.getByRole('dialog', { name: 'New account' });
    fireEvent.click(within(dialog).getByText('Add account'));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'The code must look like 305-0010.');
    fireEvent.change(screen.getByPlaceholderText('305-0010'), { target: { value: '310-0010' } });
    fireEvent.click(within(dialog).getByText('Add account'));
    expect(await within(dialog).findByText('310-0010 is already in the chart.')).toBeTruthy();
    expect(createAsync).not.toHaveBeenCalled();
  });

  test('Add account creates once with the ticked companies and the parent; the section follows the parent', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Add account'));
    const dialog = screen.getByRole('dialog', { name: 'New account' });
    fireEvent.change(screen.getByPlaceholderText('305-0010'), { target: { value: '305-0010' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'AHMAD BIN ALI' } });
    fireEvent.change(screen.getByLabelText('New account parent'), { target: { value: '310-0000' } });
    expect((screen.getByLabelText('New account section') as HTMLSelectElement).value).toBe('CURRENT ASSETS');
    fireEvent.click(screen.getByLabelText('new account for 2990')); // untick 2990 → HOUZS only
    fireEvent.click(within(dialog).getByText('Add account'));
    /* The payload names the SECTION; the server derives the type from it. */
    await waitFor(() => expect(createAsync).toHaveBeenCalledWith({
      code: '305-0010', name: 'AHMAD BIN ALI', section: 'CURRENT ASSETS',
      parentCode: '310-0000', accMoney: false, companyIds: [1],
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
    expect((confirmFn.mock.calls[0]![0] as { title: string }).title).toBe('Put 900-A002 ADVERTISEMENT under 310-0000 CASH AT BANK?');
  });

  test('the edit modal moves an account under a parent (and none = the top of its section)', async () => {
    updateAsync.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Edit 310-0010'));
    fireEvent.change(screen.getByLabelText('Edit parent'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '310-0010', parentCode: null }));
  });

  test('delete confirms in red, then sends the code', async () => {
    deleteAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Delete 900-A002'));
    await waitFor(() => expect(deleteAsync).toHaveBeenCalledWith('900-A002'));
    const asked = confirmFn.mock.calls[0]![0] as { title: string; body: string; danger?: boolean };
    expect(asked.title).toBe('Delete 900-A002 ADVERTISEMENT?');
    expect(asked.body).toMatch(/no transactions and no references anywhere/);
    expect(asked.danger).toBe(true);
  });

  test('a header’s delete is refused without a call — its children hold it', async () => {
    deleteAsync.mockClear(); confirmFn.mockClear(); notifyFn.mockClear();
    draw();
    expect(screen.getByLabelText('Delete 310-0000').getAttribute('title')).toBe('Has children · untick instead');
    fireEvent.click(screen.getByLabelText('Delete 310-0000'));
    await waitFor(() => expect(notifyFn).toHaveBeenCalled());
    expect(JSON.stringify(notifyFn.mock.calls[0]![0])).toMatch(/310-0000 cannot be deleted: it has children/);
    expect(confirmFn).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});

describe('the upload preview', () => {
  test('counts new vs already in the chart and imports on confirm', async () => {
    importAsync.mockClear();
    draw();
    const aoa = [
      ['CURRENT ASSETS'],
      ['310-0000', 'CASH AT BANK', null, 'MYR'],
      ['    310-0010', 'CASH AT BANK - MAYBANK', null, 'MYR', null, null, null, null, 'SBK'],
      ['EXPENSES'],
      ['900-A002', 'ADVERTISEMENT', null, 'MYR'],
      ['900-A099', 'NEW THING', null, 'MYR'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const file = new File([buf], 'chart.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => buf });

    fireEvent.change(screen.getByLabelText(/Upload AutoCount chart/), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/chart\.xlsx · 4 accounts read/)).toBeTruthy());
    expect(screen.getByText(/1 is new and 3 are already in the chart/)).toBeTruthy();
    expect(screen.getByText(/stay HOUZS-only \(1\)/)).toBeTruthy();
    /* The new rows are listed with their section and where they go. */
    expect(screen.getByText('NEW THING')).toBeTruthy();

    fireEvent.click(screen.getByText('Import'));
    await waitFor(() => expect(importAsync).toHaveBeenCalled());
    const sent = importAsync.mock.calls[0]![0] as { companyId: number; rows: Array<{ code: string; shared: boolean }> };
    expect(sent.companyId).toBe(1);
    expect(sent.rows.map((r) => [r.code, r.shared])).toEqual([
      ['310-0000', true], ['310-0010', false], ['900-A002', true], ['900-A099', true],
    ]);
  });
});

/* Needs event and the PMS row (owner 2026-10-01, payment-request item 4): Finance's
   call per account, on the chart — a money account, never a header. */
describe('Needs event and the PMS row', () => {
  test('a money account carries both; a tick and a pick save on the code; a header carries neither', async () => {
    updateAsync.mockClear();
    draw();
    expect(screen.getByText('Needs event')).toBeTruthy();
    expect((screen.getByLabelText('900-R032 needs its event') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('900-R032 PMS row') as HTMLSelectElement).value).toBe('rental');
    expect(screen.queryByLabelText('310-0000 needs its event')).toBeNull();
    expect(screen.queryByLabelText('500-0000 PMS row')).toBeNull();
    fireEvent.click(screen.getByLabelText('900-A002 needs its event'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-A002', needsEvent: true }));
    fireEvent.change(screen.getByLabelText('900-R032 PMS row'), { target: { value: 'others' } });
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-R032', pmsRow: 'others' }));
    fireEvent.change(screen.getByLabelText('900-R032 PMS row'), { target: { value: '' } });
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-R032', pmsRow: null }));
  });
});

/* The Logistics P&L's row (owner 2026-10-29: the own-lorry tick list moved to the
   chart —「就不能在coa 那边tick？」): one per account, of the type the row reads. */
describe('the Logistics row', () => {
  test('an account offers the rows of its type; a header and an asset none; a pick and an empty save on the code', async () => {
    updateAsync.mockClear();
    draw();
    const options = (code: string) => [...(screen.getByLabelText(`${code} Logistics row`) as HTMLSelectElement).options].map((o) => o.value);
    expect(options('900-A002')).toEqual(['', 'outsource_pg', 'petrol']);
    expect(options('590-0000')).toEqual(['', 'income_kl']);
    expect(options('400-0000')).toEqual(['', 'instalment']);
    expect((screen.getByLabelText('900-R032 Logistics row') as HTMLSelectElement).value).toBe('outsource_pg');
    expect(screen.queryByLabelText('310-0010 Logistics row')).toBeNull();
    expect(screen.queryByLabelText('700-0000 Logistics row')).toBeNull();
    fireEvent.change(screen.getByLabelText('900-A002 Logistics row'), { target: { value: 'petrol' } });
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-A002', logisticsRow: 'petrol' }));
    fireEvent.change(screen.getByLabelText('900-R032 Logistics row'), { target: { value: '' } });
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ code: '900-R032', logisticsRow: null }));
  });
});
