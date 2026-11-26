
export type PaymentSource = 'SOPAY' | 'SIPAY';

/** A payment as its own table holds it. `paidOn` is '' when the row has no
    usable date — an entry over a dateless row is itself a disagreement. */
export type PaymentFact = {
  source: PaymentSource;
  id: string;
  docNo: string;
  paidOn: string;
  amountSen: number;
  method: string;
};

/** The ACTIVE entry that claims to explain that payment. `sourceDocNo` is the
    payment id — that is what the poster keys entries by. */
export type EntryFact = {
  source: PaymentSource;
  sourceDocNo: string;
  jeNo: string;
  entryDate: string;
  totalDebitSen: number;
  narration: string;
};

export type DriftField = 'amount' | 'date' | 'method';

export type PaymentDrift = {
  source: PaymentSource;
  id: string;
  docNo: string;
  jeNo: string;
  fields: DriftField[];
  paymentAmountSen: number;
  entryAmountSen: number;
  paidOn: string;
  entryDate: string;
  paymentMethod: string;
  entryMethod: string | null;
};

const POSTER_NARRATION = /^Payment ([a-z_]+) on \S/;

export function methodInNarration(narration: string): string | null {
  const m = POSTER_NARRATION.exec(String(narration).trim());
  return m ? m[1] : null;
}

const keyOf = (source: PaymentSource, id: string) => `${source}:${id}`;

export function paymentEntryDrift(payments: PaymentFact[], entries: EntryFact[]): PaymentDrift[] {
  const byPayment = new Map<string, EntryFact>();
  for (const e of entries) byPayment.set(keyOf(e.source, e.sourceDocNo), e);

  const out: PaymentDrift[] = [];
  for (const p of payments) {
    if (p.method === 'imported') continue;
    /* A converted row (docs/bugs/0927) keeps the original paid_at while its
       transfer is dated the day of the move — the difference is by design. */
    if (p.method === 'converted') continue;

    const e = byPayment.get(keyOf(p.source, p.id));
    if (!e) continue;

    const entryMethod = methodInNarration(e.narration);
    const fields: DriftField[] = [];
    if (p.amountSen !== e.totalDebitSen) fields.push('amount');
    if (p.paidOn !== e.entryDate) fields.push('date');
    if (entryMethod !== null && entryMethod !== p.method) fields.push('method');
    if (fields.length === 0) continue;

    out.push({
      source: p.source,
      id: p.id,
      docNo: p.docNo,
      jeNo: e.jeNo,
      fields,
      paymentAmountSen: p.amountSen,
      entryAmountSen: e.totalDebitSen,
      paidOn: p.paidOn,
      entryDate: e.entryDate,
      paymentMethod: p.method,
      entryMethod,
    });
  }

  out.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id.localeCompare(b.id));
  return out;
}
