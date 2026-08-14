/* Mirror of src/scm/shared/so-terminal-states.ts, for the .mjs audits — a plain
   .mjs script cannot import TypeScript. tests/soTerminalStatesMirror.test.ts is
   the pin.

   Read that file's header before changing anything here. Eight audit and repair
   scripts judge which sales-order lines are still LIVE by this set; one that
   judges by a different set than the app allocates by does not report a smaller
   truth, it reports a wrong one — and it reports it confidently. */

/** SO statuses that no longer create demand. Order matches the TS file so the
 *  PostgREST string built there stays byte-identical; every consumer here does
 *  set membership, where order cannot matter. */
export const SO_TERMINAL_STATES = ["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"];
