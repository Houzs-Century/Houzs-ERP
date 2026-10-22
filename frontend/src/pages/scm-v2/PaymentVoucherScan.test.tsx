/* The bill pile's three cases (owner 2026-09-02, his taxonomy exactly):
     1. 一张bill 几页   — ticked files MERGE into one bill before reading;
     2. 一个supplier 多张单 — read bills group by supplier and open as ONE
        voucher, one line per bill;
     3. 多个supplier 多个单 — "pay each bill separately" splits the group.
   The reading itself (Claude vision, supplier matching) is pinned server-side
   in backend/src/acc/bill-extract.test.ts — here the mutateAsync is canned
   and what is under test is the grouping arithmetic around it.
   Since 2026-10-05 the pile sends ONE bill per request, three at a time (four
   bills together outran the 30-second wait): the canned reader answers each
   call by its bill's first file. */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExtractedBill } from '../../vendor/scm/lib/payment-voucher-queries';
import type { BillMatch } from '../../vendor/scm/lib/payment-request-queries';
import { takePvFiles } from '../../vendor/scm/lib/pv-file-handoff';
import { clearAllPiles } from '../../vendor/scm/lib/bill-pile-store';
import { setActiveCompanyId } from '../../lib/activeCompany';
import { BackToPile } from '../../vendor/scm/components/BackToPile';

type Bills = Array<{ files: Array<{ name: string; mime: string; dataBase64: string }> }>;
const extractAsync = vi.fn(async (_bills: Bills) => ({ bills: [] as ExtractedBill[] }));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useExtractBills: () => ({ mutateAsync: extractAsync, isPending: false }),
  fileToBase64: async (f: File) => `b64:${f.name}`,
}));
/* The same bill elsewhere (owner 2026-10-05: 提醒也加), answered by number|date. */
let sameBills: Record<string, BillMatch[]> = {};
vi.mock('../../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-request-queries')>()),
  useBillMatches: (no: string, date: string) => ({ data: { matches: sameBills[`${no}|${date}`] ?? [] } }),
}));

import { MAX_PILE_FILES, PaymentVoucherScan } from './PaymentVoucherScan';

/* The reader, one bill per call: each call's answer is looked up by the bill's
   first file; the page puts it in that bill's place. */
const answers = (byFile: Partial<Record<string, ExtractedBill>>) => {
  extractAsync.mockImplementation(async (bills: Bills) => {
    const a = byFile[bills[0]!.files[0]!.name];
    return { bills: a ? [{ ...a, index: 0 }] : [] };
  });
};
/* Every bill answered: the Read button is back. */
const readDone = (n: number) => waitFor(() => expect(screen.getByText(`Read ${n} bill(s)`)).toBeTruthy());

beforeEach(() => {
  /* The pile outlives the page (bill-pile-store) — every test starts on an empty one. */
  clearAllPiles();
  extractAsync.mockReset();
  extractAsync.mockImplementation(async () => ({ bills: [] as ExtractedBill[] }));
  sameBills = {};
});

/* The landing probe: what /new would receive in location.state. */
let landedState: unknown = null;
const NewProbe = () => {
  landedState = useLocation().state;
  return <div>NEW PAGE</div>;
};

let piLandedState: unknown = null;
const PiProbe = () => {
  piLandedState = useLocation().state;
  return <div>PI NEW PAGE</div>;
};

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/payment-vouchers/scan']}>
    <Routes>
      <Route path="/scm/payment-vouchers/scan" element={<PaymentVoucherScan />} />
      <Route path="/scm/payment-vouchers/new" element={<NewProbe />} />
      <Route path="/scm/purchase-invoices/new" element={<PiProbe />} />
    </Routes>
  </MemoryRouter>,
);

const pdf = (name: string) => new File(['%PDF-1.4 x'], name, { type: 'application/pdf' });

