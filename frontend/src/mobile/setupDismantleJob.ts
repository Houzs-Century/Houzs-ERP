/* The driver run-sheet's "Setup & dismantle photos" block — overall-booth +
   setup-complete POD photos and the 3D floor plan — belongs ONLY to an
   exhibition SETUP / DISMANTLE job: a PMS project window (feed row_type
   'project') or a manual DP order of that job type. The feed carries the job
   type on `dp_job_type` (DELIVERY / PICKUP / SERVICE / SETUP / DISMANTLE /
   SUPPLIER_PICKUP); a plain customer Sales-Order delivery is null.

   It used to be gated on `replacement_disposal` ("replace furniture"), but
   disposal only means "haul the old furniture away" and happens on ordinary
   customer deliveries too — so a delivery like HC-SO-2610-063 wrongly showed
   the booth POD. The disposal callout stays (the driver still needs it); only
   the booth-photo block keys off the real job type now. */
export function isSetupDismantleJob(row: {
  dp_job_type?: string | null;
}): boolean {
  const t = (row.dp_job_type || "").trim().toUpperCase();
  return t === "SETUP" || t === "DISMANTLE";
}
