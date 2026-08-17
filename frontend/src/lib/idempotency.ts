// ---------------------------------------------------------------------------
// Idempotency keys for money-mutating requests — the CLIENT half.
//
// backend/src/middleware/idempotency.ts is mounted on /api/* after auth and
// companyContext, so principal + tenant scope are set before its claim store. It has an
// in-flight 409 and a daily TTL sweep. It is OPT-IN: a pure pass-through unless
// the client sends an `Idempotency-Key` header, and until this module NO client
// ever sent one. A safety feature nobody switched on is not a safety feature —
// every double-fire of a payment write (double tap, flaky-network re-submit,
// an operator re-pressing after a partial failure) booked the money twice.
//
// Two rules. Break EITHER and this is worse than the bug it fixes:
//
//   1. STABLE for a retry. A key minted per click or per render hands the two
//      halves of a double-fire two DIFFERENT keys, and the middleware no-ops.
//      That is a fix that does nothing.
//   2. UNIQUE per intent. A key derived from the payload makes two GENUINE
//      identical payments (the same customer pays RM100 twice today) collide,
//      and the middleware replays the first response verbatim — so the second
//      payment is silently swallowed and the money is never booked, while the
//      operator is told it saved. That is a fix that LOSES money.
//
// So: mint once when the operator STARTS one payment (opens the sheet, adds the
// draft row), reuse it for every retry of that one submit, and let it die with
// the thing that represents the intent — the draft row is removed on success,
// the sheet unmounts on close. The key is retired by the intent ENDING, never by
// the write succeeding; see useIdempotencyKey for why that distinction is load-
// bearing rather than pedantic.
//
// This is deliberately NOT hidden inside authedFetch. Only the call site knows
// where an intent begins and ends: an automatic per-request key would satisfy
// (2) and break (1); an automatic payload-derived key would satisfy (1) and
// break (2). There is no correct automatic key, which is precisely why the
// middleware was built opt-in and precisely why nobody ever opted in.
//
// SCOPE: money that duplicates — a call site that creates a payment-ledger row,
// adds to a paid total, or MINTS A SOURCE DOCUMENT money hangs off. The third
// clause was added 2026-07-17 (fix/so-idempotency) and is not a widening of the
// rule, it is the rule finally being read: SO create was left out while every
// payment stacked ON TOP of it was covered, so the order itself could be raised
// twice at RM3,888 and take DO / SI / stock with it. The middleware's own
// docblock always said so — "instead of creating a duplicate order/DO/PO".
//
// NOT a blanket on every POST: plenty of endpoints have legitimate repeat-submit
// semantics (SoFromProducts' batch generator raises N orders per run BY DESIGN —
// a per-mount key there would collapse N into 1, which is rule (2) inverted and
// worse than the bug it would claim to fix), and an endpoint that is already
// domain-idempotent (payment-vouchers.ts:407 /post, :528 /cancel both detect
// their own replay and echo back) gains nothing from a key.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";

