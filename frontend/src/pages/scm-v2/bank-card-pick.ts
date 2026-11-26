// ----------------------------------------------------------------------------
// bank-card-pick — what the bar at the foot of Bank Recon says once card
// payments are ticked with a movement (owner 2026-11-17, on Houzs's transfer of
// RM 26,308.81 for 2990's swipes on its AEON terminal: 「我在bank recon时可以选
// 刷卡的transaction，然后差额就直接去terminal charges」). The difference is what the
// bank did not pay of the card payments; the server books it to the charges
// account and decides again on its own (backend acc/bank-card-match), so this is
// only the screen saying it first.
// ----------------------------------------------------------------------------

import type { BankCardPayment, BankLine } from './bank-queries';
import { fmt } from './settlement-ui';

export type CardPickState = {
  ok: boolean;
  differenceSen: number;
  pct: number;
  message: string;
};

const pctOf = (sen: number, of: number): number => (of > 0 ? Math.round((sen * 10000) / of) / 100 : 0);

export function cardPickState(p: {
  lines: readonly BankLine[];
  entriesSen: number;
  cards: readonly BankCardPayment[];
  maxChargePct: number;
  feeAccount: { code: string; name: string | null } | null;
  feeProblem: string | null;
}): CardPickState {
  const cardsSen = p.cards.reduce((s, c) => s + c.amountSen, 0);
  const lineSen = p.lines.reduce((s, l) => s + l.amount_sen, 0);
  const differenceSen = p.entriesSen + cardsSen - lineSen;
  const pct = pctOf(differenceSen, cardsSen);
  const no = (message: string): CardPickState => ({ ok: false, differenceSen, pct, message });
  if (p.lines.length !== 1) return no('Tick the one movement that paid these card payments in.');
  const line = p.lines[0]!;
  if (!(line.amount_sen > 0)) return no('Only money coming in can take card payments in.');
  if (line.kind === 'QR' || line.kind.startsWith('PAYOUT')) {
    return no('This is a merchant\'s own payout — it is booked against its report, not against card payments.');
  }
  if (!p.feeAccount) return no(p.feeProblem ?? 'There is no charges account for the difference.');
  if (differenceSen < 0) return no(`The bank received ${fmt(-differenceSen)} more than ticked — that is not a charge.`);
  if (differenceSen * 100 > p.maxChargePct * cardsSen) {
    return no(`${fmt(differenceSen)} is ${pct}% of the card payments — more than ${p.maxChargePct}% means a tick is wrong.`);
  }
  const account = `${p.feeAccount.code}${p.feeAccount.name ? ` ${p.feeAccount.name}` : ''}`;
  return {
    ok: true, differenceSen, pct,
    message: differenceSen === 0
      ? 'The totals agree — no charge.'
      : `${fmt(differenceSen)} (${pct}% of the card payments) goes to ${account}.`,
  };
}
