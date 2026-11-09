// What this file pins — the bank's DuitNow QR credit (owner 2026-11-09:
// 这个hlbb merchant 的0000PP 是qr direct 去bank 的，不算卡机的). Hong Leong pays a
// day's QR money as one credit, "00005992284 MERCHAN T <day>", and that money is
// ALREADY in the books: each QR sale was keyed Online and booked straight to the
// bank. So the credit is matched to those sales' entries — the QR report says
// which — and never booked again as a card payout:
//   • the one QR report of the trading day whose lines make the credit is the answer;
//   • ready only when every line of it is linked to its sale, each sale has its
//     entry on THIS bank account, and no other bank line holds that entry;
//   • otherwise it says what is missing, and offers no button.

import { describe, it, expect } from 'vitest';
import { qrSalesFor, type BankRecognitionRule, type QrReportForMatch } from './bank-match';

const RULES: BankRecognitionRule[] = [
  { acquirerCode: 'HLB', pattern: 'CA Credit Advice', tradingDatePattern: 'MERCHAN\\s*T\\s+(\\d{8})', merchantPattern: '(\\d{9,})\\s+MERCHAN' },
];

/* 2990, 02/11: the 31/10 QR report paid as one credit of RM 5,500. */
const credit = (amountSen = 550000, day = '20261031') => ({
  amountSen, description: 'CA Credit Advice', reference: `00005992284 MERCHAN T ${day}`,
});

const report = (over: Partial<QrReportForMatch> = {}): QrReportForMatch => ({
  batchId: 384, fileName: '00005992284_20261031.CSV', acquirerCode: 'HLB', periodFrom: '2026-10-31', periodTo: '2026-10-31',
  lines: [
    { lineNo: 17, txnDate: '2026-10-31', grossSen: 350000, linked: true },
    { lineNo: 18, txnDate: '2026-10-31', grossSen: 200000, linked: true },
  ],
  sales: [
    { docNo: '2990-SO-2611-077', amountSen: 350000, jeNo: '2990-JE-2611-0500', accounts: ['310-0020'] },
    { docNo: '2990-SO-2611-019', amountSen: 200000, jeNo: '2990-JE-2610-0448', accounts: ['310-0020'] },
  ],
  ...over,
});

describe('qrSalesFor', () => {
  it("names the day's QR sales and is ready when every one is linked and booked to this bank", () => {
    const qr = qrSalesFor(credit(), RULES, [report()], new Set(), '310-0020');
    expect(qr).toMatchObject({ batchId: 384, ready: true, jeNos: ['2990-JE-2611-0500', '2990-JE-2610-0448'] });
    expect(qr!.clue).toMatch(/QR/);
    expect(qr!.clue).toMatch(/2990-SO-2611-019/);
  });

  it('a QR line with no sale linked yet: named, and not ready', () => {
    const qr = qrSalesFor(credit(), RULES, [report({
      lines: [{ lineNo: 17, txnDate: '2026-10-31', grossSen: 350000, linked: false }, { lineNo: 18, txnDate: '2026-10-31', grossSen: 200000, linked: true }],
      sales: [{ docNo: '2990-SO-2611-019', amountSen: 200000, jeNo: '2990-JE-2610-0448', accounts: ['310-0020'] }],
    })], new Set(), '310-0020');
    expect(qr).toMatchObject({ ready: false, waiting: [{ lineNo: 17, grossSen: 350000 }] });
    expect(qr!.clue).toMatch(/Merchant Recon/);
  });

  it('an entry another bank line already holds: named, and not ready', () => {
    const qr = qrSalesFor(credit(), RULES, [report()], new Set(['2990-JE-2610-0448']), '310-0020');
    expect(qr).toMatchObject({ ready: false });
    expect(qr!.clue).toMatch(/2990-SO-2611-019/);
    expect(qr!.clue).toMatch(/another bank line/);
  });

  it('a sale booked to another bank account: named, and not ready', () => {
    const qr = qrSalesFor(credit(), RULES, [report({
      sales: [
        { docNo: '2990-SO-2611-077', amountSen: 350000, jeNo: '2990-JE-2611-0500', accounts: ['310-0010'] },
        { docNo: '2990-SO-2611-019', amountSen: 200000, jeNo: '2990-JE-2610-0448', accounts: ['310-0020'] },
      ],
    })], new Set(), '310-0020');
    expect(qr).toMatchObject({ ready: false });
    expect(qr!.clue).toMatch(/310-0010/);
  });

  it('a sale with no entry in the books: not ready', () => {
    const qr = qrSalesFor(credit(), RULES, [report({
      sales: [
        { docNo: '2990-SO-2611-077', amountSen: 350000, jeNo: null, accounts: [] },
        { docNo: '2990-SO-2611-019', amountSen: 200000, jeNo: '2990-JE-2610-0448', accounts: ['310-0020'] },
      ],
    })], new Set(), '310-0020');
    expect(qr).toMatchObject({ ready: false });
  });

  it('a credit no QR report of the day makes is not QR money', () => {
    expect(qrSalesFor(credit(357486, '20261101'), RULES, [report()], new Set(), '310-0020')).toBeNull();
    expect(qrSalesFor(credit(550000, '20261101'), RULES, [report()], new Set(), '310-0020')).toBeNull();
  });

  it('two QR reports of the day for the same amount: a question, not an answer', () => {
    expect(qrSalesFor(credit(), RULES, [report(), report({ batchId: 999, fileName: 'other.CSV' })], new Set(), '310-0020')).toBeNull();
  });

  it('money out, or a credit no rule recognises, is never QR money', () => {
    expect(qrSalesFor({ ...credit(), amountSen: -550000 }, RULES, [report()], new Set(), '310-0020')).toBeNull();
    expect(qrSalesFor({ amountSen: 550000, description: 'Instant Transfer', reference: 'MIA ONN' }, RULES, [report()], new Set(), '310-0020')).toBeNull();
  });
});
