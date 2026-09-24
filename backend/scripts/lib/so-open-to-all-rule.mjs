/* WHICH sales orders carry `open_to_all` — one home for the rule, so the
   reconciler, its test and anything that audits the flag later cannot each
   answer it slightly differently.

   THE RULE, in the owner's words (2026-09-23): 「未交完的保持 open,其余收回去」.
   Two conditions, and the second one is the new half:

     1. It came FROM AutoCount (the 2026-08 cutover import). Native ERP orders
        are never opened — the desk that owns them is the desk that may edit
        them. The caller decides this with `soIsMigratedShape`
        (src/scm/lib/so-is-migrated.ts), which is why this module takes the
        ANSWER rather than the two document numbers: the migrated rule has its
        own home and a second copy of it here is exactly what that file exists
        to prevent.
     2. It is still OUTSTANDING — not one of SO_TERMINAL_STATES. An order that
        is delivered, closed or cancelled has nothing left for a passer-by to
        correct, and `open_to_all` is not only visibility: the SO write gate
        (`selfScopedSalesBlocked` -> `soDocOutOfScope`) short-circuits on the
        same flag, so leaving it set on a finished order leaves every user able
        to edit it. Owner 2026-09-23 chose to keep that reach for the live
        orders and withdraw it from the finished ones.

   TERMINAL COMES FROM THE APP'S OWN VOCABULARY, never a list typed here. A
   status the app stops creating demand for is the same status this stops
   opening, and SO_TERMINAL_STATES already has to stay in step with the TS home
   (tests/soTerminalStatesMirror.test.ts pins it). Today that means CONFIRMED /
   IN_PRODUCTION / READY_TO_SHIP stay open and DELIVERED / CLOSED / CANCELLED
   (plus SHIPPED / INVOICED / DRAFT, which no imported order currently carries)
   do not — measured on production 2026-09-23: 2,580 open, 302 withdrawn.

   AN UNREADABLE STATUS CLOSES. A blank or missing status cannot be shown to be
   outstanding, and the permissive answer here hands write access on that order
   to everybody. Closing one order that should have been open is visible and
   costs a re-run; opening one that should have been shut is neither. */

import { SO_TERMINAL_STATES } from "./so-terminal-states.mjs";

const TERMINAL = new Set(SO_TERMINAL_STATES);

/**
 * Should this sales order carry `open_to_all = true`?
 *
 * @param {{ isMigrated: boolean, status: string | null | undefined }} row
 *   `isMigrated` is soIsMigratedShape(doc_no, linked_ac_docno) — the caller's
 *   job, from its own home. `status` is mfg_sales_orders.status.
 * @returns {boolean}
 */
export function shouldBeOpenToAll({ isMigrated, status }) {
  if (!isMigrated) return false;
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "") return false; // unclassifiable -> closed, never open
  return !TERMINAL.has(s);
}

/**
 * The two work lists, derived from rows already read. Pure so the reconciler's
 * PLAN and its WRITE come from one classification — the write then names the
 * exact doc_nos this printed, rather than re-deriving a predicate in SQL that
 * could drift from the one the operator read.
 *
 * @param {Array<{ docNo: string, isMigrated: boolean, status: string | null, openToAll: boolean }>} rows
 * @returns {{ toOpen: string[], toClose: string[], wantOpen: string[] }}
 */
export function planOpenToAll(rows) {
  const toOpen = [];
  const toClose = [];
  const wantOpen = [];
  for (const r of rows) {
    const want = shouldBeOpenToAll({ isMigrated: r.isMigrated, status: r.status });
    if (want) wantOpen.push(r.docNo);
    if (want && !r.openToAll) toOpen.push(r.docNo);
    if (!want && r.openToAll) toClose.push(r.docNo);
  }
  return { toOpen, toClose, wantOpen };
}
