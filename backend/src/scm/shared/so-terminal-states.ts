/* ----------------------------------------------------------------------------
   so-terminal-states — the ONE declaration of "this sales order line no longer
   demands stock".

   WHY THIS FILE EXISTS. The same six statuses were hand-typed into FOURTEEN
   places across ten files, under four names — `SO_DONE` (mrp.ts + 4 scripts),
   `ALLOC_EXCLUDED` (2 scripts), `NON_ALLOCATABLE`, `EXCLUDED` — plus a raw
   PostgREST `not.in` string in so-stock-allocation.ts and inline SQL
   `NOT IN (...)` inside four of those same scripts, which is a copy inside a
   copy. Each cited a different file as the authority (`mrp.ts` in some,
   `so-stock-allocation.ts` in others), and each promised in a comment to stay
   in step:

     "mrp.ts verbatim"
     "Keep this replica in lockstep or its figures lie"
     "Same terminal set the recompute itself excludes"
     "the snapshot must cover exactly the rows the function can touch"

   None of those is a mechanism. SHIPPED was added to this set on 2026-08-01
   (MRP pairing audit D4) precisely because one consumer had been left out of an
   earlier round of the same hand-editing, and a set that has to be edited in
   fourteen places will be edited in thirteen.

   THE ORDER IS THE ALLOCATOR'S. so-stock-allocation.ts sends this list to
   PostgREST as a literal `not.in.(...)` string; keeping the declared order
   means that string is byte-for-byte what it was before this file existed.
   Every other consumer builds a Set, where order cannot matter.

   NOT THE SAME AS /inventory's SO_DONE. routes/inventory.ts declares a FOUR-
   status set (no DRAFT, no SHIPPED) for its reservations bucket. That is a real
   disagreement about which orders are open, not a formatting difference, and it
   is deliberately NOT collapsed into this file — resolving it changes the
   numbers on the Inventory page and is the owner's call. See BUG-HISTORY
   2026-08-13.

   Pure constants, no imports. scripts/lib/so-terminal-states.mjs mirrors this
   for the .mjs audits; tests/soTerminalStatesMirror.test.ts pins the pair.
   ---------------------------------------------------------------------------- */

/** SO statuses that no longer create demand: the goods have left, the order is
 *  closed or cancelled, or it was never committed (DRAFT). */
export const SO_TERMINAL_STATES = [
  'CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT',
] as const;

/** The same set as a PostgREST `in` list — `.not('status','in', ...)`. */
export const SO_TERMINAL_STATES_PGREST = `(${SO_TERMINAL_STATES.join(',')})`;

export type SoTerminalState = (typeof SO_TERMINAL_STATES)[number];
