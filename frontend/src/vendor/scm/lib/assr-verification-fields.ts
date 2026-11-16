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
  const textError = (k: string) =>
    body[k] !== undefined && body[k] !== null && typeof body[k] !== "string" ? `${k} must be text` : null;
  return textError("inspection_findings") ?? textError("next_action") ?? textError("pending_with");
}
