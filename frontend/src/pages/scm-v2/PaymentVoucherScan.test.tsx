/* The bill pile's three cases (owner 2026-09-02, his taxonomy exactly):
     1. 一张bill 几页   — ticked files MERGE into one bill before reading;
     2. 一个supplier 多张单 — read bills group by supplier and open as ONE
        voucher, one line per bill;
     3. 多个supplier 多个单 — "pay each bill separately" splits the group.
   The reading itself (Claude vision, supplier matching) is pinned server-side
   in backend/src/acc/bill-extract.test.ts — here the mutateAsync is canned
   and what is under test is the grouping arithmetic around it. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { ExtractedBill } from '../../vendor/scm/lib/payment-voucher-queries';
import { takePvFiles } from '../../vendor/scm/lib/pv-file-handoff';

const extractAsync = vi.fn(async (_bills: Array<{ files: Array<{ name: string; mime: string; dataBase64: string }> }>) =>
  ({ bills: [] as ExtractedBill[] }));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useExtractBills: () => ({ mutateAsync: extractAsync, isPending: false }),
  fileToBase64: async (f: File) => `b64:${f.name}`,
}));

import { PaymentVoucherScan } from './PaymentVoucherScan';

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
    extractAsync.mockClear(); apLanded = null;
    extractAsync.mockResolvedValueOnce({ bills: [
      readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
      readBill(1, { invoiceNumber: 'INV-2', totalSen: 50000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
    ] });
    drawAp();
    expect(screen.getByText('Scan bills — AP invoices')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    fireEvent.click(screen.getByText('Read 2 bill(s)'));

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
    extractAsync.mockClear();
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

    await waitFor(() => expect(extractAsync).toHaveBeenCalled());
    const bills = extractAsync.mock.calls[0]![0];
    expect(bills.map((b) => b.files.map((f) => f.name))).toEqual([
      ['other.pdf'],
      ['page-1.pdf', 'page-2.pdf'],
    ]);
    expect(bills[1]!.files[0]!.mime).toBe('application/pdf');
    expect(bills[1]!.files[0]!.dataBase64).toBe('b64:page-1.pdf');
  });

  test('case 2: same-supplier bills group and open as ONE voucher, one line per bill', async () => {
    extractAsync.mockClear();
    landedState = null;
    extractAsync.mockResolvedValueOnce({ bills: [
      readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
      readBill(1, { invoiceNumber: 'INV-2', totalSen: 50000 }, { id: 'sup-1', name: 'Foshan Chairs' }, { payeeName: 'Foshan Chairs', debitAccountCode: '900-F002' }),
    ] });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    fireEvent.click(screen.getByText('Read 2 bill(s)'));

    await waitFor(() => expect(screen.getByText('Foshan Chairs')).toBeTruthy());
    expect(screen.getByText(/2 bill\(s\) · MYR 1,500\.00 · matched supplier · account remembered \(900-F002\)/)).toBeTruthy();

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
    extractAsync.mockClear();
    extractAsync.mockResolvedValueOnce({ bills: [
      readBill(0, { invoiceNumber: 'INV-9', totalSen: 30000, lines: [
        { description: 'Design retainer — August', amountSen: 20000 },
        { description: 'Extra artwork', amountSen: 10000 },
      ] }, null),
    ] });
    draw();
    /* Files arrive by DROP, not the picker (owner: 我无法从我的folder 拖动进来). */
    fireEvent.drop(screen.getByText('The pile').closest('section')!, {
      dataTransfer: { files: [pdf('dropped.pdf')] },
    });
    expect(screen.getByText('dropped.pdf')).toBeTruthy();
    fireEvent.click(screen.getByText('Read 1 bill(s)'));
    await waitFor(() => expect(screen.getByText('INV-9')).toBeTruthy());
    expect(screen.getByText('Design retainer — August')).toBeTruthy();
    expect(screen.getByText('Extra artwork')).toBeTruthy();
    expect(screen.getByText('MYR 100.00')).toBeTruthy();
  });

  test('case 4: DIFFERENT receipts tick across groups and open as ONE voucher — one line each, no payee, every page attached', async () => {
    extractAsync.mockClear();
    landedState = null;
    extractAsync.mockResolvedValueOnce({ bills: [
      /* Two goods on one receipt: the line says what was bought, joined. */
      readBill(0, { vendorName: '99 SPEEDMART S/B', invoiceNumber: 'T0012', totalSen: 1910, lines: [
        { description: '4475 3M SCOTCH BRITE SPAN P', amountSen: 1040 },
        { description: '1953 FEBREZE FABRIK ANTI BA', amountSen: 870 },
      ] }, null),
      /* Shell has a remembered payee and account — NOT borrowed for the lot. */
      readBill(1, { vendorName: 'SHELL MALAYSIA', invoiceNumber: 'S-99', totalSen: 5000 }, null, { payeeName: 'Shell', debitAccountCode: '900-M001' }),
      /* No readable item: the shop + number stands in. */
      readBill(2, { vendorName: 'WATSONS', invoiceNumber: 'W-1', totalSen: 1200 }, null),
    ] });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    fireEvent.click(screen.getByText('Read 3 bill(s)'));

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
    extractAsync.mockClear();
    extractAsync.mockResolvedValueOnce({ bills: [
      readBill(0, { invoiceNumber: 'INV-1', totalSen: 100000 }, { id: 'sup-1', name: 'Foshan Chairs' }),
      readBill(1, { invoiceNumber: 'INV-2', totalSen: null }, { id: 'sup-1', name: 'Foshan Chairs' }),
      { index: 2, ok: false, reason: 'The reader answered with something other than JSON.' },
    ] });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    fireEvent.click(screen.getByText('Read 3 bill(s)'));

    /* Grouped by default — no per-bill buttons until the human splits. */
    await waitFor(() => expect(screen.getByText('Open as ONE voucher (2 lines)')).toBeTruthy());
    expect(screen.queryAllByText('Open as voucher')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Pay Foshan Chairs bills separately'));
    expect(screen.queryByText(/Open as ONE voucher/)).toBeNull();
    expect(screen.getAllByText('Open as voucher')).toHaveLength(2);

    /* The honest edges: a null total is flagged, a failed bill keeps its reason. */
    expect(screen.getByText('total unreadable — will need typing')).toBeTruthy();
    expect(screen.getByText(/Bill 3 could not be read: The reader answered/)).toBeTruthy();
    expect(screen.getByText(/1 bill\(s\) could not be read/)).toBeTruthy();

    /* A SPLIT bill stashes only ITS OWN file — never a sibling's. */
    fireEvent.click(screen.getAllByText('Open as voucher')[0]!);
    await waitFor(() => expect(screen.getByText('NEW PAGE')).toBeTruthy());
    expect(takePvFiles().map((f) => f.name)).toEqual(['a.pdf']);
  });
});

