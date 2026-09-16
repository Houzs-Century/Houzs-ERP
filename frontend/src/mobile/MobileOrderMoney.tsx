// ----------------------------------------------------------------------------
// MobileOrderMoney — the phone's share of money moved from a cancelled order
// (docs/bugs/0933; the desktop screens are docs/bugs/0931, the backend 0927).
//
// The rules live with the desktop: the vocabulary and the reads in
// vendor/scm/lib/so-money-queries.ts, the cancelled order's panel in
// vendor/scm/components/OrderMoneyPanel.tsx (mounted on the phone as it is —
// only "open the new order" is handed back to the screen router, since the
// phone has no URL to navigate to). What this file adds is the phone's own
// pieces: the method option and its pick in the two payment editors (the
// pre-create PayCard and the AddPaymentSheet), the body a converted row posts,
// and the one-shot seed the New SO screen opens with after Convert.
// ----------------------------------------------------------------------------

import {
  CONVERT_LABEL, CONVERTED_METHOD, useAddedConvertSources, useConvertSources, useOrdersWithMoney,
  type ConvertPick, type ConvertSource,
} from "../vendor/scm/lib/so-money-queries";
import { fmtSen } from "../vendor/shared/format";

/** What Convert on a cancelled order's panel hands the New SO screen: the
    order whose customer and lines are copied, and one converted row per pick. */
export type MobileConvertPrefill = { copyFrom: string; picks: ConvertPick[] };

type Opt = { value: string; label: string };

/** The method picker's extra option — offered only while the customer has a
    cancelled order with money (or the row already carries it), never a
    maintenance row: the catalog lists ways money arrives, this is money that
    was already here. */
export const withConvertOption = (opts: readonly Opt[], offer: boolean): Opt[] =>
  offer && !opts.some((o) => o.value === CONVERT_LABEL) ? [...opts, { value: CONVERT_LABEL, label: CONVERT_LABEL }] : [...opts];

/** The body a converted row posts — the server fixes the paid day and the
    collector from the cancelled order's own payment, so nothing else is sent. */
export const convertedBody = (convertedFromDocNo: string, amountSen: number): Record<string, unknown> =>
  ({ method: CONVERTED_METHOD, convertedFromDocNo: convertedFromDocNo || null, amountSen });

/** Sen → the RM string the phone's amount boxes hold ("1433.00"). */
export const rmInput = (sen: number): string => (sen / 100).toFixed(2);

/** The orders a row may draw on (cancelled, or live above their floor): a
    saved order asks the server by its number; the New SO screen, which has
    no order yet, asks by the customer's phone once enough of it is typed. */
export function useMobileConvertSources(p: { docNo?: string | null; phone?: string | null }): ConvertSource[] {
  const phone = (p.phone ?? "").trim();
  const saved = useConvertSources(p.docNo ?? null);
  const byPhone = useOrdersWithMoney(phone || null, !p.docNo && phone.length >= 6);
  return p.docNo ? saved.data?.sources ?? [] : byPhone.data?.orders ?? [];
}

/** The L2 pick under "Convert from another SO": which order the money comes
    from. Picking one hands back what it may give so an empty amount can be
    filled (desktop parity). A stored value the list no longer offers stays
    selectable, the same courtesy the Bank picker extends. */
export function ConvertSourceField({ sources: listed, value, onChange }: {
  sources: ConvertSource[];
  value: string;
  onChange: (docNo: string, remainingSen: number) => void;
}) {
  const picker = useAddedConvertSources(listed);
  const sources = picker.sources;
  const opts = value && !sources.some((s) => s.docNo === value) ? [{ docNo: value, remainingSen: 0, movableSen: 0, keepSen: 0 } as ConvertSource, ...sources] : sources;
  const addAnother = async () => { const src = await picker.add(); if (src) onChange(src.docNo, src.movableSen); };
  return (
    <div className="fld">
      <span className="fld-l">Order the money comes from</span>
      <select className="fld-i" value={value} aria-label="Cancelled order"
        onChange={(e) => { const s = opts.find((o) => o.docNo === e.target.value); onChange(e.target.value, s?.movableSen ?? 0); }}>
        <option value="">— Order the money comes from —</option>
        {opts.map((s) => <option key={s.docNo} value={s.docNo}>{s.docNo} · {fmtSen(s.movableSen)} {s.keepSen > 0 ? 'can move' : 'left'}</option>)}
      </select>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <input className="fld-i" value={picker.more} onChange={(e) => picker.setMore(e.target.value)} placeholder="Another order, e.g. 2990-SO-2607-024" aria-label="Another order"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addAnother(); } }} />
        <button type="button" className="btn" disabled={picker.busy} onClick={() => void addAnother()}>Add</button>
      </div>
      {picker.note && <div style={{ fontSize: 10.5, color: 'var(--c-danger, #a33)', marginTop: 3 }}>{picker.note}</div>}
      <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 3 }}>
        Money already paid on that order moves here — its paid date and collector stay as they were.
      </div>
    </div>
  );
}
