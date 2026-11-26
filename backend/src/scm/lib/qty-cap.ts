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
    table: string;
    id: string;
    capColumn: string;
    drawnColumns: string[];
    requested: number;
    ownPriorDraw?: number;
    extraDrawn?: number;
    what: string;
  },
): Promise<CapRefusal | null> {
  const columns = [args.capColumn, ...args.drawnColumns].join(', ');
  const { data, error } = await sb
    .from(args.table)
    .select(columns)
    .eq('id', args.id)
    .maybeSingle();

  if (error) {
    return {
      error: QTY_CAP_CHECK_FAILED,
      requested: args.requested,
      message:
        `Could not read the ${args.what} to check the remaining quantity, so this line is `
        + `refused rather than written past a cap nobody checked — try again (${error.message}).`,
    };
  }

  if (!data) return null;

  const row = data as unknown as Record<string, unknown>;
  const drawn = args.drawnColumns.reduce((s, col) => s + num(row[col]), 0) + (args.extraDrawn ?? 0);
  return capVerdict({
    requested: args.requested,
    cap: num(row[args.capColumn]),
    drawn,
    ownPriorDraw: args.ownPriorDraw,
  });
}

/** SQLSTATE raised by scm.assert_po_line_not_over_received (mig
 *  20261014T1400): the write would push a PO line's live received total up
 *  past its qty. Callers answer it with their existing 409, not a 500. */
export const PO_LINE_OVER_RECEIVED = 'P0411';
export const isPoLineOverReceived = (err: { code?: string | null } | null | undefined): boolean =>
  err?.code === PO_LINE_OVER_RECEIVED;
