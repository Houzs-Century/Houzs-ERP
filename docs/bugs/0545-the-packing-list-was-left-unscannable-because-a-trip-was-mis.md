## The packing list was left unscannable because a trip was mistaken for not-a-row [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** In business terms: the driver's sheet had a code on it that only
office staff could open, and half the feature the owner asked for did not exist.
The spec is that all three scans work by scanning **either** a delivery order
**or** the packing list, and that scanning the packing list moves the whole run:
「这三个操作都可以通过 scan DO 或 scan packing list 来达成（scan packing list 会将
该 list 内的货物统一全部出完）」. PR #2722 built the delivery-order half only. A
driver with twelve drops had to find and scan twelve separate delivery orders,
and the sheet in his hand — the one document that lists the whole run — was the
one thing that could not record anything.

**Root cause (traced).** Not a coding fault. **A wrong inference, written into a
comment as a reason, and then believed.** `packingRunUrl` in
`frontend/src/vendor/scm/lib/packing-list-pdf.ts` carried:

> *"a public no-login scan target is a separate change with its own security
> review, and it is not this one"*

and #2722 hardened that into a structural claim: *a packing list is not a row;
Houzs has no `packing_lists` table, so there is nothing to hang a per-document
token on.*

The first clause is true and the conclusion does not follow. **A packing list is
a trip, and a trip is a row.** Every property the delivery-order token depends on
was already there and is checkable in the tree:

| the token needs | scm.delivery_orders | scm.trips |
| --- | --- | --- |
| one row, stable id | uuid PK | uuid PK, `0053_scm_delivery_planning_tms.sql:67` |
| a non-null company **on that row** | `company_id`, mig 0083 | `company_id`, **mig 0083 — the same migration**, same `ALTER COLUMN company_id SET NOT NULL` |
| an ordered member list | its lines | `scm.trip_stops (trip_id, stop_no, do_id)`, `0053:94` |

`backend/src/scm/lib/packing-list-view.ts` says it in its own header — *"A
PACKING LIST IS A TRIP, RENDERED"* — and that file was read during #2722. The
sentence that was taken from it ("there is no `packing_lists` table") is the true
half; the half that mattered ("`scm.trips` already IS one day + one lorry") was
in the next clause and was not carried into the conclusion.

**The lesson, which is the reason this is a ledger entry and not just a
follow-up:** *"there is no table called X"* is not evidence that *"X is not a
row"*. The question a token needs answered is **"is there exactly one row per
one of these, and does it carry a company?"** — and that question was never
asked. A negative fact about naming was allowed to stand in for a positive fact
about structure.

**Fix.**

- **Mig `0329_scm_trip_public_scan_token.sql`** — `scm.trips.qr_token` (nullable,
  lazily minted, **UNIQUE partial index**) and `qr_revoked_at` (nullable, no
  index). Byte-for-byte the same shape as 0328, deliberately: one mechanism, not
  two, because two would be a second place to forget the revocation check.
- **`getOrCreateScanToken(sb, table, id, companyId)`** — the same atomic claim
  serves both tables through one path (`table` is a closed union literal, never
  caller input). `resolveScanToken` reports **which kind** it found; the caller
  branches on that and never infers it from the token, which is identical for
  both on purpose.
- **`GET /api/scm/trips/:id/scan-token`** mints it, behind the session.
- **The public advance fans out**: same rung, every delivery order on the run, in
  `stop_no` order, **one at a time**, with a line per drop.
- **The sheet's QR now encodes `/d/<token>`** and is captioned `SCAN AT EACH
  STEP` — the same words as the delivery-order print, because it is the same act.
  It read `SCAN · OPEN THIS RUN`, which described opening a view.

**How a drop on another company's books is refused.** This is not a hypothetical
edge case: trips is a **cross-company module by design** and its own router
header says so — *"a trip is raised from whichever company you are in; it may
still reference the other company's DOs"*. On an authed dispatcher's screen that
is a feature. Reached from a printed sheet with nobody logged in it is a lever
that moves another company's books, which is **bug 0497 with a QR code in front
of it**. So:

- the run's company comes from the **trip row** the token resolved to (NOT NULL,
  mig 0083; unique per token, mig 0329);
- each member delivery order is read **by id**, returning its **own**
  `company_id` — deliberately *not* scoped to the run's company, because a
  scoped read would make a stranger **vanish** from the sheet instead of being
  reported, and a drop that silently disappears is one the driver loads anyway;
- the **comparison** is the guard: a mismatch is `BLOCKED`, never written;
- a foreign drop is named by its **stop number only** — no document number, no
  customer name. Printing the other company's document number on a page anyone
  holding the sheet can open would be the leak, not the fix;
- every **write** is scoped to the run's company regardless.

**What the per-drop result looks like.** `{ stopNo, doNumber, outcome, from, to?,
message }` per member, where `outcome` is `DONE` / `ALREADY_DONE` / `BLOCKED` /
`FAILED`, plus a run headline of `DONE` / `PARTIAL` / `NOTHING`. One refusal
never aborts the rest: a driver told *"3 of 5 recorded"* without being told
**which two** is worse off than one told nothing, because he has to re-scan the
whole run to find out.

**Sequentially, never in parallel** — `for … await`, no `Promise.all`. Two drops
on one run frequently share a sales order and the status writer updates it
(`syncSoDeliveredFromDo`) on the delivered hop; run them together and they take
that shared row in different lock order. Hookka wrote the incident down after
paying for it (deadlocks, plus colliding invoice numbers from a
read-MAX-then-+1). The test **counts writes in flight** rather than reading the
source, so a `Promise.all` introduced later fails it.

**Proved RED on the unfixed tree**, guard by guard:

| guard deleted | test that went red |
| --- | --- |
| the foreign-member comparison | `a foreign drop is REFUSED, and named only by its stop number` — and `the GET withholds…` printed `HC-DO-2608-102` |
| `.order('stop_no')` | `the sheet reads as a RUN, in stop order` — stops came back `[3,2,1]` |
| `continue` → `break` on a refusal | `one held drop does NOT abort the rest` |
| the `for … await` → `Promise.all` | `the drops are written ONE AT A TIME` — peak concurrency 5, expected 1 |

**And one the harness was hiding.** The fake PostgREST ignored `.order()`, so the
stop-order assertion was certifying an ordering nobody checked — the repo's own
*"a checker that cannot match reports a clean run"* trap. The fake now sorts, and
that is what made the `.order()` deletion above provable.

Pinned by `backend/tests/publicDoScanRoute.test.ts`,
`backend/tests/publicDoScanSurface.test.ts`,
`frontend/src/pages/PublicDoScan.test.tsx` and
`frontend/src/vendor/scm/lib/packing-list-pdf.test.ts`.

**A DECISION THIS DOES NOT TAKE, and it belongs to the owner.** On a
*deliberately* mixed run, the scan now moves this company's drops and refuses the
other company's, telling the driver which. That is the safe direction and it is
not obviously the wanted one. The options are written up in
`docs/modules/delivery-tms.md`; the short form is (a) keep the refusal, (b) let
one scan move both companies' drops when the trip legitimately carries them, (c)
stop trips carrying another company's delivery orders at all. Nobody has ruled.

**Ref.** feat/scan-the-packing-list-moves-the-whole-run, 2026-08-26. Follows
`docs/bugs/0544-…` (the delivery-order half, PR #2722).
