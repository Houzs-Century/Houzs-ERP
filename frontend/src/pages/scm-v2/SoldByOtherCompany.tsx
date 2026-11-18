// ----------------------------------------------------------------------------
// SoldByOtherCompany — a Merchant Recon line that is another company's sale.
//
// Owner 2026-11-17: 2990's AEON instalment sales are swiped on Houzs's AEON
// terminal, so on Houzs's report they have no Houzs sale behind them —
// 「houzs 那边的报表要确定这些和refund给2990 contra 掉」. The button books the line
// onto the account kept for that company (350-0070 for 2990): its gross, less
// the acquirer's fee and the line's share of the statement charge, is what is
// owed to them, and the voucher paying them back clears it. Undo is the line's
// ordinary Undo.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useOtherCompanies, useSoldBy, type OtherCompany, type SettlementRow } from './settlement-queries';
import { bankFollowsText } from './bank-follows';
import { btn, danger, fmt, good, refusalText } from './settlement-ui';

/** 「2990 的单」 — the owner's own words for such a line. */
export const soldByWords = (code: string): string => `${code}'s order`;

/** Whether a line can still be booked as another company's sale: an open card
    sale that holds no sale of this company. */
export const canBeSoldBy = (row: SettlementRow): boolean =>
  !row.confirmed_at && row.channel !== 'QR' && row.bucket !== 'IGNORED' && row.linked.length === 0 && row.gross_sen > 0;

/** One button per company this one keeps an account for, and the question each asks. */
export const SoldByButtons = ({ row }: { row: SettlementRow }) => {
  const companies = useOtherCompanies();
  const [asking, setAsking] = useState<OtherCompany | null>(null);
  if (!canBeSoldBy(row)) return null;
  const usable = (companies.data?.companies ?? []).filter((co) => co.usable);
  return (
    <>
      {usable.map((co) => (
        <button key={co.companyId} type="button" style={btn()} aria-expanded={asking?.companyId === co.companyId}
          title={`This swipe is ${co.name}'s sale, made on this terminal: book it as owed to ${co.name} on ${co.accountCode}`}
          onClick={() => setAsking(asking?.companyId === co.companyId ? null : co)}>
          {soldByWords(co.code)}
        </button>
      ))}
      {asking && <SoldByConfirm row={row} company={asking} onCancel={() => setAsking(null)} />}
    </>
  );
};

const SoldByConfirm = ({ row, company, onCancel }: { row: SettlementRow; company: OtherCompany; onCancel: () => void }) => {
  const sold = useSoldBy();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = sold.data;
  const press = () => {
    setError(null);
    sold.mutate(
      { rowId: row.id, companyId: company.companyId, note: note.trim() || null },
      { onError: (e) => setError(refusalText(e, 'The line was not booked.')) },
    );
  };
  return (
    /* Its own row under the buttons it opened from. */
    <div style={{ flexBasis: '100%' }} className="space-y-1" data-testid="sold-by-confirm">
      {done ? (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Booked {done.jeNo}: {fmt(done.owedSen)} owed to {company.code} on {done.accountCode}.
          {bankFollowsText(done.bank) ? ` ${bankFollowsText(done.bank)}` : ''}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 'var(--fs-13)' }}>
            Book this line as <b>{company.name}</b>&rsquo;s sale? Its {fmt(row.gross_sen)}, less the {fmt(row.fee_sen)} fee and its
            share of the report&rsquo;s statement charge, goes to <b>{company.accountCode}</b>
            {company.accountName ? ` ${company.accountName}` : ''} as owed to {company.code}. The voucher paying {company.code} back clears it.
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)}
              placeholder={`${company.code}'s order, e.g. ${company.code}-SO-…`} aria-label={`${company.code}'s order`}
              style={{ minWidth: 220 }} />
            <button type="button" style={btn(true, sold.isPending)} disabled={sold.isPending} onClick={press}>
              {sold.isPending ? 'Booking…' : `Book as ${soldByWords(company.code)}`}
            </button>
            <button type="button" style={btn()} onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}
      {error && <div role="alert" style={{ fontSize: 'var(--fs-13)', color: danger }}>{error}</div>}
    </div>
  );
};

/** The order typed when the line was booked ("Sold by 2990: 2990-SO-2611-017" → the order), or null. */
export const soldByNoteOf = (notes: string | null): string | null => /^Sold by [^:]+: (.+)$/.exec(notes ?? '')?.[1] ?? null;

/** What a line booked as another company's sale shows where a sale would be. */
export const SoldByTag = ({ companyId }: { companyId: number }) => {
  const companies = useOtherCompanies();
  const co = (companies.data?.companies ?? []).find((c) => c.companyId === companyId);
  return (
    <span title={co ? `${co.name}'s sale, owed to it on ${co.accountCode}` : undefined}>
      {soldByWords(co?.code ?? String(companyId))}
    </span>
  );
};
