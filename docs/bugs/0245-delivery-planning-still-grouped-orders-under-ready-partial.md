## Delivery Planning still grouped orders under "READY (PARTIAL)" [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** The owner, on the accessory-only case: *「只有配件,有一行没齐 →
READY (PARTIAL) ← 骗人 / 明说还缺什么」*. PR #2295 removed the string from
`so-readiness.ts` and the label became `SHORT: <categories>`. It was still on
the Delivery Planning board the same day: group by Stock and a
**"READY (PARTIAL)" header** appeared over rows whose own Stock cell read
`SHORT: ACCESSORY`.

**Root cause, traced.** `routes/delivery-planning.ts` did not take the label
from the rollup. It built a SECOND vocabulary locally —
`readiness.isFullyReady ? 'READY' : readyToShip ? 'READY (PARTIAL)' : 'PENDING'`
— and shipped it as `stock_status` beside the corrected `stock_remark`. The
comment directly above that line already described the NEW rule ("names what is
MISSING … never READY while short"), so the file contradicted itself in
adjacent lines. `DeliveryPlanningBoard.tsx` renders `stock_remark || stock_status`
(so an SO with no lines fell through to the old string), searches on both, and
**groups on `stock_status` alone** — which is why the fixed label and the stale
header appeared on one screen at once.

Same class as BUG CLASS optional-param-noop at the top of this file: one rule,
two expressions, and fixing the canonical one leaves the copy asserting the
opposite.

**Fix.** `stock_status` is a STATUS with two values, `READY` / `PENDING`, and no
locally-invented third. WHAT is missing stays `stock_remark`'s job. WHETHER the
order can leave is now its own field, `is_ship_ready`, shipped beside
`is_main_ready` — because that one is VACUOUSLY true when an SO carries no main
line, and a consumer gating on it green-lights an empty document (16 husks
reached READY_TO_SHIP that way on 2026-08-13). The compiler enumerated the
remaining call sites: the ASSR, DP and project row builders share the row shape
and now pass `is_ship_ready: null`, since they carry no stock to be ready for.

Docs corrected in the same change: `docs/stock-reconciliation.md` §2.1 stated
the old vocabulary as current — it now reads as *historical AutoCount value →
what the ERP writes today*, and warns that the tokens INVERTED (they used to
name what IS ready, they now name what is SHORT), so a pre-2026-08-16 row is a
generation gap rather than stock drift. `docs/modules/autocount-writeback.md`
§BALANCE gained the `soOutstandingCenti` (floored, what the write-back sends —
AutoCount is a licensed ledger and must not receive a negative) vs
`soBalanceCenti` (signed, what a human reads) split, and mig 0301's un-flooring
of `balance_centi_live`.

**Ref.** 2026-08-16, this PR. Follows #2295 (the rollup fix) and #2297
(over-collection).
