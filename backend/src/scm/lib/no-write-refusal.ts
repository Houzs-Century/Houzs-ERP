/* Answering a refusal that left NOTHING behind, so the operator can correct it
   and press Save again.
 *
 * THE DEAD END THIS EXISTS TO CLOSE (staff, Goods Receipt from a PO,
 * 2026-08-17):
 *
 *   submit 1 -> 409 zero_cost_receipt   (a correct guard: lines carried a 0
 *               unit price on an item bought at a real price before)
 *   operator types the price the guard asked for, submits again
 *   submit 2 -> 409 idempotency_key_reused
 *
 * The form sends ONE Idempotency-Key per mount. The refused submit CLAIMED that
 * key against its own payload hash, so the corrected payload no longer matched
 * and the middleware refused it — and the only way out was a page reload, which
 * threw away the whole receipt. A guard whose entire remedy is "fix this and
 * retry" had made retrying impossible.
 *
 * THE FIX HAS TO BE HERE, ON THE SERVER. The client cannot make this call: the
 * middleware answers `idempotency_key_reused` on a hash mismatch ALONE, so that
 * code is also what a caller gets after a COMMITTED 201, and a client that
 * rotated its key on it would book a second document. Only the route knows
 * whether it wrote, so only the route may release the claim
 * (`markIdempotencyNoWrite`, which makes the middleware DELETE the row). The
 * middleware deliberately refuses to infer it from a 4xx status: several legacy
 * routes here return a 4xx AFTER one or more non-transactional writes.
 *
 * THE PRECONDITION, WHICH IS THE WHOLE CONTRACT. Call this only where the
 * handler has written nothing at all under this request — no insert, update,
 * upsert, delete, rpc, audit row, outbox enqueue or R2 object — or has fully
 * rolled back what it wrote before answering. Where that is not certain, use
 * plain `c.json(...)`: keeping the claim costs the operator a retype, and
 * releasing one wrongly costs a duplicate document. Those are not comparable.
 *
 * `grns.ts` is the worked example of how to know: its nine audit pre-flights
 * are documented as sitting "strictly before the handler's FIRST mutating
 * call", so every refusal at or above one of them is on the safe side of that
 * boundary by the file's own construction. */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';

export function refuseWithoutWriting(
  c: Context,
  /* `object`, not `Record<string, unknown>`: the refusal bodies here are named
     shapes (DownstreamRefusal, the company-scope refusals, the unlinked-PO
     report), and an index signature is not something a caller should have to
     add to its type to be allowed to say "I wrote nothing". */
  body: object,
  status: ContentfulStatusCode,
): Response {
  markIdempotencyNoWrite(c);
  return c.json(body as Record<string, unknown>, status);
}
