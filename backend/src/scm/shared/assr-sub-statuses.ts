// ----------------------------------------------------------------------------
// assr-sub-statuses — the ONE list of service-case sub-statuses (小类).
//
// WHY THIS FILE EXISTS. The list was written by hand in five places. On
// 2026-09-01 (Nico) the Pickup / Return stage gained a first leg, Pending
// Customer Pickup. The screens' list (vendor/scm/lib/assr/stages.ts) and the
// stage-entry seed (services/assr.ts transitionStage) got it; the save
// allowlist in routes/assr.ts, the printed report and the activity log did
// not. So a case entered the stage on Pending Customer Pickup, and once anyone
// switched it to a supplier leg it could never be switched back: the save
// answered 400 "Unknown sub-status", which the phone showed and the desktop
// select swallowed.
//
// Byte-identical at backend/src/scm/shared/assr-sub-statuses.ts and
// frontend/src/vendor/scm/lib/assr-sub-statuses.ts: check-shared-mirrors.mjs
// compares those two paths, and assr-sub-statuses.canonical.test.ts fails on
// any difference. No imports, for the same reason.
// ----------------------------------------------------------------------------

export interface AssrSubStatusDef {
  key: string;
  label: string;
}

/**
 * Sub-statuses inside two stages, switched directly by ops (Nick 2026-07-15:
 * "我要可以直接换"). Stored on assr_cases.sub_status. Entering a stage that has
 * them seeds the FIRST entry; every other stage carries NULL.
 */
export const ASSR_SUB_STATUSES: Record<string, AssrSubStatusDef[]> = {
  under_verification: [
    { key: "pending_inspection", label: "Pending Inspection" },
    { key: "qc_issue_result", label: "QC Issue Result" },
  ],
  pending_supplier_pickup: [
    // Customer-pickup leg first (Nico 2026-09-01): it is the stage's entry
    // point (collect the item FROM the customer), so it is the seed.
    { key: "pending_customer_pickup", label: "Pending Customer Pickup" },
    { key: "pending_supplier_pickup", label: "Pending Supplier Pickup" },
    { key: "pending_supplier_return", label: "Pending Supplier Return" },
  ],
};

/** Every sub-status a case may carry: exactly what a save may set. */
export const ASSR_SUB_STATUS_KEYS: ReadonlySet<string> = new Set(
  Object.values(ASSR_SUB_STATUSES).flatMap((opts) => opts.map((o) => o.key)),
);

/** The sub-status a case takes on entering `stage`; null for a stage without any. */
export function assrSubStatusSeed(stage: string | null | undefined): string | null {
  const opts = Object.entries(ASSR_SUB_STATUSES).find(([s]) => s === stage)?.[1];
  return opts && opts.length > 0 ? opts[0].key : null;
}

/** The screen label for a sub-status key; null when the key is not a sub-status. */
export function assrSubStatusLabelOf(key: string | null | undefined): string | null {
  for (const opts of Object.values(ASSR_SUB_STATUSES)) {
    const hit = opts.find((o) => o.key === key);
    if (hit) return hit.label;
  }
  return null;
}
