import { describe, expect, test } from "vitest";
import {
  PAGES,
  RETIRED_PAGE_KEYS,
  DORMANT_PAGE_KEYS,
  fullAccessMap,
  isRetiredPageKey,
  isValidPageKey,
  pageAccessFromPermissions,
  resolvePositionAccessFromRows,
} from "../src/services/pageAccess";

/* ─────────────────────────────────────────────────────────────────────────────
   THE CATALOGUE PIN — what this file is for, and why a count was not enough.

   Deleting a key from PAGES[] does not delete the rows keyed on it. The rows
   stay in `position_page_access` / `role_page_access`, both resolvers drop them
   through `isValidPageKey`, and the admin who saved them is told nothing. That
   is what happened on 2026-06-18: 6e59f071 pruned 14 keys as dead code and six
   of the owner's saved cells became orphans that same afternoon.

   The mechanism was NOT unguarded before this file — but the guard was an
   accident. positionAccessSnapshot.test.ts pins counts (PAGES.length = 50,
   orphans = 6, cells = 850), and because all 50 keys happen to have a row in the
   prod photograph, deleting any one of them did go red. It went red saying
   "expected 49 to be 50" under a suite named "the snapshot's shape matches what
   its header claims". A count that reads as bookkeeping about a generated file
   has exactly one obvious remedy — update the number — and taking it re-commits
   the June bug with a green tick. The guard has to name the key and say what
   deleting it costs, or it is just a speed bump on the way to the same place.

   So: the union of PAGES[] and RETIRED_PAGE_KEYS is pinned as a SET. A number
   cannot be nudged to make this pass. Removing a key fails until it is named as
   retired; the record of what left, and why, accumulates instead of evaporating.

   ONE CATALOGUE, TWO MATRICES. `role_page_access` and `position_page_access` are
   different tables with different level vocabularies, but both validate and
   resolve against this same PAGES[] (roles.ts:281, positions.ts:549). So the
   prune hazard is shared, and pinning the catalogue once covers both. The prod
   photograph only covers positions — the role matrix has no snapshot and never
   had even the accidental cover — which is the other half of why the pin lives
   here rather than in the snapshot suite.
   ───────────────────────────────────────────────────────────────────────────── */

/** Every key the catalogue has ever had: the 50 live today + the 14 6e59f071
 *  removed. Append-only. A key must never leave this list — leaving PAGES[] is
 *  what makes it retired, not forgotten. */
const EVER_KNOWN_PAGE_KEYS: readonly string[] = [
  // ── live in PAGES[] ──
  "projects",
  "projects.calendar",
  "projects.finances",
  "projects.list",
  "projects.maintenance",
  "sales",
  "scm",
  "scm.consignment",
  "scm.consignment.notes",
  "scm.consignment.orders",
  "scm.consignment.po_orders",
  "scm.consignment.po_receives",
  "scm.consignment.po_returns",
  "scm.consignment.returns",
  "scm.finance",
  "scm.finance.accounting",
  "scm.finance.outstanding",
  "scm.procurement",
  "scm.procurement.grn",
  "scm.procurement.mrp",
  "scm.procurement.pi",
  "scm.procurement.po",
  "scm.procurement.pr",
  "scm.procurement.products",
  "scm.procurement.suppliers",
  "scm.sales",
  "scm.sales.delivery",
  "scm.sales.invoices",
  "scm.sales.orders",
  "scm.sales.returns",
  "scm.transportation",
  "scm.transportation.drivers",
  "scm.warehouse",
  "scm.warehouse.adjustments",
  "scm.warehouse.inventory",
  "scm.warehouse.stock_take",
  "scm.warehouse.transfers",
  "service_cases",
  "service_cases.by_creditor",
  "service_cases.cases",
  "service_cases.metrics",
  "service_cases.pnl",
  "service_cases.settings",
  "settings",
  "system_health",
  "team",
  "team.departments",
  "team.members",
  "team.org_chart",
  "team.roles",
  // ── retired by 6e59f071, 2026-06-18 ──
  "delivery_orders",
  "logistics",
  "logistics.fleet",
  "logistics.trips",
  "orders",
  "orders.balance",
  "orders.overdue",
  "orders.pnl",
  "orders.sales_orders",
  "overview",
  "petty_cash",
  "purchase_orders",
  "sales_team",
  "sales_team_maintenance",
];

const FIX_INSTRUCTIONS = `
A page key left PAGES[] (or arrived in it) without the bookkeeping that keeps
saved access rows honest.

If you REMOVED a key: the rows keyed on it are still in position_page_access and
role_page_access. They are not deleted, they are orphaned — the resolvers skip
them, they grant nothing, and the admin who saved them is never told. This is
the 2026-06-18 bug (6e59f071) that cost the owner six cells he still believes
are in force. Decide, and record the decision:
  - the rows should keep working  -> migrate them to the new key in a migration
                                     (STAGING first), then retire the old key
  - the rows are genuinely dead   -> add the key to RETIRED_PAGE_KEYS in
                                     services/pageAccess.ts, with a note saying
                                     what happened to the rows
Then add the key to EVER_KNOWN_PAGE_KEYS here if it is somehow missing.

If you ADDED a key: append it to EVER_KNOWN_PAGE_KEYS above. That is all — the
list is how the next deletion gets caught.

Do NOT "fix" this by deleting the key from EVER_KNOWN_PAGE_KEYS. That is the
same silence, one layer up.
`;

