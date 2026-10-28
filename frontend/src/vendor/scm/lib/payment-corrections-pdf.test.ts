/* The printed corrections report, decided without a PDF. Every line the
   document prints comes out of `correctionsDocument`, so what is pinned here
   is exactly what Finance reads on paper: the words the audit's field names
   become, how a delete reads, how the ledger pair reads with a half missing,
   and that an empty month prints a sentence rather than an empty table. */
import { describe, expect, it } from 'vitest';
import {
  correctionsDocument, ledgerText, monthText, reasonText, recordedText, whatChanged, type CorrectionRowInput,
} from './payment-corrections-pdf';

const row = (over: Partial<CorrectionRowInput> = {}): CorrectionRowInput => ({
  at: '2026-09-10T02:15:00Z', by: 'Chew', docNo: '2990-SO-2606-043', customer: 'Wong li way',
  kind: 'edited', changes: [{ field: 'amountSen', from: 199_000, to: 199_100 }],
  amountFromSen: 199_000, amountToSen: 199_100,
  reason: 'Sales keyed RM 1,990 — receipt shows RM 1,991', beforeRule: false,
  recordedBy: 'Rachael', recordedOn: '2026-08-29T06:00:00Z',
  originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
  ...over,
});

const summary = { corrections: 1, added: 0, edited: 1, deleted: 0, proof: 0, netMovedSen: 100, addedSen: 0, deletedSen: 0 };

describe('whatChanged', () => {
  it('names an amount change in money, from → to', () => {
    expect(whatChanged(row())).toBe('Amount RM 1,990.00 → RM 1,991.00');
  });

  it('names several changes in one line, in the words the screen uses', () => {
    expect(whatChanged(row({ changes: [
      { field: 'method', from: 'cash', to: 'transfer' },
      { field: 'merchantProvider', from: null, to: 'MBB' },
      { field: 'paidAt', from: '2026-09-01', to: '2026-09-04' },
    ] }))).toBe('Method cash → transfer; Bank — → MBB; Date 2026/09/01 → 2026/09/04');
  });

  it('a field it does not know still prints, by its raw name', () => {
    expect(whatChanged(row({ changes: [{ field: 'somethingNew', from: 1, to: 2 }] }))).toBe('somethingNew 1 → 2');
  });

  it('a delete says what was removed', () => {
    expect(whatChanged(row({ kind: 'deleted', amountFromSen: 50_000, amountToSen: null }))).toBe('Deleted — RM 500.00 removed');
    expect(whatChanged(row({ kind: 'deleted', amountFromSen: null }))).toBe('Deleted');
  });

  /* docs/bugs/0888: an add says what was recorded, a proof says whether it
     was attached or replaced. */
  it('an add says what was recorded — the money, the method, the day', () => {
    expect(whatChanged(row({
      kind: 'added', amountFromSen: null, amountToSen: 150_000,
      changes: [{ field: 'paidAt', from: null, to: '2026-09-12' }, { field: 'method', from: null, to: 'cash' }, { field: 'amountSen', from: null, to: 150_000 }],
    }))).toBe('Added — RM 1,500.00 (cash on 2026/09/12)');
    expect(whatChanged(row({ kind: 'added', amountFromSen: null, amountToSen: 20_000, changes: [{ field: 'amountSen', from: null, to: 20_000 }] }))).toBe('Added — RM 200.00');
    expect(whatChanged(row({ kind: 'added', amountFromSen: null, amountToSen: null, changes: [] }))).toBe('Added');
  });

  it('a proof says whether it was attached or replaced', () => {
    expect(whatChanged(row({ kind: 'proof', changes: [{ field: 'slipKey', from: null, to: 'k2' }] }))).toBe('Proof attached');
    expect(whatChanged(row({ kind: 'proof', changes: [{ field: 'slipKey', from: 'k1', to: 'k2' }] }))).toBe('Proof replaced');
  });
});

/* Who first recorded the payment, and the day (owner 2026-09-14: 我就是要看原本
   是谁记录这一笔的) — and a dash, never a guess, when nothing could be read. */
