import type { SettlementRow } from './settlement-queries';

/** What the acquirer took for a report line: its own fee and its share of the
    report's statement charge (owner 2026-11-28: AEON's subvention fee, by gross). */
export const lineFeeSen = (r: Pick<SettlementRow, 'fee_sen' | 'charge_share_sen'>): number => Number(r.fee_sen) + Number(r.charge_share_sen ?? 0);

/** What the acquirer pays for a report line, after both. */
export const lineNetSen = (r: Pick<SettlementRow, 'net_sen' | 'charge_share_sen'>): number => Number(r.net_sen) - Number(r.charge_share_sen ?? 0);
