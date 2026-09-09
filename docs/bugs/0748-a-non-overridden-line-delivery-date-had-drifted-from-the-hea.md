## A non-overridden line delivery date had drifted from the header it mirrors [medium]

**Symptom.** The owner asked for HC-SO-013495's Processing Date and Delivery
Date to be removed (2026-09-09: 「这个remove掉processing date和delivery date」,
「我让sales 重新proceed」) because the colour is `tbc` and the factory cannot
build it. Clearing the two HEADER columns would have left the order still
showing as dated demand on MRP, the stock allocator, PO coverage and the
delivery board — the exact surfaces the removal exists to take it off.

**Root cause (traced).** `line_delivery_date` is a MIRROR of the header's
`customer_delivery_date` whenever `line_delivery_date_overridden` is false:
migration 0172's `apply_so_header_followers` writes that pair, and 0330's
`apply_so_header_cas` still does — `p_apply_delivery_date` sets
`line_delivery_date = p_delivery_date, line_delivery_date_overridden = false`
on every line of the document.

On HC-SO-013495 the mirror is not in step with what it mirrors. Read on
production 2026-09-09, probe run 34315803944:

| row | `line_delivery_date` | `line_delivery_date_overridden` |
| --- | --- | --- |
| header `customer_delivery_date` | 2026-09-08 | — |
| line 1, `9058-1S` | **2026-10-10** | false |
| line 2, `AMN-SOFA PILLOW` | 2026-09-08 | false |

Line 2 is a correct mirror. Line 1 claims not to be overridden and holds a date
32 days later than the header, so something set it without going through the
header path that maintains the pair.

That matters here because of step 4 of `effectiveSoDelivery`
(`src/scm/shared/effective-delivery.ts`): `line_delivery_date` is the LAST
RESORT, **override flag or not**. With the header date cleared and the mirror
left behind, every planning surface would keep reading 2026-10-10 for that line
and 2026-09-08 for the other — an order with no Processing Date still sitting in
the queue that decides what gets ordered and who gets scarce stock.

**Fix.** `backend/scripts/clear-so-dates.mjs` clears the pair the way
`apply_so_header_cas` does — the two header columns AND the line mirror — rather
than the header alone, so a clear cannot leave a half-cleared order behind. The
shape assertion lives in `backend/scripts/lib/so-date-clear-plan.mjs` and
refuses if the mirror survived, if either header date survived, if `version` did
not bump by exactly one, or if ANY other column of the header or of any line
moved.

Pinned by `backend/tests/soDateClearPlan.test.mjs`. **Proved RED first**: run
against a deliberately naive first draft that checked only the two header dates
— the shape a "1 row updated" report has — 13 of its 25 tests failed, including
`FAILS when a line kept its delivery date`, `FAILS when any other header column
moved` and `FAILS when the deposit moved`. All 25 pass against the real module.

This entry records the DRIFT, not a repair of its cause: what wrote line 1's
date is not established, and the order is being cleared and re-proceeded by
sales anyway. If a second document shows the same shape, that is the signal to
go looking for the writer.

**Ref.** fix/clear-so-013495-dates, 2026-09-09.