const readBill = (index: number, over: Partial<{ invoiceNumber: string | null; totalSen: number | null; vendorName: string | null; lines: Array<{ description: string | null; amountSen: number | null }> }>,
  match: { id: string; name: string } | null,
  memory: { payeeName: string; debitAccountCode: string } | null = null): ExtractedBill => ({
  index, ok: true,
  extraction: {
    vendorName: over.vendorName ?? 'FOSHAN CHAIRS SDN BHD', vendorRegNo: null, documentKind: 'invoice',
    invoiceNumber: over.invoiceNumber ?? null, invoiceDate: '2026-09-01', dueDate: null,
    currency: 'MYR', totalSen: over.totalSen ?? null, sstSen: null, lines: over.lines ?? [],
  },
  supplierMatch: match ? { id: match.id, code: 'S001', name: match.name, confidence: 'exact' } : null,
  memory: memory ? { ...memory, purpose: 'OTHER', timesSeen: 2 } : null,
});

/* The same pile for AP invoices (owner 2026-09-08: 每张单一张 ap invoice … 分出来
   一张一张): the reading and the merge are the voucher's; every bill opens as
   its own AP invoice, and a same-supplier group is never offered as one. */
describe('the pile for AP invoices', () => {
  let apLanded: unknown = null;
  const ApProbe = () => { apLanded = useLocation().state; return <div>AP LIST</div>; };
  const drawAp = () => render(
    <MemoryRouter initialEntries={['/scm/ap-invoices/scan']}>
      <Routes>
        <Route path="/scm/ap-invoices/scan" element={<PaymentVoucherScan target="ap" />} />
        <Route path="/scm/ap-invoices" element={<ApProbe />} />
      </Routes>
    </MemoryRouter>,
  );

  test('same-supplier bills stay one AP invoice each; the one opened carries its reading and stashes its pages', async () => {
    apLanded = null;
    answers({
      'a.pdf': readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
      'b.pdf': readBill(1, { invoiceNumber: 'INV-2', totalSen: 50000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
    });
    drawAp();
    expect(screen.getByText('Scan bills — AP invoices')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);

    await waitFor(() => expect(screen.getAllByText('Open as AP invoice')).toHaveLength(2));
    expect(screen.queryByText(/Open as ONE voucher/)).toBeNull();
    expect(screen.queryByText('Open as voucher')).toBeNull();
    expect(screen.queryByLabelText(/bills separately/)).toBeNull();
    /* Nor the petty-cash tick: an AP invoice is one per bill by nature. */
    expect(screen.queryByLabelText(/for one voucher/)).toBeNull();
    expect(screen.queryByText(/Open ticked as ONE voucher/)).toBeNull();

    fireEvent.click(screen.getAllByText('Open as AP invoice')[1]!);
    await waitFor(() => expect(screen.getByText('AP LIST')).toBeTruthy());
    const state = apLanded as { apPrefill: { extraction: { invoiceNumber: string | null }; supplierMatch: { id: string } | null; memory: { debitAccountCode: string | null } | null } };
    expect(state.apPrefill.extraction.invoiceNumber).toBe('INV-2');
    expect(state.apPrefill.supplierMatch).toMatchObject({ id: 'sup-1' });
    expect(state.apPrefill.memory).toMatchObject({ debitAccountCode: '900-F002' });
    expect(takePvFiles().map((f) => f.name)).toEqual(['b.pdf']);
  });
});

describe('the bill pile', () => {
  test('case 1: ticked pages merge into ONE bill in the payload sent for reading', async () => {
    draw();
    const input = screen.getByLabelText('Add bill files');
    fireEvent.change(input, { target: { files: [pdf('page-1.pdf'), pdf('page-2.pdf'), pdf('other.pdf')] } });

    /* Three files, three bills — until the human says two of them are pages. */
    expect(screen.getByText('Read 3 bill(s)')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select page-1.pdf'));
    fireEvent.click(screen.getByLabelText('Select page-2.pdf'));
    /* The button says what Merge IS — pages of one bill — since the owner
       pressed it to put three receipts on one voucher (2026-09-08). */
    fireEvent.click(screen.getByText('These 2 files are pages of ONE bill — merge'));
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);

    /* One request per bill — the merged pages travel together as ONE. */
    expect(extractAsync).toHaveBeenCalledTimes(2);
    const sent = extractAsync.mock.calls.map(([bills]) => bills);
    expect(sent.every((bills) => bills.length === 1)).toBe(true);
    expect(sent.map((bills) => bills[0]!.files.map((f) => f.name)).sort()).toEqual([
      ['other.pdf'],
      ['page-1.pdf', 'page-2.pdf'],
    ]);
    const merged = sent.find((bills) => bills[0]!.files.length === 2)![0]!;
    expect(merged.files[0]!.mime).toBe('application/pdf');
    expect(merged.files[0]!.dataBase64).toBe('b64:page-1.pdf');
  });

  test('case 2: same-supplier bills group and open as ONE voucher, one line per bill', async () => {
    landedState = null;
    answers({
      'a.pdf': readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
      'b.pdf': readBill(1, { invoiceNumber: 'INV-2', totalSen: 50000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
    });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);

    await waitFor(() => expect(screen.getByText('Foshan Chairs')).toBeTruthy());
    expect(screen.getByText(/2 bill\(s\) · RM 1,500\.00 · matched supplier · account remembered \(900-F002\)/)).toBeTruthy();

    fireEvent.click(screen.getByText('Open as ONE voucher (2 lines)'));
    await waitFor(() => expect(screen.getByText('NEW PAGE')).toBeTruthy());
    const state = landedState as { billPrefill: { extraction: { invoiceNumber: string | null }; lines: Array<{ description: string | null; amountSen: number | null }>; memory: { debitAccountCode: string | null } | null } };
    expect(state.billPrefill.extraction.invoiceNumber).toBe('INV-1, INV-2');
    expect(state.billPrefill.lines).toEqual([
      { description: 'Foshan Chairs INV-1', amountSen: 100000 },
      { description: 'Foshan Chairs INV-2', amountSen: 50000 },
    ]);
    /* The habit rides along — the New page fills the account from it. */
    expect(state.billPrefill.memory).toMatchObject({ debitAccountCode: '900-F002' });
    /* And the bills' own BYTES ride the module stash (never location.state —
       a big PDF would blow the history-entry cap): every member's pages, in
       bill order, for the New page to attach after save. */
    expect(takePvFiles().map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  test('a read bill shows its own line items, and dropped files join the pile', async () => {
    answers({
      'dropped.pdf': readBill(0, { invoiceNumber: 'INV-9', totalSen: 30000, lines: [
        { description: 'Design retainer — August', amountSen: 20000 },
        { description: 'Extra artwork', amountSen: 10000 },
      ] }, null),
    });
    draw();
    /* Files arrive by DROP, not the picker (owner: 我无法从我的folder 拖动进来). */
    fireEvent.drop(screen.getByText('The pile').closest('section')!, {
      dataTransfer: { files: [pdf('dropped.pdf')] },
    });
    expect(screen.getByText('dropped.pdf')).toBeTruthy();
    fireEvent.click(screen.getByText('Read 1 bill(s)'));
    await readDone(1);
    await waitFor(() => expect(screen.getByText('INV-9')).toBeTruthy());
    expect(screen.getByText('Design retainer — August')).toBeTruthy();
    expect(screen.getByText('Extra artwork')).toBeTruthy();
    expect(screen.getByText('RM 100.00')).toBeTruthy();
  });

  test('case 4: DIFFERENT receipts tick across groups and open as ONE voucher — one line each, no payee, every page attached', async () => {
    landedState = null;
    answers({
      /* Two goods on one receipt: the line says what was bought, joined. */
      'a.pdf': readBill(0, { vendorName: '99 SPEEDMART S/B', invoiceNumber: 'T0012', totalSen: 1910, lines: [
        { description: '4475 3M SCOTCH BRITE SPAN P', amountSen: 1040 },
        { description: '1953 FEBREZE FABRIK ANTI BA', amountSen: 870 },
      ] }, null),
      /* Shell has a remembered payee and account — NOT borrowed for the lot. */
      'b.pdf': readBill(1, { vendorName: 'SHELL MALAYSIA', invoiceNumber: 'S-99', totalSen: 5000 }, null, { payeeName: 'Shell', debitAccountCode: '900-M001' }),
      /* No readable item: the shop + number stands in. */
      'c.pdf': readBill(2, { vendorName: 'WATSONS', invoiceNumber: 'W-1', totalSen: 1200 }, null),
    });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    fireEvent.click(screen.getByText('Read 3 bill(s)'));
    await readDone(3);

    /* Three shops = three groups, each its own voucher — until ticked together. */
    await waitFor(() => expect(screen.getByText('Open ticked as ONE voucher (0 lines)')).toBeTruthy());
    expect(screen.getAllByText('Open as voucher')).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('Tick T0012 for one voucher'));
    fireEvent.click(screen.getByLabelText('Tick W-1 for one voucher'));
    fireEvent.click(screen.getByText('Open ticked as ONE voucher (2 lines)'));
    await waitFor(() => expect(screen.getByText('NEW PAGE')).toBeTruthy());

    const state = landedState as { billPrefill: { extraction: { vendorName: string | null; invoiceNumber: string | null; totalSen: number | null; documentKind: string }; lines: Array<{ description: string | null; amountSen: number | null }>; memory: unknown } };
    expect(state.billPrefill.extraction.vendorName).toBeNull();     // the payee is the person's to type
    expect(state.billPrefill.memory).toBeNull();                     // no shop's habit borrowed
    expect(state.billPrefill.extraction.documentKind).toBe('receipt');
    expect(state.billPrefill.extraction.invoiceNumber).toBe('T0012, W-1');
    expect(state.billPrefill.extraction.totalSen).toBe(3110);
    /* The line is WHAT WAS BOUGHT at the receipt's total, never the shop's
       name (owner: 转去 voucher 就变名字了) — the shop stands in only when no
       item was readable. */
    expect(state.billPrefill.lines).toEqual([
      { description: '4475 3M SCOTCH BRITE SPAN P · 1953 FEBREZE FABRIK ANTI BA', amountSen: 1910 },
      { description: 'WATSONS W-1', amountSen: 1200 },
    ]);
    /* Only the ticked receipts' pages, in bill order — Shell's stays out. */
    expect(takePvFiles().map((f) => f.name)).toEqual(['a.pdf', 'c.pdf']);
  });

  test('case 3: "pay each bill separately" splits the group; unreadable totals and failures are named', async () => {
    answers({
      'a.pdf': readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, { id: 'sup-1', name: 'Foshan Chairs' }),
      'b.pdf': readBill(1, { invoiceNumber: 'INV-2', totalSen: null }, { id: 'sup-1', name: 'Foshan Chairs' }),
      'c.pdf': { index: 2, ok: false, reason: 'The reader answered with something other than JSON.' },
    });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    fireEvent.click(screen.getByText('Read 3 bill(s)'));
    await readDone(3);

    /* Grouped by default — no per-bill buttons until the human splits. */
    await waitFor(() => expect(screen.getByText('Open as ONE voucher (2 lines)')).toBeTruthy());
    expect(screen.queryAllByText('Open as voucher')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Pay Foshan Chairs bills separately'));
    expect(screen.queryByText(/Open as ONE voucher/)).toBeNull();
    expect(screen.getAllByText('Open as voucher')).toHaveLength(2);

    /* The honest edges: a null total is flagged, a failed bill keeps its reason. */
    expect(screen.getByText('total unreadable — will need typing')).toBeTruthy();
    expect(screen.getByText(/Bill 3 \(c\.pdf\) could not be read: The reader answered/)).toBeTruthy();
    expect(screen.getByText(/1 bill\(s\) could not be read/)).toBeTruthy();

    /* A SPLIT bill stashes only ITS OWN file — never a sibling's. */
    fireEvent.click(screen.getAllByText('Open as voucher')[0]!);
    await waitFor(() => expect(screen.getByText('NEW PAGE')).toBeTruthy());
    expect(takePvFiles().map((f) => f.name)).toEqual(['a.pdf']);
  });
});

describe('扫 → bill (owner 2026-09-03: 他是扫 bill, 然后帮我录入 bill)', () => {
  test('a grouped pair opens as ONE bill — matched supplier, joined numbers, one line per bill', async () => {
    piLandedState = null;
    answers({
      'a.pdf': readBill(0, { invoiceNumber: 'ZJM-88', totalSen: 1644000 }, { id: 'sup-405', name: 'Zhejiang Ju Miao' }),
      'b.pdf': readBill(1, { invoiceNumber: 'ZJM-89', totalSen: 100000 }, { id: 'sup-405', name: 'Zhejiang Ju Miao' }),
    });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);

    await waitFor(() => expect(screen.getByText('Open as ONE bill')).toBeTruthy());
    fireEvent.click(screen.getByText('Open as ONE bill'));
    await waitFor(() => expect(screen.getByText('PI NEW PAGE')).toBeTruthy());
    const state = piLandedState as { scanBill: { supplierId: string | null; extraction: { invoiceNumber: string | null }; lines: Array<{ description: string | null; amountSen: number | null }> } };
    expect(state.scanBill.supplierId).toBe('sup-405');
    expect(state.scanBill.extraction.invoiceNumber).toBe('ZJM-88, ZJM-89');
    expect(state.scanBill.lines).toEqual([
      { description: 'Zhejiang Ju Miao ZJM-88', amountSen: 1644000 },
      { description: 'Zhejiang Ju Miao ZJM-89', amountSen: 100000 },
    ]);
  });

  test('a split (or single) bill offers its own Open as bill, carrying the extraction alone', async () => {
    piLandedState = null;
    answers({
      'c.pdf': readBill(0, { invoiceNumber: 'ZJM-90', totalSen: 50000 }, { id: 'sup-405', name: 'Zhejiang Ju Miao' }),
    });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('c.pdf')] } });
    fireEvent.click(screen.getByText('Read 1 bill(s)'));
    await readDone(1);

    await waitFor(() => expect(screen.getByText('Open as bill')).toBeTruthy());
    fireEvent.click(screen.getByText('Open as bill'));
    await waitFor(() => expect(screen.getByText('PI NEW PAGE')).toBeTruthy());
    const state = piLandedState as { scanBill: { supplierId: string | null; extraction: { invoiceNumber: string | null }; lines?: unknown } };
    expect(state.scanBill.supplierId).toBe('sup-405');
    expect(state.scanBill.extraction.invoiceNumber).toBe('ZJM-90');
    expect(state.scanBill.lines).toBeUndefined();
  });
});