describe('扫 → bill (owner 2026-09-03: 他是扫 bill, 然后帮我录入 bill)', () => {
  test('a grouped pair opens as ONE bill — matched supplier, joined numbers, one line per bill', async () => {
    extractAsync.mockClear();
    piLandedState = null;
    extractAsync.mockResolvedValueOnce({ bills: [
      readBill(0, { invoiceNumber: 'ZJM-88', totalSen: 1644000 }, { id: 'sup-405', name: 'Zhejiang Ju Miao' }),
      readBill(1, { invoiceNumber: 'ZJM-89', totalSen: 100000 }, { id: 'sup-405', name: 'Zhejiang Ju Miao' }),
    ] });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    fireEvent.click(screen.getByText('Read 2 bill(s)'));

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
    extractAsync.mockClear();
    piLandedState = null;
    extractAsync.mockResolvedValueOnce({ bills: [
      readBill(0, { invoiceNumber: 'ZJM-90', totalSen: 50000 }, { id: 'sup-405', name: 'Zhejiang Ju Miao' }),
    ] });
    draw();
    fireEvent.change(screen.getByLabelText('Add bill files'), { target: { files: [pdf('c.pdf')] } });
    fireEvent.click(screen.getByText('Read 1 bill(s)'));

    await waitFor(() => expect(screen.getByText('Open as bill')).toBeTruthy());
    fireEvent.click(screen.getByText('Open as bill'));
    await waitFor(() => expect(screen.getByText('PI NEW PAGE')).toBeTruthy());
    const state = piLandedState as { scanBill: { supplierId: string | null; extraction: { invoiceNumber: string | null }; lines?: unknown } };
    expect(state.scanBill.supplierId).toBe('sup-405');
    expect(state.scanBill.extraction.invoiceNumber).toBe('ZJM-90');
    expect(state.scanBill.lines).toBeUndefined();
  });
});
