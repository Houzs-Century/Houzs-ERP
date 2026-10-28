// ----------------------------------------------------------------------------
// so-save-lease — how a sales-order Save ENDS. PURE: no React, no I/O.
// Shared by the desktop editor (pages/scm-v2/SalesOrderDetail.tsx) and the phone
// (mobile/MobileNewSO.tsx), so the two cannot end a save differently again.
//
// A Save that writes lines is several requests: reserve the lease, write the
// lines under it, then one header PATCH that ends the save. Both screens used to
// say "this ends the save" (`completeLineWrites`) ONLY when their own header diff
// was empty. HC-SO-2609-071, owner 2026-09-15: the desktop had adopted the venue
// master's id for "MID VALLEY" — "1", not a uuid — so the diff held one field,
// the flag was not sent, the server dropped the field as not a venue id, and
// answered "nothing changed" without releasing the lease and without a version.
// The save reported success; every Save for the next minute met the owner's own
// lock.
//
// docs/bugs/0936-a-save-that-reported-success-left-the-order-s-lock-behind-so.md
// ----------------------------------------------------------------------------

/** The lease half of the header PATCH that ends a save. A save that took a lease
    always says it is done, whether or not the header carries fields too — with
    fields the server commits them under the lease and releases it after. */
export const soSaveEndFields = (leaseToken: string | null): Record<string, unknown> =>
  leaseToken ? { lineWriteLeaseToken: leaseToken, completeLineWrites: true } : {};

/** The version a screen keeps after a header PATCH answers: the one the server
    named, else the one it already had. Never `undefined` — a screen that adopted
    a missing version sent none on its next Save and was refused for it. */
export const soVersionAfter = (answer: unknown, kept: number | undefined): number | undefined => {
  const named = Number((answer as { version?: unknown } | null | undefined)?.version);
  return Number.isInteger(named) && named >= 1 ? named : kept;
};