describe('recordedText', () => {
  it('names the recorder and the day', () => {
    expect(recordedText(row())).toBe('Rachael\n2026/08/29');
  });

  it('a recorder with no day, or a day with no name, prints what it has', () => {
    expect(recordedText(row({ recordedOn: null }))).toBe('Rachael');
    expect(recordedText(row({ recordedBy: null }))).toBe('—\n2026/08/29');
  });

  it('nothing read prints a dash', () => {
    expect(recordedText(row({ recordedBy: null, recordedOn: null }))).toBe('—');
  });
});

describe('reasonText', () => {
  it('prints the reason, or that the row predates the rule, or a dash', () => {
    expect(reasonText(row())).toBe('Sales keyed RM 1,990 — receipt shows RM 1,991');
    expect(reasonText(row({ reason: '', beforeRule: true }))).toBe('Before the rule');
    expect(reasonText(row({ reason: '' }))).toBe('—');
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
      '2026/09/10\nChew',
      '2990-SO-2606-043\nWong li way',
      'Amount RM 1,990.00 -> RM 1,991.00',
      'Rachael\n2026/08/29',
      'Sales keyed RM 1,990 — receipt shows RM 1,991',
      'JE-2609-0031 -> reversed by JE-2609-0057 -> JE-2609-0058',
    ]]);
    expect(doc.empty).toBeNull();
  });

  it('carries the three figures the screen shows, signed', () => {
    const doc = correctionsDocument({ month: '2026-09', rows: [row()], summary: { corrections: 6, added: 1, edited: 3, deleted: 1, proof: 1, netMovedSen: -89_900, addedSen: 20_000, deletedSen: 50_000 } });
    expect(doc.summary).toEqual([
      { label: 'Payment actions', value: '6' },
      { label: 'Added / edited / deleted / proof', value: '1 / 3 / 1 / 1' },
      { label: 'Money received, net effect', value: '-RM 899.00' },
    ]);
  });

  /* The screen keeps → and −; on paper helvetica has neither and neither subset
     carries them, so the guard refused the whole report ("a character we cannot
     print yet") for any month with one edit. What the PDF gets is WinAnsi. */
  it('prints nothing helvetica cannot paint: the arrows and the minus are folded for paper', () => {
    const doc = correctionsDocument({ month: '2026-09', rows: [row(), row({ reason: 'Bank → cash, per receipt' })], summary: { ...summary, netMovedSen: -161_000 } });
    const printed = [...doc.summary.map((s) => s.value), ...doc.lines.flat()].join('\n');
    expect(printed).toContain('-RM 1,610.00');
    expect(printed).toContain('Bank -> cash, per receipt');
    const winAnsiAboveLatin1 = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026]);
    const outside = [...printed].filter((ch) => { const cp = ch.codePointAt(0) ?? 0; return cp > 0xff && !winAnsiAboveLatin1.has(cp); });
    expect(outside).toEqual([]);
  });

  it('a blank reason and a missing customer print as a dash and as nothing, not as "null"', () => {
    const doc = correctionsDocument({ month: '2026-09', rows: [row({ reason: '', customer: null, recordedBy: null, recordedOn: null })], summary });
    expect(doc.lines[0][1]).toBe('2990-SO-2606-043');
    expect(doc.lines[0][3]).toBe('—');
    expect(doc.lines[0][4]).toBe('—');
    expect(JSON.stringify(doc.lines)).not.toMatch(/null|undefined/);
  });

  it('an empty month prints a sentence naming the month, and no lines', () => {
    const doc = correctionsDocument({ month: '2026-07', rows: [], summary: { corrections: 0, added: 0, edited: 0, deleted: 0, proof: 0, netMovedSen: 0, addedSen: 0, deletedSen: 0 } });
    expect(doc.lines).toEqual([]);
    expect(doc.empty).toMatch(/07\/2026/);
  });

  it('prints the month numerically, never as a name', () => {
    expect(monthText('2026-09')).toBe('09/2026');
    expect(monthText('garbage')).toBe('garbage');
  });
});