/** Minimal D1 stand-in — the resolvers only ever prepare/bind/all one SELECT. */
describe("the page catalogue cannot lose a key quietly", () => {
  test("PAGES[] + RETIRED_PAGE_KEYS accounts for every key the catalogue ever had", () => {
    const live = PAGES.map((p) => p.key);
    const accounted = new Set([...live, ...RETIRED_PAGE_KEYS]);
    const pinned = new Set(EVER_KNOWN_PAGE_KEYS);

    // Reported as named sets, not as a count. "expected 49 to be 50" is what the
    // old accidental guard said, and it is why this file exists.
    //
    // Both directions are asserted in ONE expect so a rename — which is a
    // deletion and an addition at once — reports both halves on the first run.
    // Two separate expects would surface the vanished key, get fixed, and only
    // then admit there was a new key too.
    const drift = {
      vanished: [...pinned].filter((k) => !accounted.has(k)).sort(),
      unpinned: [...accounted].filter((k) => !pinned.has(k)).sort(),
    };

    expect(drift, FIX_INSTRUCTIONS).toEqual({ vanished: [], unpinned: [] });
  });

  test("the pin has no duplicates and a key is never both live and retired", () => {
    expect(new Set(EVER_KNOWN_PAGE_KEYS).size).toBe(EVER_KNOWN_PAGE_KEYS.length);

    const live = new Set(PAGES.map((p) => p.key));
    const both = [...RETIRED_PAGE_KEYS].filter((k) => live.has(k)).sort();
    expect(
      both,
      `retired keys that are somehow still in PAGES[]: ${both.join(", ")}. ` +
        `A key is live or retired, never both — if it is back, take it out of RETIRED_PAGE_KEYS ` +
        `and check what its old rows now mean.`,
    ).toEqual([]);
  });

  test("retired and dormant stay different states — no key is both", () => {
    // dormant = in PAGES[], settable, read by nothing (a greyed cell exists).
    // retired = not in PAGES[], rows inert, no cell to render at all.
    // Conflating them would grey a row that has no key, or hide a live one.
    const overlap = [...DORMANT_PAGE_KEYS].filter((k) => isRetiredPageKey(k)).sort();
    expect(overlap, `keys claimed as both dormant and retired: ${overlap.join(", ")}`).toEqual([]);
    for (const k of DORMANT_PAGE_KEYS) expect(isValidPageKey(k)).toBe(true);
  });
});

/* ── THE REGISTRY IS INERT ────────────────────────────────────────────────────
   RETIRED_PAGE_KEYS is a record, not a permission. If any of it ever reached the
   resolvers, the owner's six dead rows would come back to life and start
   granting access he last thought about in June — a silent widening, which is
   the same class of bug as the silent narrowing, pointed the other way. */
describe("naming a key as retired grants nothing", () => {
  test("a retired key is not a valid page key", () => {
    for (const key of RETIRED_PAGE_KEYS) {
      expect(isValidPageKey(key), `${key} must not resolve as a live page`).toBe(false);
    }
  });

  test("the wildcard's full map covers live keys only — `*` gets nothing retired", () => {
    const full = fullAccessMap();
    for (const key of RETIRED_PAGE_KEYS) expect(full[key]).toBeUndefined();
    // …and the `*` exemption is untouched for everything live. Narrowing this
    // locks the owner out of his own system.
    for (const p of PAGES) expect(full[p.key]).toBe("full");
  });

  test("POSITION: the owner's six orphan rows still resolve to nothing", async () => {
    // The exact rows sitting in prod today (positionAccessSnapshot.ts, Finance
    // Manager). They must stay inert: this file names them, it does not revive
    // them, and it does not delete them either.
    const out = resolvePositionAccessFromRows([
      { page_key: "overview", level: "full" },
      { page_key: "orders", level: "view" },
      { page_key: "orders.balance", level: "view" },
      { page_key: "orders.overdue", level: "view" },
      { page_key: "orders.pnl", level: "full" },
      { page_key: "petty_cash", level: "view" },
      { page_key: "projects", level: "view" },
    ]);
    for (const key of ["overview", "orders", "orders.balance", "orders.overdue", "orders.pnl", "petty_cash"]) {
      expect(out[key], `${key} must not appear in a resolved map`).toBeUndefined();
    }
    // The live row alongside them still works — the orphans are skipped, not fatal.
    expect(out["projects"]).toBe("view");
  });

  test("ROLE: the second matrix drops retired rows the same way", async () => {
    // role_page_access has no prod snapshot and never had even the accidental
    // count cover, so its behaviour is asserted directly rather than assumed.
    const out = pageAccessFromPermissions(new Set(["service_cases.read"]));
    expect(out["petty_cash"]).toBeUndefined();
    expect(out["service_cases"]).toBe("partial");
  });
});
