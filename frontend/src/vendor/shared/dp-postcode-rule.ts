/* Which Delivery Planning job types need a postcode on their destination
   (owner 2026-11-17). ONE rule, two copies: backend/src/scm/shared is the
   original and frontend/src/vendor/shared its byte-identical twin
   (check-shared-mirrors.mjs). A lorry going to the workshop needs none, and
   SETUP / DISMANTLE are scheduled from the Project module, so theirs stays
   optional; a TRANSFER's origin is never required. */
export const POSTCODE_REQUIRED_JOB_TYPES: ReadonlySet<string> = new Set([
  'DELIVERY', 'PICKUP', 'SERVICE', 'INSPECTION', 'SUPPLIER_PICKUP', 'TRANSFER',
]);
