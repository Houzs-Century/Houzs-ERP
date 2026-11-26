// The ticks behind "These are that entry" (owner 2026-11-10, 2990 October: 这个情况不应该出现啊).
// He had ticked the GHL payout (movement 1197), it was then matched and left the list,
// but its tick stayed: unseen, not in the bar's totals, and still sent — so ticking
// U Mobile's RM 72.10 and its PV, totals agreeing, was refused with "Movement 1197 is
// already posted. Undo it first", and the red line stayed under the next pair he ticked.
// Pinned: only what is still on the screen is ticked, counted and sent; a movement or
// entry that comes back (an undo) comes back unticked; a refusal speaks only for the
// ticks it was sent with.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BankCardPayment, BankLine, LedgerEntry } from './bank-queries';

const groupMutate = vi.fn();
const cardsMutate = vi.fn();
let groupState: { isError: boolean; error: unknown } = { isError: false, error: null };
vi.mock('./bank-queries', () => ({
  useMatchBankGroup: () => ({ mutate: groupMutate, isPending: false, ...groupState }),
  useMatchWithCards: () => ({ mutate: cardsMutate, isPending: false, isError: false, error: null }),
  cardPaymentKey: (p: { source: string; id: string }) => `${p.source}:${p.id}`,
}));

import { ReconcilePickProvider, useReconcilePick } from './bank-reconcile-pick';
import { EntryDocument } from './bank-entry-doc';
import { rememberReturnPicks } from '../../lib/returnScroll';

afterEach(() => {
  groupMutate.mockReset();
  cardsMutate.mockReset();
  groupState = { isError: false, error: null };
  sessionStorage.clear();
});

const line = (id: number, amountSen: number, description: string): BankLine => ({
  id, line_no: id, booked_on: '2026-10-27', description, reference: null, amount_sen: amountSen, charge_sen: 0,
  kind: 'OTHER', acquirer_code: null, trading_date: null, merchant_no: null, matched_batch_id: null, split: null,
  state: 'OPEN', posted_je_no: null, note: null, matches: [], candidates: [], entryCandidates: [],
});
const entry = (jeNo: string, creditSen: number): LedgerEntry => ({
  jeNo, entryDate: '2026-10-16', sourceType: 'PV', sourceDocNo: '2990-HPV-2610-021', debitSen: 0, creditSen,
});

const GHL = line(1197, 277662, 'GHL CARD PAYOUT');
const UMOBILE = line(1192, -7210, 'U MOBILE');
const PV021 = entry('2990-JE-2610-0354', 7210);

const Ticks = ({ lines, entries }: { lines: BankLine[]; entries: LedgerEntry[] }) => {
  const pick = useReconcilePick();
  return (
    <div>
      {lines.map((l) => (
        <input key={l.id} type="checkbox" aria-label={`Pick ${l.description}`} checked={pick.pickedLines.includes(l.id)} onChange={() => pick.toggleLine(l.id)} />
      ))}
      {entries.map((e) => (
        <input key={e.jeNo} type="checkbox" aria-label={`Pick ${e.jeNo}`} checked={pick.pickedEntries.includes(e.jeNo)} onChange={() => pick.toggleEntry(e.jeNo)} />
      ))}
    </div>
  );
};
const Month = ({ lines, entries }: { lines: BankLine[]; entries: LedgerEntry[] }) => (
  <ReconcilePickProvider lines={lines} entries={entries}>
    <Ticks lines={lines} entries={entries} />
  </ReconcilePickProvider>
);

const bar = () => screen.queryByRole('region', { name: 'Match the ticked movements and entries' });
const tick = (name: string) => fireEvent.click(screen.getByLabelText(`Pick ${name}`));
const go = () => screen.getByRole('button', { name: /These are that entry/ }) as HTMLButtonElement;

