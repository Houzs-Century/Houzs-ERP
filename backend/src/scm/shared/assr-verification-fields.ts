// ----------------------------------------------------------------------------
// assr-verification-fields — the Verification step's findings fields
// (HC-0133): inspection findings / action taken, next action, pending with.
// The root cause is the existing verified_root_cause.
//
// Byte-identical at backend/src/scm/shared/assr-verification-fields.ts and
// frontend/src/vendor/scm/lib/assr-verification-fields.ts (the frontend
// canonical test fails on any difference). No imports, for the same reason.
// ----------------------------------------------------------------------------

export const PENDING_WITH_OPTIONS = ["supplier", "production", "logistics", "customer", "management"] as const;

const LABELS: Record<string, string> = {
  supplier: "Supplier", production: "Production", logistics: "Logistics",
  customer: "Customer", management: "Management",
};
export const pendingWithLabel = (v: string): string => LABELS[v] ?? v;
/** Select options with a blank "not set" first, for screens whose select has none of its own. */
export const pendingWithOptions = (): { value: string; label: string }[] =>
  [{ value: "", label: "—" }, ...PENDING_WITH_OPTIONS.map((v) => ({ value: v, label: pendingWithLabel(v) }))];

/** Why a PATCH body's verification fields are refused, or null when they are fine. Absent and null pass. */
export function verificationFieldsError(body: Record<string, unknown>): string | null {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  if (has("pending_with") && !(PENDING_WITH_OPTIONS as readonly unknown[]).includes(body.pending_with))
    return `pending_with must be one of ${PENDING_WITH_OPTIONS.join(", ")}`;
  for (const k of ["inspection_findings", "next_action"])
    if (has(k) && typeof body[k] !== "string") return `${k} must be text`;
  return null;
}
