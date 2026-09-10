import { describe, it, expect } from 'vitest';
import { methodInNarration, paymentEntryDrift, type EntryFact, type PaymentFact } from './payment-drift';

const pay = (over: Partial<PaymentFact> = {}): PaymentFact => ({
  source: 'SOPAY',
  id: 'p1',
  docNo: 'HS-SO-2609-001',
  paidOn: '2026-09-01',
  amountSen: 150000,
  method: 'cash',
  ...over,
});

const entry = (over: Partial<EntryFact> = {}): EntryFact => ({
  source: 'SOPAY',
  sourceDocNo: 'p1',
  jeNo: 'JE-2609-0001',
  entryDate: '2026-09-01',
  totalDebitSen: 150000,
  narration: 'Payment cash on HS-SO-2609-001 — Ah Chong',
  ...over,
});

describe('methodInNarration', () => {
  it('reads the method the poster wrote', () => {
    expect(methodInNarration('Payment cash on HS-SO-2609-001 — Ah Chong')).toBe('cash');
    expect(methodInNarration('Payment merchant on HS-SO-2609-001')).toBe('merchant');
  });

  it('refuses to guess when the narration is not the poster\'s shape', () => {
    expect(methodInNarration('Reversal of JE-2609-0001 — payment deleted')).toBeNull();
    expect(methodInNarration('')).toBeNull();
    expect(methodInNarration('Opening balance')).toBeNull();
  });
});

describe('paymentEntryDrift', () => {
  it('says nothing when the row and its entry agree', () => {
    expect(paymentEntryDrift([pay()], [entry()])).toEqual([]);
  });

  it('names an amount that no longer matches its entry', () => {
    const rows = paymentEntryDrift([pay({ amountSen: 199000 })], [entry()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual(['amount']);
    expect(rows[0].paymentAmountSen).toBe(199000);
    expect(rows[0].entryAmountSen).toBe(150000);
    expect(rows[0].jeNo).toBe('JE-2609-0001');
  });

  it('names a date that no longer matches its entry', () => {
    const rows = paymentEntryDrift([pay({ paidOn: '2026-09-04' })], [entry()]);
    expect(rows[0].fields).toEqual(['date']);
    expect(rows[0].paidOn).toBe('2026-09-04');
    expect(rows[0].entryDate).toBe('2026-09-01');
  });

  it('names a method change, which moves the money to a different account', () => {
    const rows = paymentEntryDrift([pay({ method: 'merchant' })], [entry()]);
    expect(rows[0].fields).toEqual(['method']);
    expect(rows[0].paymentMethod).toBe('merchant');
    expect(rows[0].entryMethod).toBe('cash');
  });

  it('names every field that moved, in one row', () => {
    const rows = paymentEntryDrift(
      [pay({ amountSen: 199000, paidOn: '2026-09-04', method: 'merchant' })],
      [entry()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual(['amount', 'date', 'method']);
  });

  it('does not claim a method drift when it cannot read the entry\'s method', () => {
    const rows = paymentEntryDrift([pay({ method: 'merchant' })], [entry({ narration: 'Imported from AutoCount' })]);
    expect(rows).toEqual([]);
  });

  it('leaves a payment with no active entry alone — that is the unbooked check\'s row', () => {
    expect(paymentEntryDrift([pay()], [])).toEqual([]);
  });

  it('skips imported rows, the same three the poster skips', () => {
    expect(paymentEntryDrift([pay({ method: 'imported', amountSen: 1 })], [entry()])).toEqual([]);
  });

  it('treats a payment whose date has been erased as a date drift, not a crash', () => {
    const rows = paymentEntryDrift([pay({ paidOn: '' })], [entry()]);
    expect(rows[0].fields).toEqual(['date']);
    expect(rows[0].paidOn).toBe('');
  });

  it('reports the oldest first — the one that has been wrong longest', () => {
    const rows = paymentEntryDrift(
      [
        pay({ id: 'b', paidOn: '2026-09-08', amountSen: 1 }),
        pay({ id: 'a', paidOn: '2026-09-02', amountSen: 1 }),
      ],
      [entry({ sourceDocNo: 'b', jeNo: 'JE-2', entryDate: '2026-09-08' }), entry({ sourceDocNo: 'a', jeNo: 'JE-1', entryDate: '2026-09-02' })],
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps SO and SI payments apart even when their ids collide', () => {
    const rows = paymentEntryDrift(
      [pay({ source: 'SOPAY', amountSen: 1 }), pay({ source: 'SIPAY', amountSen: 150000 })],
      [entry()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('SOPAY');
  });
});
