// ----------------------------------------------------------------------------
// qty-cap — the remaining-quantity cap that stands between a request and an
// over-receipt / over-invoice / over-return.
//
// THE RULE, already written in this repo by downstream-lock.ts:
//
//   A failed read must never read as an absence when the absence is what
//   authorises the write.
//
// WHAT THIS FIXES. The cap existed ten times, in five route files, in exactly
// this shape:
//
//     const { data: poItem } = await sb.from('purchase_order_items')
//       .select('qty, received_qty').eq('id', poItemId).maybeSingle();
//     if (poItem) {                                   // <- the whole cap lives in here
//       const remaining = qty - received_qty;
//       if (requested > remaining) return c.json({ error: 'qty_exceeds_remaining' }, 409);
//     }
//     ... insert the line ...
//
// supabase-js does not throw. A failed select resolves `{ data: null, error }`,
// the destructure drops the error, `poItem` is null, `if (poItem)` is false, and
// the ENTIRE cap is stepped over. The line is then written with no cap at all.
// Not a smaller cap, not a wrong cap — no cap. The three states
//
//     the query failed      the caller is not allowed      there is no such line
//
// all arrive as the third, and only the third one means "uncapped" was the right
// answer.
//
// WHAT IT COSTS. BUG-HISTORY 2026-07-17: "A blip on the payments read told the
// driver an already-paid order still owed the full total — and POD collected it
// again." Same shape, different table. Here the blip does not cost one
// collection; it lets a GRN receive more than the PO ordered, a PI invoice more
// than the GRN accepted, and a return send back more than was ever received —
// each of which then propagates into stock, into COGS, and into AutoCount.
//
// WHY REFUSING IS CHEAP HERE. Every one of the ten call sites is a PRE-write
// gate. Refusing costs the operator a retry and writes nothing. That is NOT true
// of the POST-insert compensating verifiers in grns.ts / purchase-invoices.ts,
// which run after the row is committed and whose refusal would delete a receipt
// the operator watched succeed; those are deliberately left best-effort and say
// so in their own comments. This module is only for the pre-write gates.
//
// ONE FORMULA COVERS ALL TEN. Every site computes
//
//     headroom = cap − Σ(already drawn) + (this line's own existing draw)
//
// The last term is 0 on an add (the line does not exist yet) and the line's
// stored qty on an edit (the stored rollup already counts it, so it is added
// back before comparing). See the table in qty-cap.test.ts.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';

/** The existing over-cap refusal, unchanged: every call site already returns
 *  this body with a 409 and the frontend already renders it. */
export const QTY_EXCEEDS_REMAINING = 'qty_exceeds_remaining';

/** The honest third state this guard was missing: not "within cap" and not
 *  "over cap", but "we could not find out". A 409 the operator can retry is the
 *  right answer to that — the same ruling downstream-lock.ts records for
 *  DOWNSTREAM_CHECK_FAILED. */
export const QTY_CAP_CHECK_FAILED = 'qty_cap_check_failed';

/** Over the cap. Carries the `remaining` the operator can act on. */
export type OverCapRefusal = { error: typeof QTY_EXCEEDS_REMAINING; requested: number; remaining: number };

/** The cap could not be read. Carries NO `remaining` — see qtyCapRefusal. */
export type CapCheckFailed = { error: typeof QTY_CAP_CHECK_FAILED; requested: number; message: string };

export type CapRefusal = OverCapRefusal | CapCheckFailed;

/**
 * The cap itself, with no database in it.
 *
 * `drawn` is everything already taken against `cap` by other documents AND by
 * this line's own stored value; `ownPriorDraw` gives this line's own share back
 * so an edit is compared against what it would become, not against itself twice.
 *
 * Pure, so the arithmetic can be tested without a router. Returns the narrower
 * OverCapRefusal, never CapCheckFailed: arithmetic that was handed numbers
 * cannot have failed to read them.
 */
export function capVerdict(input: {
  requested: number;
  cap: number;
  drawn: number;
  ownPriorDraw?: number;
}): OverCapRefusal | null {
  const remaining = input.cap - input.drawn + (input.ownPriorDraw ?? 0);
  if (input.requested > remaining) {
    return { error: QTY_EXCEEDS_REMAINING, requested: input.requested, remaining };
  }
  return null;
}

type Sb = SupabaseClient<any, any, any>;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Read the capping row and rule on the request.
 *
 * Returns:
 *   null              — within cap, or there is genuinely no such row (an
 *                       unlinked / manual line, which the call sites have always
 *                       treated as uncapped and still do).
 *   CapRefusal        — over the cap, OR the cap could not be read.
 *
 * The two failure bodies are DIFFERENT on purpose. `qty_exceeds_remaining`
 * carries a `remaining` the operator can act on; a check that could not run has
 * no such number and must not invent one, so it carries a sentence instead. A
 * guard that reports "remaining: 0" when it never looked is the same lie in a
 * quieter voice.
 */
export async function qtyCapRefusal(
  sb: Sb,
  args: {
    /** Table holding the capping row (PO line, PC-order line, GRN line, …). */
    table: string;
    /** id of that row. */
    id: string;
    /** Column carrying the cap (`qty`, `qty_accepted`, …). */
    capColumn: string;
    /** Columns already drawn against it (`received_qty`, `invoiced_qty`, …). */
    drawnColumns: string[];
    /** Quantity this request wants the line to carry. */
    requested: number;
    /** This line's own stored draw, added back on an edit. Omit on an add. */
    ownPriorDraw?: number;
    /** Human name of the capping row, for the check-failed sentence. */
    what: string;
  },
): Promise<CapRefusal | null> {
  const columns = [args.capColumn, ...args.drawnColumns].join(', ');
  const { data, error } = await sb
    .from(args.table)
    .select(columns)
    .eq('id', args.id)
    .maybeSingle();

  /* THE POINT OF THIS MODULE. Before this line existed the error was dropped,
     `data` was null, and the caller's `if (row)` stepped over the whole cap —
     so a five-second database blip was indistinguishable from "this line is
     unlinked, let it through uncapped". */
  if (error) {
    return {
      error: QTY_CAP_CHECK_FAILED,
      requested: args.requested,
      message:
        `Could not read the ${args.what} to check the remaining quantity, so this line is `
        + `refused rather than written past a cap nobody checked — try again (${error.message}).`,
    };
  }

  // No row: a manual / unlinked line. Uncapped, exactly as before.
  if (!data) return null;

  const row = data as unknown as Record<string, unknown>;
  const drawn = args.drawnColumns.reduce((s, col) => s + num(row[col]), 0);
  return capVerdict({
    requested: args.requested,
    cap: num(row[args.capColumn]),
    drawn,
    ownPriorDraw: args.ownPriorDraw,
  });
}
