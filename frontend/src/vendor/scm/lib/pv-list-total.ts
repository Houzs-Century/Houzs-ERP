// ----------------------------------------------------------------------------
// pv-list-total: the Payment vouchers list's Total (owner 2026-11-09: 「表格最下面的
// 总数（Total）- payment voucher 可以加」). The ringgit of the vouchers showing: a
// voucher in another currency at its own rate, the conversion posting and Money
// today use, and a cancelled voucher listed but not counted. The footer under the
// list and the list on paper (pv-list-pdf.ts) both total with this.
// ----------------------------------------------------------------------------

/** What a voucher's total needs from its row. */
export type PvMoneyRow = {
  status?: string | null;
  currency?: string | null;
  total_sen?: number | string | null;
  exchange_rate?: number | string | null;
};

/** The ringgit a voucher pays: round(total_sen × exchange_rate); a rate that cannot be read counts as one. */
export const ringgitSenOfPv = (r: PvMoneyRow): number => {
  const raw = Number(r.exchange_rate ?? 1);
  const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.round(Number(r.total_sen ?? 0) * rate);
};

export const isForeignPv = (r: PvMoneyRow): boolean => (r.currency ?? 'MYR').toUpperCase() !== 'MYR';
export const isCancelledPv = (r: PvMoneyRow): boolean => r.status === 'CANCELLED';

/** The total of the vouchers showing, and what it left out (cancelled) or converted (foreign). */
export function pvListTotal(rows: readonly PvMoneyRow[]): { sen: number; cancelled: number; foreign: number } {
  let sen = 0;
  let cancelled = 0;
  let foreign = 0;
  for (const r of rows) {
    if (isCancelledPv(r)) { cancelled += 1; continue; }
    if (isForeignPv(r)) foreign += 1;
    sen += ringgitSenOfPv(r);
  }
  return { sen, cancelled, foreign };
}

/** The footer's words beside the total; empty when it left nothing out and converted nothing. */
export function pvListTotalNote(t: { cancelled: number; foreign: number }): string {
  const words = [
    t.cancelled > 0 ? `${t.cancelled} cancelled not counted` : '',
    t.foreign > 0 ? 'foreign at its own rate' : '',
  ].filter(Boolean).join(' · ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