/** Mint a key for ONE payment intent. Opaque to the server, which binds it to
 *  the authenticated principal, company, route and exact request payload. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // randomUUID needs a secure context. Keep a fallback so a payment can still
  // be recorded from an http:// LAN origin instead of throwing at the mint —
  // failing to mint must never block collecting money.
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

/* ── Rotation: the ONE case the mount-scoped key cannot answer ──────────────
   A key that never rotates is right for every outcome where the server MIGHT
   have written, and wrong for exactly one shape, which staff hit for real on a
   Goods Receipt from a PO (2026-08-17):

     submit 1 -> 409 zero_cost_receipt   (a correct business guard: the lines
                 carried unit price 0 on an item bought at a real price before)
     operator types the unit price the guard asked for, submits again
     submit 2 -> 409 idempotency_key_reused
                 "This request key was already used for different data."

   Dead end. The only recovery was a full page reload, which throws away
   everything typed — so a guard whose whole purpose is "fix this and retry"
   made retrying impossible.

   WHAT MAY ROTATE, AND WHY IT WEAKENS NOTHING. Only the two refusals the
   middleware answers BEFORE it runs the handler (backend/src/middleware/
   idempotency.ts — `respondToExisting` returns both above `next()`), so this
   request provably created nothing:

     • idempotency_key_reused   — the stored claim's request hash differs, i.e.
       the payload CHANGED. The server has already declared it will never
       replay under this key for this payload, so the key protects nothing
       here; keeping it only guarantees a permanent 409. The success-replay
       invariant is untouched, because a replay needs an IDENTICAL payload and
       an identical payload never produces this code.
     • idempotency_key_conflict — the key is owned by another principal/tenant
       (the phase-1 global primary key). Same proof, same dead end.

   WHAT MUST NEVER ROTATE, and each for a concrete reason:
     • success — the whole point of the module. A step AFTER a successful post
       can fail (a refetch on bad signal), the operator re-presses, and a
       rotated key would book the money a SECOND time.
     • idempotency_in_flight — the same write is running right now.
     • idempotency_outcome_unknown (503) — "we could not confirm whether this
       was recorded" is the opposite of proof that nothing was.
     • a network failure or timeout — aborting a fetch does not abort the
       Worker; the write may well have landed.

   The rotation is driven from the fetch layer rather than the 27 call sites:
   only the layer that saw the response knows the key is dead, and a per-form
   opt-in is how half of them would silently keep the dead end. */
const KEY_DEAD_ON_REFUSAL = ["idempotency_key_reused", "idempotency_key_conflict"];

/** Live mount keys -> the setter that replaces them. A key minted with
 *  newIdempotencyKey() and stored on a data row is deliberately absent, so
 *  retiring it is a no-op — that key dies with its row, not with a response. */
const rotatableKeys = new Map<string, () => void>();

/** Called by the fetch layer on a failed mutation, with the key that request
 *  carried and the raw response body. Rotates ONLY on a refusal that proves
 *  the server ran no handler; every other status leaves the key alone, so a
 *  write that may have committed still replays instead of repeating.
 *
 *  Rotating does NOT resubmit — the operator presses Save again on the same
 *  screen, with everything they typed still there. An automatic replay would
 *  be a second submit nobody asked for, which is the bug this module exists to
 *  prevent wearing a different hat. */
export function rotateIdempotencyKeyAfterRefusal(
  key: string | undefined,
  status: number,
  body: string,
): void {
  if (!key || status !== 409) return;
  // Match the quoted JSON code, not a bare substring: the offending code can
  // also appear inside a `message` sentence, and this must key off the
  // machine field the middleware sets.
  if (!KEY_DEAD_ON_REFUSAL.some((code) => body.includes(`"${code}"`))) return;
  rotatableKeys.get(key)?.();
}

/** One intent's key, for a form/sheet whose MOUNT is the intent — the operator
 *  opened it to record ONE payment, and it closes once that payment lands. The
 *  key lives exactly as long as that mount: stable for every retry while the
 *  sheet is open, gone when it closes, so the next payment is a new mount and a
 *  new key. Callers whose intent is a DATA row rather than a mount (a
 *  PaymentsTable draft) should instead mint with newIdempotencyKey() and store
 *  it on the row, which dies with the row on success — same rule, same effect.
 *
 *  Retiring the key on SUCCESS is still refused, for the reason it always was:
 *  the only way to reach a second submit is for a step AFTER the successful
 *  post to fail, and a rotated key would then book the payment a SECOND time.
 *  Keeping it means that retry REPLAYS, which is the honest answer — the
 *  operator only ever intended one payment. The key is retired by the intent
 *  ending, or by the server proving it never ran (see the block above), never
 *  by the write succeeding. */
export function useIdempotencyKey(): string {
  const [key, setKey] = useState(newIdempotencyKey);
  useEffect(() => {
    const rotate = () => setKey(newIdempotencyKey());
    rotatableKeys.set(key, rotate);
    // Remove only OUR OWN registration. A cleanup that deletes by key alone
    // would take a newer mount's live entry with it and silently turn its key
    // back into the dead end this exists to fix.
    return () => {
      if (rotatableKeys.get(key) === rotate) rotatableKeys.delete(key);
    };
  }, [key]);
  return key;
}