/* 同时 upload 多 (owner 2026-10-05): four bills sent as ONE request outran the
   30-second wait and the page said it could not confirm a save. Now each bill
   is its own request, three with the reader at a time; each lands in its place
   as it is read; one that fails is read again alone; a pile holds at most
   MAX_PILE_FILES files; and a bill already entered says so beside it. */
describe('many bills at once', () => {
  const drawApPile = () => render(
    <MemoryRouter initialEntries={['/scm/ap-invoices/scan']}>
      <Routes>
        <Route path="/scm/ap-invoices/scan" element={<PaymentVoucherScan target="ap" />} />
        <Route path="/scm/ap-invoices" element={<div>AP LIST</div>} />
      </Routes>
    </MemoryRouter>,
  );
  const add = (...names: string[]) => fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: names.map(pdf) } });

  test('one bill per request, three with the reader at a time; each shows as it is read, and opening waits for the last', async () => {
    const waiting: Array<() => void> = [];
    let live = 0;
    let most = 0;
    extractAsync.mockImplementation((bills: Bills) => new Promise<{ bills: ExtractedBill[] }>((resolve) => {
      live += 1;
      most = Math.max(most, live);
      const no = bills[0]!.files[0]!.name.replace('.pdf', '').toUpperCase();
      waiting.push(() => { live -= 1; resolve({ bills: [{ ...readBill(0, { invoiceNumber: no, totalSen: 10000 }, null), index: 0 }] }); });
    }));
    drawApPile();
    add('inv-a.pdf', 'inv-b.pdf', 'inv-c.pdf', 'inv-d.pdf');
    fireEvent.click(screen.getByText('Read 4 bill(s)'));

    await waitFor(() => expect(waiting).toHaveLength(3));
    expect(screen.getByText('Reading… 0 of 4 done')).toBeTruthy();
    await act(async () => { waiting[0]!(); });
    await waitFor(() => expect(screen.getByText('INV-A')).toBeTruthy());
    /* The lane that came free took the fourth bill. */
    await waitFor(() => expect(waiting).toHaveLength(4));
    expect(screen.getByText('Reading… 1 of 4 done')).toBeTruthy();
    /* Opening waits — leaving now would drop the bills still with the reader. */
    expect(screen.getByText('Open as AP invoice').closest('button')!.disabled).toBe(true);

    await act(async () => { waiting.slice(1).forEach((go) => { go(); }); });
    await readDone(4);
    expect(screen.getAllByText('Open as AP invoice').every((b) => !b.closest('button')!.disabled)).toBe(true);
    expect(most).toBe(3);
    expect(extractAsync).toHaveBeenCalledTimes(4);
    expect(extractAsync.mock.calls.every(([bills]) => bills.length === 1)).toBe(true);
    /* In pile order, whatever order they were answered in. */
    expect(screen.getAllByText(/^INV-[A-D]$/).map((el) => el.textContent)).toEqual(['INV-A', 'INV-B', 'INV-C', 'INV-D']);
  });

  test('a bill that cannot be read names its file and is read again on its own; the rest stand', async () => {
    let blurryTries = 0;
    extractAsync.mockImplementation(async (bills: Bills) => {
      const name = bills[0]!.files[0]!.name;
      if (name === 'blurry.pdf' && blurryTries++ === 0) throw new Error('Reading took too long — nothing was saved. Please read it again.');
      return { bills: [{ ...readBill(0, { invoiceNumber: name === 'blurry.pdf' ? 'INV-B' : 'INV-A', totalSen: 5000 }, null), index: 0 }] };
    });
    drawApPile();
    add('good.pdf', 'blurry.pdf');
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);
    expect(screen.getByText(/Bill 2 \(blurry\.pdf\) could not be read: Reading took too long — nothing was saved/)).toBeTruthy();
    expect(screen.getByText(/1 bill\(s\) could not be read/)).toBeTruthy();
    expect(screen.getByText('INV-A')).toBeTruthy();

    extractAsync.mockClear();
    fireEvent.click(screen.getByText('Read again'));
    await waitFor(() => expect(screen.getByText('INV-B')).toBeTruthy());
    expect(extractAsync).toHaveBeenCalledTimes(1);
    expect(extractAsync.mock.calls[0]![0].map((b) => b.files.map((f) => f.name))).toEqual([['blurry.pdf']]);
    await waitFor(() => expect(screen.queryByText(/could not be read/)).toBeNull());
    expect(screen.getByText('INV-A')).toBeTruthy();
  });

  test(`a pile holds at most ${MAX_PILE_FILES} files — the rest are left out, and said`, () => {
    drawApPile();
    add(...Array.from({ length: MAX_PILE_FILES + 2 }, (_, i) => `bill-${i + 1}.pdf`));
    expect(screen.getByText(`Read ${MAX_PILE_FILES} bill(s)`)).toBeTruthy();
    expect(screen.getByText(new RegExp(`at most ${MAX_PILE_FILES} files — 2 left out`))).toBeTruthy();
    expect(screen.queryByText(`bill-${MAX_PILE_FILES + 1}.pdf`)).toBeNull();
    /* Full: one more is left out too. */
    add('one-more.pdf');
    expect(screen.queryByText('one-more.pdf')).toBeNull();
  });

  test('a read bill already asked for, vouchered or entered says so beside it — a warning; it still opens', async () => {
    sameBills = { 'INV-7|2026-09-01': [{ kind: 'API', id: 'api-7', number: 'HC-API-2610-004', amountSen: 189_000, status: 'DRAFT', answeredBy: null }] };
    answers({
      'a.pdf': readBill(0, { invoiceNumber: 'INV-7', totalSen: 189_000 }, null),
      'b.pdf': readBill(1, { invoiceNumber: 'INV-8', totalSen: 34_000 }, null),
    });
    drawApPile();
    add('a.pdf', 'b.pdf');
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);
    const notes = screen.getAllByRole('alert', { name: 'Same bill elsewhere' });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain('AP invoice HC-API-2610-004 · RM 1,890.00 · draft');
    /* Beside ITS bill, not the other one. */
    const box = screen.getByText('INV-7').parentElement!.parentElement!;
    expect(within(box).getByRole('alert', { name: 'Same bill elsewhere' })).toBe(notes[0]);
    /* A warning, never a block. */
    fireEvent.click(within(box).getByText('Open as AP invoice'));
    await waitFor(() => expect(screen.getByText('AP LIST')).toBeTruthy());
    expect(takePvFiles().map((f) => f.name)).toEqual(['a.pdf']);
  });
});

