// ----------------------------------------------------------------------------
// so-cas — the sales order's compare-and-swap contract: the rollout grace
// window for a mandatory `version`, and the payment rows' version guard.
//
// Lifted out of routes/mfg-sales-orders.ts unchanged (2026-09-14, with
// docs/bugs/0888): that file is over its size ceiling and may only shrink, and
// these two pieces are rules about the WIRE, not about any one route. The
// route re-exports them, because two suites import them from there.
// ----------------------------------------------------------------------------

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
