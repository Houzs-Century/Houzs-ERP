// ----------------------------------------------------------------------------
// so-cas — the sales order's compare-and-swap contract: the rollout grace
// window for a mandatory `version`, and the payment rows' version guard.
//
// Lifted out of routes/mfg-sales-orders.ts unchanged (2026-09-14, with
// docs/bugs/0888): that file is over its size ceiling and may only shrink, and
// these two pieces are rules about the WIRE, not about any one route. The
// route re-exports them, because two suites import them from there.
// ----------------------------------------------------------------------------

/* ── ROLLOUT GRACE WINDOW for mandatory CAS (2026-07-22) ───────────────────────
   Making `version` mandatory is a BREAKING wire change for every browser tab
   that is ALREADY OPEN when this deploys. Those tabs run the previous JS
   bundle, which never sends a version, so without a grace path the first Save
   after deploy 428s for every single person mid-edit, all at once, with no way
   to recover except a reload they have not been told to do. A correctness fix
   that interrupts the whole shop the moment it lands is not a fix yet.

   MECHANISM: a bounded, opt-in, self-closing window driven by the
   `SO_CAS_GRACE_UNTIL` Worker variable (an ISO-8601 instant).
     • unset  → strict from the first request (the safe default, and the
                permanent steady state; nothing to remember to turn off)
     • set and in the FUTURE → a request that omits the version is accepted with
                the PRE-CAS semantics (server-current version, last-writer-wins,
                exactly today's production behaviour) and flagged `casGrace`
     • set and in the PAST → strict again, automatically

   A STALE version is ALWAYS a 409, in or out of the window: the grace only
   covers clients that cannot speak the protocol at all, never a client that
   spoke it and lost. Set it to deploy time + 30 minutes at rollout and delete
   the variable afterwards — see docs/IDEMPOTENCY-PHASE2-RUNBOOK.md. */
export type SoCasGraceWindow = { until?: string | null; now?: number };

export function soCasGraceOpen(window?: SoCasGraceWindow): boolean {
  const raw = window?.until;
  if (!raw) return false;
  const until = Date.parse(String(raw));
  if (!Number.isFinite(until)) return false;
  return (window?.now ?? Date.now()) < until;
}

/** Read the window off the Worker env. One place, so no route invents its own. */
export const soCasGrace = (c: any): SoCasGraceWindow => ({
  until: (c?.env?.SO_CAS_GRACE_UNTIL as string | undefined) ?? null,
});

export type PaymentVersionGuard =
  | { ok: true; version: number; grace?: true }
  | { ok: false; status: 409 | 428; body: { error: string; currentVersion: number } };

/** Shared PATCH/DELETE payment CAS contract. Missing is 428, stale is 409. */
export function paymentVersionGuard(
  candidate: unknown,
  currentVersion: number,
  grace?: SoCasGraceWindow,
): PaymentVersionGuard {
  const version = Number(candidate);
  if (!Number.isInteger(version) || version < 1) {
    if (soCasGraceOpen(grace)) return { ok: true, version: currentVersion, grace: true };
    return {
      ok: false,
      status: 428,
      body: { error: 'payment_version_required', currentVersion },
    };
  }
  if (version !== currentVersion) {
    return {
      ok: false,
      status: 409,
      body: { error: 'payment_version_conflict', currentVersion },
    };
  }
  return { ok: true, version };
}
