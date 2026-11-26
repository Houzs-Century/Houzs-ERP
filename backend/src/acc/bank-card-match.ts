// ----------------------------------------------------------------------------
// bank-card-match — one bank credit taken against entries already on the bank
// AND card payments no merchant report carries; what the bank did not pay of
// those card payments is the charge.
//
// Owner, 2026-11-17, on 2990's Hong Leong credit of RM 26,308.81 (Houzs's
// HC-HPV-2611-052): eight customer transfers already on the bank, plus three of
// 2990's instalment sales swiped on Houzs's AEON terminal and paid back less
// AEON's MDR and subvention fee — 「我在bank recon时可以选刷卡的transaction，然后
// 差额就直接去terminal charges」, then 「照这样做」. No 2990 report will ever carry
// those swipes, so the bank movement takes them in itself:
//
//     Dr Bank                card payments less the charge
//     Dr Terminal charges    the charge
//         Cr Card clearing   each payment's gross, from the account its own
//                            receipt put it on
//
// The charge is the difference, and a difference is guarded: the bank paying
// MORE than was ticked is never a charge, and one past 10% of the card
// payments is a wrong tick, not a fee (AEON's MDR and subvention together
// reached 8.46% at most, 5.22% typically, over 98 of Houzs's AEON reports).
// Pure: which lines. acc/bank-card-settle writes them.
// ----------------------------------------------------------------------------

import type { RuleLine } from './rules';
import { fmtSen } from '../scm/shared/format';

/** The most a charge may be, as a percentage of the card payments ticked. */
export const MAX_CARD_CHARGE_PCT = 10;

export type CardForMatch = {
  source: 'SOPAY' | 'SIPAY';
  id: string;
  docNo: string | null;
  approvalCode: string | null;
  grossSen: number;
  clearingAccountCode: string;
};

export type EntryForMatch = { jeNo: string; sen: number };

export type CardMatchPlan = {
  ok: true;
  entriesSen: number;
  cardsSen: number;
  chargeSen: number;
  bankSen: number;
  chargePct: number;
  lines: RuleLine[];
};

export type CardMatchRefusal = { ok: false; status: string; message: string };

export const chargePctOf = (chargeSen: number, cardsSen: number): number =>
  cardsSen > 0 ? Math.round((chargeSen * 10000) / cardsSen) / 100 : 0;

export function planCardMatch(p: {
  lineSen: number;
  entries: readonly EntryForMatch[];
  cards: readonly CardForMatch[];
  bankAccountCode: string;
  feeAccountCode: string;
  bankRef: string | null;
}): CardMatchPlan | CardMatchRefusal {
  if (!(p.lineSen > 0)) {
    return { ok: false, status: 'not_a_credit', message: 'This movement takes money out of the account — only money coming in can take card payments in.' };
  }
  if (p.cards.length === 0) {
    return { ok: false, status: 'no_card_payments', message: 'Tick the card payments this money is for, or match it to its entries without them.' };
  }
  const bad = p.cards.find((c) => !(c.grossSen > 0));
  if (bad) return { ok: false, status: 'bad_amount', message: `${bad.docNo ?? bad.id} has no amount to take in.` };

  const entriesSen = p.entries.reduce((s, e) => s + e.sen, 0);
  const cardsSen = p.cards.reduce((s, c) => s + c.grossSen, 0);
  const chargeSen = entriesSen + cardsSen - p.lineSen;
  const ticked = `the entries ${fmtSen(entriesSen)} and the card payments ${fmtSen(cardsSen)}`;
  if (chargeSen < 0) {
    return {
      ok: false, status: 'bank_got_more',
      message: `The bank received ${fmtSen(p.lineSen)}, ${fmtSen(-chargeSen)} more than ${ticked}. A difference that way is not a charge — tick what the rest of this money is.`,
    };
  }
  const chargePct = chargePctOf(chargeSen, cardsSen);
  if (chargeSen * 100 > MAX_CARD_CHARGE_PCT * cardsSen) {
    return {
      ok: false, status: 'charge_too_big',
      message: `${fmtSen(chargeSen)} would go to charges — ${chargePct}% of the card payments ticked. A card charge is never more than ${MAX_CARD_CHARGE_PCT}%, so a tick is wrong: check the entries and card payments against ${fmtSen(p.lineSen)}.`,
    };
  }
  const bankSen = cardsSen - chargeSen;
  const lines: RuleLine[] = [
    { accountCode: p.bankAccountCode, debitSen: bankSen, creditSen: 0, notes: `Card payments taken in${p.bankRef ? ` — ${p.bankRef}` : ''}` },
  ];
  if (chargeSen > 0) {
    lines.push({
      accountCode: p.feeAccountCode, debitSen: chargeSen, creditSen: 0,
      notes: `Charges kept off ${p.cards.length} card payment${p.cards.length === 1 ? '' : 's'} (${chargePct}%)`,
    });
  }
  for (const c of p.cards) {
    lines.push({
      accountCode: c.clearingAccountCode, debitSen: 0, creditSen: c.grossSen,
      notes: [c.docNo ?? c.id, c.approvalCode ? `approval ${c.approvalCode}` : null].filter(Boolean).join(' · '),
    });
  }
  return { ok: true, entriesSen, cardsSen, chargeSen, bankSen, chargePct, lines };
}
