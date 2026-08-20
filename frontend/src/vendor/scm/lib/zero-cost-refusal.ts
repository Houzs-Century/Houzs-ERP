// ----------------------------------------------------------------------------
// zero-cost-refusal — the 409 `zero_cost_receipt` body, read ONCE.
//
// WHAT THE SERVER SENDS. `backend/src/scm/lib/zero-cost-receipt-guard.ts`
// refuses a receipt that would open a zero-cost stock layer for a SKU the system
// has already seen carry money, and the refusal CARRIES THE ANSWER: the
// offending lines (with each SKU's known cost) plus a `remedy` array naming the
// two ways out — enter the unit price from the supplier's goods-received
// document, or tick "Received free" on that line and say why.
//
// WHY IT IS A MODULE. `authed-fetch` parsed that body inline, composed the
// operator's sentence and threw the parse away. So the phone showed a correct,
// readable refusal naming two fixes and offered NEITHER of them — the mobile
// receipt screen had only "Post" and "Cancel", and the mobile convert wizard's
// own copy of the message told the receiver to "open the receipt on desktop".
// A receiver on the warehouse floor had to go find a PC. Parsing here lets the
// remedy UI read the SAME body the sentence was written from.
//
// The sentence itself is unchanged — `zeroCostRefusalText` is the composition
// that was inline in authed-fetch, moved, not rewritten.
//
// NOT A ONE-TAP WAIVER. This module exposes the lines and the remedy; it does
// not, and must not, grow a "waive everything" helper. The tick is per line and
// carries a reason because "everything on this receipt was free" is exactly the
// reflex the gate exists to prevent (docs/modules/grn.md §"How an operator
// clears the refusal").
// ----------------------------------------------------------------------------

export const ZERO_COST_RECEIPT_ERROR = 'zero_cost_receipt';

/** The fallback sentence, shown when the body cannot be parsed at all. It says
 *  only what is true without the body: which lines, and what they cost, are
 *  exactly what we then do not know. */
export const ZERO_COST_FALLBACK_MESSAGE =
  'These lines would receive stock at zero cost, but the item has been bought at a real price before.';

/** One receipt line the guard refused, as the 409 carries it. `id` is the
 *  `grn_items` row — the thing `PATCH /grns/:id/items/:itemId` addresses. */
export type ZeroCostRefusalLine = {
  id: string | null;
  itemCode: string;
  qtyAccepted: number;
  /** What this SKU is KNOWN to have cost before — the evidence that the zero is
   *  a missing price rather than a free unit. Shown, never written. */
  knownUnitCostSen: number;
};

export type ZeroCostRefusal = {
  /** The server's own sentence; null when it sent none. */
  message: string | null;
  /** The two ways out, in the operator's vocabulary, from the server. */
  remedy: string[];
  lines: ZeroCostRefusalLine[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse a raw response body into the refusal, or null when it is not one.
 *
 * Tolerates a preamble before the JSON (`text.indexOf('{')`), which is the
 * tolerance authed-fetch already had and some proxies still need.
 */
export function parseZeroCostRefusal(raw: string | null | undefined): ZeroCostRefusal | null {
  const text = raw ?? '';
  if (!text.includes(`"${ZERO_COST_RECEIPT_ERROR}"`)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(Math.max(0, text.indexOf('{'))));
  } catch {
    return null;
  }
  /* `unknown`, not a cast to an object type: JSON.parse('null') and
     JSON.parse('7') both succeed, and a cast that promises an object would make
     the property read below a runtime throw inside an error path. */
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Record<string, unknown>;
  if (body.error !== ZERO_COST_RECEIPT_ERROR) return null;
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  return {
    message: typeof body.message === 'string' ? body.message : null,
    remedy: Array.isArray(body.remedy) ? body.remedy.filter((r): r is string => typeof r === 'string') : [],
    lines: rawLines
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .map((l) => ({
        id: typeof l.id === 'string' ? l.id : null,
        itemCode: typeof l.itemCode === 'string' ? l.itemCode : '',
        qtyAccepted: num(l.qtyAccepted),
        knownUnitCostSen: num(l.knownUnitCostSen),
      })),
  };
}

/** Recover the refusal from an error thrown by `authedFetch` (which stashes the
 *  raw body on `err.body`). Any other error — including another 409 — is null. */
export function zeroCostRefusalFrom(err: unknown): ZeroCostRefusal | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: unknown; body?: unknown };
  if (e.status !== 409) return null;
  return typeof e.body === 'string' ? parseZeroCostRefusal(e.body) : null;
}

/**
 * The operator's sentence: WHICH lines, what each item normally costs, and both
 * ways out. Moved verbatim from authed-fetch so every surface says it the same.
 */
export function zeroCostRefusalText(refusal: ZeroCostRefusal | null): string {
  if (!refusal) return ZERO_COST_FALLBACK_MESSAGE;
  const lines = refusal.lines
    .map((l) => `• ${l.itemCode} x${l.qtyAccepted}\n   normally about RM${(l.knownUnitCostSen / 100).toFixed(2)} each`)
    .join('\n');
  const how = refusal.remedy.map((r) => `— ${r}`).join('\n');
  return [refusal.message ?? ZERO_COST_FALLBACK_MESSAGE, lines, how].filter(Boolean).join('\n\n');
}
