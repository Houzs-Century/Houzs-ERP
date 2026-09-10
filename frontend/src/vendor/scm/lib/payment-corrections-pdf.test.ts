/* The printed corrections report, decided without a PDF. Every line the
   document prints comes out of `correctionsDocument`, so what is pinned here
   is exactly what Finance reads on paper: the words the audit's field names
   become, how a delete reads, how the ledger pair reads with a half missing,
   and that an empty month prints a sentence rather than an empty table. */
import { describe, expect, it } from 'vitest';
import {
  correctionsDocument, ledgerText, monthText, whatChanged, type CorrectionRowInput,
} from './payment-corrections-pdf';

const row = (over: Partial<CorrectionRowInput> = {}): CorrectionRowInput => ({
  at: '2026-09-10T02:15:00Z', by: 'Chew', docNo: '2990-SO-2606-043', customer: 'Wong li way',
  kind: 'edited', changes: [{ field: 'amountSen', from: 199_000, to: 199_100 }],
  amountFromSen: 199_000, amountToSen: 199_100,
  reason: 'Sales keyed RM 1,990 — receipt shows RM 1,991',
  originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
  ...over,
});

const summary = { corrections: 1, edited: 1, deleted: 0, netMovedSen: 100, deletedSen: 0 };

describe('whatChanged', () => {
  it('names an amount change in money, from → to', () => {
    expect(whatChanged(row())).toBe('Amount RM 1,990.00 → RM 1,991.00');
  });

  it('names several changes in one line, in the words the screen uses', () => {
    expect(whatChanged(row({ changes: [
      { field: 'method', from: 'cash', to: 'transfer' },
      { field: 'merchantProvider', from: null, to: 'MBB' },
      { field: 'paidAt', from: '2026-09-01', to: '2026-09-04' },
    ] }))).toBe('Method cash → transfer; Bank — → MBB; Date 01/09/2026 → 04/09/2026');
  });

  it('a field it does not know still prints, by its raw name', () => {
    expect(whatChanged(row({ changes: [{ field: 'somethingNew', from: 1, to: 2 }] }))).toBe('somethingNew 1 → 2');
  });

  it('a delete says what was removed', () => {
    expect(whatChanged(row({ kind: 'deleted', amountFromSen: 50_000, amountToSen: null }))).toBe('Deleted — RM 500.00 removed');
    expect(whatChanged(row({ kind: 'deleted', amountFromSen: null }))).toBe('Deleted');
  });
});

/* Three numbers, in the order the books moved: the ORIGINAL, the contra that
   voided it, the entry booked in its place. The first version printed
   "0099 reversed → 0100", and 0099 was the contra — a reader took it for the
   entry that had been reversed (owner, 2026-09-10: 不明白). */
describe('ledgerText', () => {
  it('reads original → reversed by contra → new', () => {
    expect(ledgerText(row())).toBe('JE-2609-0031 → reversed by JE-2609-0057 → JE-2609-0058');
  });

  it('a delete stops at the reversal', () => {
    expect(ledgerText(row({ jeNo: null }))).toBe('JE-2609-0031 → reversed by JE-2609-0057');
  });

  it('a legacy row that knows only the contra says so, and never calls it the original', () => {
    expect(ledgerText(row({ originalJeNo: null }))).toBe('reversed by JE-2609-0057 → JE-2609-0058');
  });

  it('a first booking has only the new entry; nothing reads as a dash', () => {
    expect(ledgerText(row({ originalJeNo: null, contraJeNo: null }))).toBe('booked JE-2609-0058');
    expect(ledgerText(row({ originalJeNo: null, contraJeNo: null, jeNo: null }))).toBe('—');
  });
});

describe('correctionsDocument', () => {
  it('lays each correction out in the report\'s column order', () => {
    const doc = correctionsDocument({ month: '2026-09', rows: [row()], summary });
    expect(doc.title).toBe('PAYMENT CORRECTIONS');
    expect(doc.monthText).toBe('09/2026');
    expect(doc.lines).toEqual([[
      '10/09/2026\nChew',
      '2990-SO-2606-043\nWong li way',
      'Amount RM 1,990.00 → RM 1,991.00',
      'Sales keyed RM 1,990 — receipt shows RM 1,991',
      'JE-2609-0031 → reversed by JE-2609-0057 → JE-2609-0058',
    ]]);
    expect(doc.empty).toBeNull();
  });

  it('carries the three figures the screen shows, signed', () => {
    const doc = correctionsDocument({ month: '2026-09', rows: [row()], summary: { corrections: 4, edited: 3, deleted: 1, netMovedSen: -89_900, deletedSen: 50_000 } });
    expect(doc.summary).toEqual([
      { label: 'Corrections', value: '4' },
      { label: 'Edited / deleted', value: '3 / 1' },
      { label: 'Money received, net effect', value: '−RM 899.00' },
    ]);
  });

  it('a blank reason and a missing customer print as a dash and as nothing, not as "null"', () => {
    const doc = correctionsDocument({ month: '2026-09', rows: [row({ reason: '', customer: null })], summary });
    expect(doc.lines[0][1]).toBe('2990-SO-2606-043');
    expect(doc.lines[0][3]).toBe('—');
    expect(JSON.stringify(doc.lines)).not.toMatch(/null|undefined/);
  });

  it('an empty month prints a sentence naming the month, and no lines', () => {
    const doc = correctionsDocument({ month: '2026-07', rows: [], summary: { corrections: 0, edited: 0, deleted: 0, netMovedSen: 0, deletedSen: 0 } });
    expect(doc.lines).toEqual([]);
    expect(doc.empty).toMatch(/07\/2026/);
  });

  it('prints the month numerically, never as a name', () => {
    expect(monthText('2026-09')).toBe('09/2026');
    expect(monthText('garbage')).toBe('garbage');
  });
});
