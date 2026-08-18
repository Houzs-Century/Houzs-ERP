/* Mirror of src/scm/shared/do-shipped-states.ts, for the .mjs audits — same
   reason phone-normalise.mjs and variant-axes.mjs exist: a plain .mjs script
   cannot import TypeScript, and compiling the backend to run one audit is worse
   than a copy that is PINNED.

   tests/doShippedStatesMirror.test.ts is the pin. Read the ORIGINAL's header for
   why the two sets are two names; do not collapse them here. An audit that scans
   a different status set than the write path uses is how one delivery order
   ended up in scope for one sweep and invisible to another on the same day.

   COMPLETED left both sets on 2026-08-18. It is not a member of scm.do_status:
   `?status=delivered` returned 500 `invalid input value for enum do_status:
   "COMPLETED"` in both tenants on 2026-08-17, the enum is created with seven
   labels in scripts/scm-schema/2990s-full-schema.sql:5 plus DRAFT from mig 0040,
   and no code writes it. The line below used to assert as fact that "a COMPLETED
   DO has certainly shipped"; nothing had ever checked. For an audit here the
   cost was silent: these sets go into SQL, and a label the enum does not have
   makes the statement THROW rather than match nothing. */

/** Statuses whose FIRST entry writes the inventory OUT. */
export const DO_SHIPPED_STATES = ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED"];

/** Statuses in which the OUT has already been written. Equal to
 *  DO_SHIPPED_STATES since COMPLETED was removed; still its own question. */
export const DO_STOCK_OUT_STATES = [...DO_SHIPPED_STATES];
