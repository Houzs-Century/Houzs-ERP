/* A payment row that no longer says what its journal entry says.

   `PATCH /:docNo/payments/:id` updates the payment row and never touches the
   ledger — so an edited payment leaves the books behind it, silently. Today
   the one-day edit window (so-field-policy's `paymentRowMutable`) hides the
   consequence: almost nothing is editable long enough to drift. The owner has
   decided (2026-09-10, with management) that Finance should be able to correct
   a mis-keyed payment, which means that window is going to open. Before it
   does, the divergence has to be VISIBLE — this file is that first step, and
   it writes nothing.

   Pure on purpose: the route reads the two tables, this decides. What it can
   see is what the entry header carries — the money, the date, and the method
   the poster wrote into the narration. What it cannot see is the acquirer
   behind a merchant payment (that lives in the entry's LINES, as the transit
   account), so a changed `merchant_provider` is NOT reported here. */

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
  /** Always in the order amount → date → method, so two runs read alike. */
  fields: DriftField[];
  paymentAmountSen: number;
  entryAmountSen: number;
  paidOn: string;
  entryDate: string;
  paymentMethod: string;
  /** null when the narration is not the poster's shape — see below. */
  entryMethod: string | null;
};

/* The poster writes `Payment {method} on {docNo}[ — {customer}]`. Reading the
   method back out of it is how the entry's OWN idea of the method is
   recovered without opening its lines. Anything else — a reversal narration,
   an AutoCount import, a hand-written journal — returns null, and a null is
   never reported as a drift: the check must not invent a disagreement out of
   a sentence it does not recognise. */
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
    /* The poster skips imported rows outright, so an entry beside one was not
       written from this row and must not be measured against it. */
    if (p.method === 'imported') continue;

    const e = byPayment.get(keyOf(p.source, p.id));
    /* No active entry is the UNBOOKED check's finding, not this one. Reporting
       it here would show the owner the same payment twice under two names. */
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

  /* Oldest first, by the date the ENTRY carries — the payment's own date is
     one of the things under suspicion. Ties break on the id so the order is
     the same on every run. */
  out.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id.localeCompare(b.id));
  return out;
}
