// ----------------------------------------------------------------------------
// positionCapabilities — the CATALOGUE and the GATE for per-position
// operational capabilities (the editable Roles & Permissions matrix).
//
// Owner ruling 2026-08-22: the Team module's Roles & Permissions screen must be
// EDITABLE in the UI. Page/menu access stays code-defined in positionPolicy
// (the 2026-07-18 architecture is untouched); this module carries the OTHER
// axis — "which operational verbs may this POSITION perform". Grants are rows
// in `position_capabilities` (PG mig 0322 / D1 mirror 150); the catalogue of
// valid keys lives HERE, in code, so a typo in the editor can never mint a
// phantom capability.
//
// Same fail-closed discipline as services/capabilities.ts:
//   * an absent/positionless caller resolves to DENIED, never granted;
//   * the `*` wildcard (role grant, or a god POSITION via the hydration
//     injection — Super Admin / Owner) passes every capability, which is why
//     the editor locks those rows;
//   * `hasPositionCapability` is THE gate. Enforcement sites (the DO
//     load/dispatch/revert split, invoice issuing) import it; the wire
//     capability map names it only once a site enforces it — a capability with
//     no enforcing gate is a UI hint, and the matrix screen says so.
// ----------------------------------------------------------------------------

export interface PositionCapabilityDef {
  key: string;
  /** Column header in the matrix. */
  label: string;
  /** Matrix group header (Delivery / Finance / …). */
  group: string;
  /** One-liner shown in the editor. */
  description: string;
}

export const POSITION_CAPABILITY_DEFS: readonly PositionCapabilityDef[] = [
  {
    key: "scm.do.load",
    label: "Load",
    group: "Delivery",
    description:
      "Mark a delivery order LOADED at the warehouse (pre-ship — no stock movement, no customer email).",
  },
  {
    key: "scm.do.dispatch",
    label: "Dispatch",
    group: "Delivery",
    description:
      "Send a delivery order out. Stock is deducted at this step; the customer email follows the global mail switch (currently off).",
  },
  {
    key: "scm.do.revert",
    label: "Revert dispatch",
    group: "Delivery",
    description:
      "Exception power: pull a wrongly dispatched order back to LOADED — stock returns, fully audited.",
  },
  {
    key: "scm.invoice.issue",
    label: "Issue invoices",
    group: "Finance",
    description: "Create sales invoices from delivery orders (DO → SI).",
  },
] as const;

const VALID_KEYS: ReadonlySet<string> = new Set(
  POSITION_CAPABILITY_DEFS.map((d) => d.key),
);

export function isValidPositionCapability(key: string): boolean {
  return VALID_KEYS.has(key);
}

/** The caller shape the gate reads — structurally satisfied by AuthUser.
 *  Absent fields deny, never grant. */
export interface PositionCapabilityCaller {
  permissions?: ReadonlyArray<string>;
  permissions_set?: ReadonlySet<string>;
  /** Capability keys hydrated for the caller's position (PR-C wires this onto
   *  the session envelope; a route may also pass a freshly-read set). */
  position_capabilities?: ReadonlyArray<string> | null;
}

/**
 * THE gate. `*` (role wildcard, or a god position via the hydration injection)
 * passes everything; otherwise the caller's position must hold a grant row.
 */
export function hasPositionCapability(
  user: PositionCapabilityCaller | null | undefined,
  key: string,
): boolean {
  if (!user) return false;
  if (!isValidPositionCapability(key)) return false;
  if (user.permissions_set?.has("*") || user.permissions?.includes("*")) return true;
  return (user.position_capabilities ?? []).includes(key);
}
