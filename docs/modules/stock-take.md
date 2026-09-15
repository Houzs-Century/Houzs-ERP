# Stock Take

The cycle-count document — `scm.stock_takes` + `scm.stock_take_lines`. OPEN (counting) -> POSTED (variance booked as signed ADJUSTMENT inventory movements) -> CANCELLED. Desktop-only for counting; mobile has a read-only list.

## Statuses and flow

- OPEN -> POSTED (post books one ADJUSTMENT movement per non-zero-variance line) or OPEN -> CANCELLED (cancel, no movement to reverse). Undoing a POSTED take is a separate action, `/reverse`, not something a list row offers.
- The right-click menu offers only Open, Print and Cancel (OPEN-only) — no Edit (counting happens in place on the detail sheet, there is no edit route) and no Confirm/Post (posting needs the detail page's full variance summary in front of the operator before they commit).
- `scopeType: 'NONZERO'` snapshots only buckets whose system quantity is nonzero — no synthetic zero lines.
- Splitting one warehouse's count across several people is done with multiple takes, each scoped by CATEGORY or CODE_PREFIX and its own assignee — there is no separate sub-sheet table.

## Permissions

- `scmAreaGuard("scm.warehouse.stock_take")` on the whole router.
- Posting a take is allowed only for its named `assignee_staff_id` or a holder of `scm.stock_take.supervise` (normal wildcard semantics — Owner/IT Admin pass via `*`). A legacy take with no assignee (`assignee_staff_id NULL`) keeps the pre-phase-1 behaviour: any area-access caller may post it.
- A variance breach without `scm.stock_take.supervise` refuses the post (see Rules) regardless of who the assignee is.
- Blind-count stripping (below) applies to every caller without `scm.stock_take.supervise`, including the assignee themselves.

## Rules that must not break

- A variance breach (|counted − live| over the qty limit, default 5, OR the value limit, default RM500 when cost is known) posted by a non-supervisor is refused (403 `variance_supervisor_required`, naming the SKUs) and the POSTED flip is fully reverted — nothing is written, the take stays OPEN.
- A positive variance must resolve a real unit cost before posting, or the post is refused (422 `cost_required`) rather than booking an uncosted lot at RM0.
- `counted_by`/`counted_at` are stamped from the caller's REAL `scm.staff` uuid on every cell whose count changes; clearing a count clears its attribution.
- Every ADJUSTMENT movement (post, reverse, and manual `/inventory/adjustments`) stamps `performed_by` with the caller's real staff uuid — never `c.get('user').id` inside `/api/scm/*` (the pinned system row), except the documented fallback in `stock-takes.ts` for when the staff bridge resolves nobody, which exists only to keep the FK satisfied.
- Blind-count stripping happens SERVER-side (`system_qty`/`variance` nulled in the response for a non-supervising viewer while OPEN) — the frontend trusts the response's own `viewer` flags and must never re-derive who can see variance.
- The count warehouse is verified to belong to the caller's company before any SKU is read or snapshotted — a cross-company warehouse id must 404, not silently produce (or leak the SKU list for) a count sheet.
- Exactly two inline stock-allocation recompute calls exist for this module (post and reverse) — a pinned test counts them; don't add or remove one without updating it.

## Gotchas

- There is no mobile counting surface — the phone's Stock Take screen is a read-only reflection of the same list; don't expect entry/posting to work there in phase 1.
- A blind take's printed sheet omits the system/counted/variance columns and the variance rail entirely while OPEN, rather than accepting a caller-passed "blind" flag — the generator has no parameter for it at all, so a forgotten flag can't leak variance onto paper.
- The printed sheet never states a money figure anywhere — cost is used only internally to decide whether a variance can be booked, never printed.
- The assignee name is resolved by the page and passed to the PDF generator as a string — the generator has no way to accept a staff uuid, by design (a uuid must never reach a person).
- Printing reflects the server's saved rows only — an unsaved in-progress count on screen is not part of the record and will not appear on the sheet.

## Where the code is

- `backend/src/scm/routes/stock-takes.ts` — main API surface.
- `backend/src/scm/shared/stock-take-threshold.ts` — the variance-breach pure fold.
- `frontend/src/pages/scm-v2/StockTakesListV2.tsx`, `StockTakeNew.tsx`, `StockTakeDetail.tsx` — desktop surfaces.
- `frontend/src/pages/scm-v2/stock-take-grouping.ts` — model-view grouping fold.
- `frontend/src/vendor/scm/lib/stock-take-pdf.ts` — printed count sheet.
- `frontend/src/vendor/scm/lib/stock-queries.ts` — query hooks.