/* 开了一张 AP invoice 回来，剩下的单要重新读 → 回来时还在 (owner 2026-10-06). */
describe('the pile stays while the tab lives', () => {
  const drawAp = () => render(
    <MemoryRouter initialEntries={['/scm/ap-invoices/scan']}>
      <Routes>
        <Route path="/scm/ap-invoices/scan" element={<PaymentVoucherScan target="ap" />} />
        <Route path="/scm/ap-invoices" element={<div>AP LIST <BackToPile target="ap" /></div>} />
      </Routes>
    </MemoryRouter>,
  );
  const add = (...names: string[]) => fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: names.map(pdf) } });
  const twoBills = () => answers({
    'a.pdf': readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, null),
    'b.pdf': readBill(1, { invoiceNumber: 'INV-2', totalSen: 50000 }, null),
  });

  test('open one bill, come back: the others are still read — nothing read twice — and the opened one says so', async () => {
    twoBills();
    const first = drawAp();
    add('a.pdf', 'b.pdf');
    fireEvent.click(screen.getByText('Read 2 bill(s)'));
    await readDone(2);
    fireEvent.click(screen.getAllByText('Open as AP invoice')[0]!);
    await waitFor(() => expect(screen.getByText(/AP LIST/)).toBeTruthy());
    /* The AP page offers the way back, counting what is left. */
    fireEvent.click(screen.getByText('← Back to Scan bills (1 left)'));
    await waitFor(() => expect(screen.getByText('INV-2')).toBeTruthy());
    expect(screen.getByText('INV-1')).toBeTruthy();
    expect(within(screen.getByText('INV-1').closest('span')!).getByText('· opened')).toBeTruthy();
    expect(extractAsync).toHaveBeenCalledTimes(2);
    first.unmount();
    /* A page drawn afresh — a later visit — finds the same pile. */
    drawAp();
    expect(screen.getByText('INV-2')).toBeTruthy();
    expect(screen.getByText('a.pdf')).toBeTruthy();
    expect(extractAsync).toHaveBeenCalledTimes(2);
  });

  test('Clear the pile empties it; a read still out when it was cleared is dropped', async () => {
    let release: () => void = () => {};
    extractAsync.mockImplementation((bills: Bills) => new Promise<{ bills: ExtractedBill[] }>((resolve) => {
      release = () => resolve({ bills: [{ ...readBill(0, { invoiceNumber: bills[0]!.files[0]!.name === 'a.pdf' ? 'INV-1' : 'INV-X', totalSen: 1 }, null), index: 0 }] });
    }));
    drawAp();
    add('a.pdf');
    fireEvent.click(screen.getByText('Read 1 bill(s)'));
    await waitFor(() => expect(extractAsync).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Clear the pile'));
    expect(screen.queryByText('a.pdf')).toBeNull();
    await act(async () => { release(); });
    expect(screen.queryByText('INV-1')).toBeNull();
    expect(screen.queryByText('Clear the pile')).toBeNull();
  });

  test("each company keeps its own pile — a 2990 pile never shows in Houzs", async () => {
    twoBills();
    try {
      act(() => { setActiveCompanyId(2); });
      drawAp();
      add('a.pdf');
      expect(screen.getByText('a.pdf')).toBeTruthy();
      act(() => { setActiveCompanyId(1); });
      expect(screen.queryByText('a.pdf')).toBeNull();
      act(() => { setActiveCompanyId(2); });
      expect(screen.getByText('a.pdf')).toBeTruthy();
    } finally {
      act(() => { setActiveCompanyId(null); });
    }
  });
});
