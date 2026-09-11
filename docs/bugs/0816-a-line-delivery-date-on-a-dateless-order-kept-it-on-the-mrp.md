## A line delivery date on a dateless order kept it on the MRP page [low]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-11, on MRP rows showing a delivery date with no
processing date: *"我去看了一些 sales order，其实这些 delivery date 都是 item
delivery date 来的… 在 documentation 那边 processing date 跟 delivery date 其实
都是空的"*. He asked for the line date to be cleared so the row leaves the page.

**Root cause (read in `shared/effective-delivery.ts`).** The effective delivery
date resolves in four steps: the line's own date when explicitly overridden, then
the header's amended date, then the header's customer date, then — as a
last-resort MIRROR — the line's date again. That fourth step is the one at work:
on an order whose header carries no date at all, the line date stands in for a
header date nobody set, and MRP's visibility gate (`isDatedLine`) then treats the
order as dated demand.

**Not a defect in the resolver.** The mirror exists so a line-dated order is not
invisible; what makes it wrong here is that the header is empty because nobody
entered a promise, not because the line carries a better one.

**MEASURED BEFORE BUILDING, and the measurement corrected the premise.** On
production (company 1, live orders, read-only) this shape is **2 lines on 1
order** — `HC-SO-011042`, KELVIN THENG, both lines overridden to 2026-11-14. The
owner had read it as the general case; it is not. Of the 176 lines that show on
MRP without a processing date, **174 carry a REAL header delivery date** and are
untouched by this: clearing their line dates would change nothing, because the
header date is what MRP reads for them. The selector is therefore *"the header
has no date"*, never *"no processing date"* — the difference is 2 rows versus
176.

**Fix.** `backend/scripts/repair-orphan-line-delivery-dates.mjs` +
`.github/workflows/orphan-line-delivery-dates.yml`. Plan by default; apply behind
`CONFIRM="CLEAR LINE DATES"`; writes ONE column (`line_delivery_date`) and never
touches a header; re-asserts inside the transaction that the header is still
dateless, so a header date entered between the plan and the apply keeps its line
date; verifies on a FRESH connection that each line reads NULL *and* the header
is still dateless — the second half matters, because a header date appearing
after the write means the line date should have been kept.

**Observed:** `MODE=plan` against the read-only production DSN listed exactly the
two lines above. `audit:release-discipline` reports no new violations.
**APPLY HAS NOT BEEN RUN** — it is a production write and the owner's call.

**The warning that ships with it:** an order cleared this way then carries no
delivery date anywhere. That is the intended effect. If one of them turns out to
be a real order, it needs a HEADER date entered, not the line date put back.

**Ref.** `fix/recompute-verifies-its-own-writes`, 2026-09-11.