describe('a tick whose row has left the list', () => {
  test('is neither counted nor sent: only what is still on the screen is matched', () => {
    const { rerender } = render(<Month lines={[GHL, UMOBILE]} entries={[PV021]} />);
    tick('GHL CARD PAYOUT');
    rerender(<Month lines={[UMOBILE]} entries={[PV021]} />);
    expect(bar()).toBeNull();
    tick('U MOBILE');
    tick('2990-JE-2610-0354');
    expect(bar()!.textContent).toContain('1 movement');
    expect(bar()!.textContent).toContain('The totals agree.');
    fireEvent.click(go());
    expect(groupMutate.mock.calls[0]?.[0]).toEqual({ lineIds: [1192], jeNos: ['2990-JE-2610-0354'] });
  });

  test('comes back unticked when its row comes back (an undo), movement or entry', () => {
    const { rerender } = render(<Month lines={[GHL, UMOBILE]} entries={[PV021]} />);
    tick('GHL CARD PAYOUT');
    tick('2990-JE-2610-0354');
    rerender(<Month lines={[UMOBILE]} entries={[]} />);
    rerender(<Month lines={[GHL, UMOBILE]} entries={[PV021]} />);
    expect((screen.getByLabelText('Pick GHL CARD PAYOUT') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Pick 2990-JE-2610-0354') as HTMLInputElement).checked).toBe(false);
    expect(bar()).toBeNull();
  });
});

describe('a refusal', () => {
  test('speaks for the ticks it was sent with, and goes once they change', () => {
    groupState = { isError: true, error: new Error('Movement 1192 is already posted. Undo it first.') };
    render(<Month lines={[UMOBILE]} entries={[PV021]} />);
    tick('U MOBILE');
    tick('2990-JE-2610-0354');
    expect(screen.queryByText(/already posted/)).toBeNull();
    fireEvent.click(go());
    expect(screen.getByText('Movement 1192 is already posted. Undo it first.')).toBeTruthy();
    tick('2990-JE-2610-0354');
    expect(screen.queryByText(/already posted/)).toBeNull();
  });
});

/* Owner 2026-11-10: 我希望这里也可以点开so, 点开后也可以返回这里. Opening an order leaves the
   page, and the ticks lived only on it; they are noted as the order opens and given back
   once, when the page comes back at the same address. */
describe('the ticks, across a trip to an order and back', () => {
  const BANK = '/scm/bank-recon?account=310-0020&month=2026-10&tab=not-on-bank';
  const Trip = ({ ready = true, lines = [UMOBILE], entries = [PV021] }: { ready?: boolean; lines?: BankLine[]; entries?: LedgerEntry[] }) => (
    <MemoryRouter>
      <ReconcilePickProvider lines={lines} entries={entries} ready={ready}>
        <Ticks lines={lines} entries={entries} />
        <EntryDocument text="2990-DraftOR-2610-019 · 2990-SO-2609-016" />
      </ReconcilePickProvider>
    </MemoryRouter>
  );
  const isTicked = (name: string) => (screen.getByLabelText(`Pick ${name}`) as HTMLInputElement).checked;

  test('come back as they were; the next visit starts clean', () => {
    window.history.replaceState(null, '', BANK);
    const away = render(<Trip />);
    tick('U MOBILE');
    tick('2990-JE-2610-0354');
    fireEvent.click(screen.getByRole('link', { name: '2990-SO-2609-016' }));
    away.unmount();
    const back = render(<Trip />);
    expect(isTicked('U MOBILE')).toBe(true);
    expect(isTicked('2990-JE-2610-0354')).toBe(true);
    expect(bar()!.textContent).toContain('The totals agree.');
    back.unmount();
    render(<Trip />);
    expect(isTicked('U MOBILE')).toBe(false);
    expect(bar()).toBeNull();
  });

  test('a page still loading keeps them until its lists arrive', () => {
    window.history.replaceState(null, '', BANK);
    rememberReturnPicks({ lines: [1192], entries: ['2990-JE-2610-0354'] });
    const { rerender } = render(<Trip ready={false} lines={[]} entries={[]} />);
    rerender(<Trip />);
    expect(isTicked('U MOBILE')).toBe(true);
    expect(isTicked('2990-JE-2610-0354')).toBe(true);
  });
});

/* Owner 2026-11-17, 2990 Hong Leong 13/11: Houzs's RM 26,308.81 is eight transfers
   already on the bank and three of 2990's swipes on Houzs's AEON terminal, paid back
   less AEON's charges — 「差额就直接去terminal charges」. */
describe('card payments ticked with the movement', () => {
  const HOUZS = line(1633, 2630881, 'HOUZS CENTURY SDN. BHD. REFUND TO 2990 HC-HPV-2611-052');
  const TRANSFERS = entry('2990-JE-2610-0093', 0);
  const transfers = { ...TRANSFERS, debitSen: 1537100, creditSen: 0 };
  const card = (id: string, docNo: string, amountSen: number): BankCardPayment => ({
    source: 'SOPAY', id, docNo, paidOn: '2026-11-05', amountSen, approvalCode: null, customerName: null, acquirerCode: null, merchantProvider: null, ageDays: 12,
  });
  const SWIPES = [card('p028', '2990-SO-2611-028', 399000), card('p017', '2990-SO-2611-017', 399000), card('p081', '2990-SO-2611-081', 350000)];
  const SETUP = { feeAccount: { code: '900-T009', name: 'TERMINAL INTEREST CHARGES' }, feeProblem: null, maxChargePct: 10 };

  const Cards = () => {
    const pick = useReconcilePick();
    return (
      <div>
        {SWIPES.map((c) => (
          <input key={c.id} type="checkbox" aria-label={`Pick ${c.docNo}`} checked={pick.pickedCards.includes(`SOPAY:${c.id}`)} onChange={() => pick.toggleCard(`SOPAY:${c.id}`)} />
        ))}
      </div>
    );
  };
  const MonthWithCards = ({ lines }: { lines: BankLine[] }) => (
    <ReconcilePickProvider lines={lines} entries={[transfers]} cards={SWIPES} cardSetup={SETUP}>
      <Ticks lines={lines} entries={[transfers]} />
      <Cards />
    </ReconcilePickProvider>
  );

  test('names the difference and where it goes, and sends the movement, entries and card payments', () => {
    render(<MonthWithCards lines={[HOUZS]} />);
    tick('HOUZS CENTURY SDN. BHD. REFUND TO 2990 HC-HPV-2611-052');
    tick('2990-JE-2610-0093');
    for (const c of SWIPES) tick(c.docNo);
    expect(bar()!.textContent).toContain('3 card payments · RM 11,480.00');
    expect(bar()!.textContent).toContain('RM 542.19 (4.72% of the card payments) goes to 900-T009 TERMINAL INTEREST CHARGES.');
    fireEvent.click(screen.getByRole('button', { name: /Match, difference to charges/ }));
    expect(cardsMutate.mock.calls[0]?.[0]).toEqual({
      lineId: 1633, jeNos: ['2990-JE-2610-0093'],
      cardPayments: [{ source: 'SOPAY', id: 'p028' }, { source: 'SOPAY', id: 'p017' }, { source: 'SOPAY', id: 'p081' }],
    });
    expect(groupMutate).not.toHaveBeenCalled();
  });

  test('a difference past the cap, or the bank paying more, cannot be pressed', () => {
    render(<MonthWithCards lines={[HOUZS]} />);
    tick('HOUZS CENTURY SDN. BHD. REFUND TO 2990 HC-HPV-2611-052');
    tick('2990-SO-2611-028');
    expect(bar()!.textContent).toContain('more than ticked');
    expect((screen.getByRole('button', { name: /Match, difference to charges/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a merchant's payout is not offered card payments", () => {
    render(<MonthWithCards lines={[{ ...HOUZS, kind: 'PAYOUT' }]} />);
    tick('HOUZS CENTURY SDN. BHD. REFUND TO 2990 HC-HPV-2611-052');
    tick('2990-SO-2611-028');
    expect(bar()!.textContent).toContain('booked against its report');
  });
});
