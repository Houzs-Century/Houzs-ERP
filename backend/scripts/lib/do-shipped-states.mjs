/* Mirror of src/scm/shared/do-shipped-states.ts, for the .mjs audits — same
   reason phone-normalise.mjs and variant-axes.mjs exist: a plain .mjs script
   cannot import TypeScript, and compiling the backend to run one audit is worse
   than a copy that is PINNED.

   tests/doShippedStatesMirror.test.ts is the pin. Read that file's header for
   why the two sets are different and must stay different; do not collapse them
   here. An audit that scans a different status set than the write path uses is
   how a COMPLETED delivery order ended up in scope for one sweep and invisible
   to another on the same day. */

/** Statuses whose FIRST entry writes the inventory OUT. */
export const DO_SHIPPED_STATES = ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED"];

/** Statuses in which the OUT has already been written (adds COMPLETED, which
 *  sits past INVOICED — a COMPLETED DO has certainly shipped). */
export const DO_STOCK_OUT_STATES = [...DO_SHIPPED_STATES, "COMPLETED"];
