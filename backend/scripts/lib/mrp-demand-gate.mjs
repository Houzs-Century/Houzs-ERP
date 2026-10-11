/* Mirror of src/scm/shared/mrp-demand-gate.ts, for the .mjs replicas of the MRP
   engine (audit-mrp-pairing.mjs, check-mrp-so-line.mjs) — a plain .mjs script
   cannot import TypeScript. tests/mrpDemandGateMirror.test.ts is the pin.

   Owner 2026-09-15: an order with no processing date is not MRP demand. A replica
   that still counts those orders does not report a bigger truth, it reports a
   different engine. Read the TS file's header before changing anything here. */

/** TRUE when an order with this header `processing_date` is demand. */
export function soReleasedForDemand(processingDate) {
  if (processingDate == null) return false;
  if (processingDate instanceof Date) return !Number.isNaN(processingDate.getTime());
  return String(processingDate).trim() !== "";
}
