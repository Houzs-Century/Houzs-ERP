// ----------------------------------------------------------------------------
// assr-verification-fields — the Verification step's findings fields
// (HC-0133): inspection findings / action taken, next action, pending with.
// The root cause is the existing verified_root_cause. All three are free text.
//
// Byte-identical at backend/src/scm/shared/assr-verification-fields.ts and
// frontend/src/vendor/scm/lib/assr-verification-fields.ts (the frontend
// canonical test fails on any difference). No imports, for the same reason.
// ----------------------------------------------------------------------------

/** Why a PATCH body's verification fields are refused, or null when they are fine. Absent and null pass. */
export function verificationFieldsError(body: Record<string, unknown>): string | null {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  for (const k of ["inspection_findings", "next_action", "pending_with"])
    if (has(k) && typeof body[k] !== "string") return `${k} must be text`;
  return null;
}
