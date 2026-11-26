import { useState } from "react";

/** Mint a key for ONE payment intent. Opaque to the server, which binds it to
 *  the authenticated principal, company, route and exact request payload. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

/** Merge the key into a fetch init. No key → the init is returned untouched and
 *  the middleware stays a pass-through, i.e. exactly today's behaviour. Keeps
 *  the header name in ONE place so call sites can't misspell it into silence. */
export function idempotentInit(key: string | undefined, init: RequestInit): RequestInit {
  if (!key) return init;
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      "Idempotency-Key": key,
    },
  };
}

/** One intent's key, for a form/sheet whose MOUNT is the intent — the operator
 *  opened it to record ONE payment, and it closes once that payment lands. The
 *  key lives exactly as long as that mount: stable for every retry while the
 *  sheet is open, gone when it closes, so the next payment is a new mount and a
 *  new key. Callers whose intent is a DATA row rather than a mount (a
 *  PaymentsTable draft) should instead mint with newIdempotencyKey() and store
 *  it on the row, which dies with the row on success — same rule, same effect.
 *
 *  There is deliberately no `rotate()`. Retiring the key on success sounds
 *  safer and is not: the only way to reach a second submit is for a step AFTER
 *  the successful post to fail (a refetch on bad signal — the exact scenario
 *  this module exists for), and a rotated key would then book the payment a
 *  SECOND time. Keeping the key means that retry REPLAYS, which is the honest
 *  answer: the operator only ever intended one payment. The key is retired by
 *  the intent ending, never by the write succeeding.
 *
 *  AND NOT ON A REFUSAL EITHER — the tempting one, tried and REJECTED on
 *  2026-08-18, so nobody has to re-derive why. The dead end being chased is
 *  real: a GRN refused with 409 zero_cost_receipt claimed this key against the
 *  refused payload, so the corrected resubmit came back 409
 *  idempotency_key_reused and only a page reload (which throws away everything
 *  typed) got out of it. Rotating here on that code looks like the fix and is
 *  not, because `idempotency_key_reused` DOES NOT MEAN "nothing was written".
 *  backend/src/middleware/idempotency.ts answers it whenever the stored claim's
 *  request hash differs from this request's — including when that claim holds a
 *  COMMITTED 201. A client that rotates on it, and tells the operator to press
 *  Save again, turns a retype into a SECOND document, a second stock IN and a
 *  second AutoCount enqueue. Costing the operator their typing is the cheaper
 *  of those two by a wide margin.
 *
 *  The dead end is fixed where the answer is actually known: the ROUTE calls
 *  markIdempotencyNoWrite(c) when it can prove it rolled everything back, and
 *  the middleware then DELETES the claim, so the corrected resubmit is a fresh
 *  claim and simply succeeds — no 409 to react to, and nothing for this module
 *  to guess at. A `key_reused` that still reaches the client is therefore, by
 *  construction, one no route was able to prove; it carries `completed_status`
 *  (the earlier request's own HTTP status) and the only safe response to it is
 *  to go and look. */
export function useIdempotencyKey(): string {
  const [key] = useState(newIdempotencyKey);
  return key;
}

/** useIdempotencyKey for a form whose screen outlives it: one key per `intent`
 *  (e.g. "copy:<source id>"). A screen that stays mounted while the operator
 *  opens the same form again on another document gets a new key with it, so a
 *  second, genuine receipt is never replayed as the first. */
export function useIdempotencyKeyFor(intent: string): string {
  const [held, setHeld] = useState(() => ({ intent, key: newIdempotencyKey() }));
  if (held.intent === intent) return held.key;
  const next = { intent, key: newIdempotencyKey() };
  setHeld(next);
  return next.key;
}
