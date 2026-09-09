## The go-live gate blamed AutoCount for 43 orders whose stale side was ours [high]

**Symptom.** `check-golive-parity.mjs`'s first production run reported 220 orders
as "AUTOCOUNT BEHIND" and printed, as its reading instruction, that a difference
is AutoCount behind the ERP unless the line says otherwise. That is the owner's
own ruling (「以我们的为标准,因为我们的数据比较准确」) and it is the sentence he
would have unlocked the ERP on. On 43 of those 220 it was wrong in his favour,
which is the worst direction for a release gate to be wrong in.

**Root cause (traced).** The ERP side of section 1B is
`summariseReadiness(...)` rolled up from the STORED
`mfg_sales_order_items.stock_status`. That column is written only by
`recomputeSoStockAllocation`, ~34 of whose ~38 triggers are best-effort, and a
sweep that loses the single-flight race returns `{ok:true}` leaving no queue row
to retry — the staleness `probe-so-stock-status-stale.mjs` was written to measure
and `docs/modules/sales-order.md` §0.3 records. So a line can read PENDING with
the goods standing in its own warehouse bucket. On such an order AutoCount's
typed READY is plausibly the correct answer and the ERP's the stale one, and the
gate had no way to say so: it consulted the stored value and nothing else.

Measured against prod on 2026-09-07 with the probe's own bracket: 684 live lines
whose bucket holds on-hand while the line reads non-READY (ceiling), 126 with
enough on-hand for the whole bucket's demand so FIFO competition cannot explain
them (floor), across 89 orders — **43 of which are in the 220.** The recompute
queue was EMPTY and the lock free, so nothing was pending that would have
refreshed them.

**Fix.** The gate now reports those 43 as **CONTESTED** — named, counted, and
excluded from the "AutoCount behind" sentence, which now reads 177. The bracket
is not re-derived: `probe-so-stock-status-stale.mjs` owned it privately and it
moves to `backend/scripts/lib/so-stock-staleness.mjs`, imported by both, so the
two scripts cannot come to disagree about which system is behind. The
classifier's predicates (`isServiceLine`, `isTerminalStatus`, `variantKeyOf`,
`processedOf`) are REQUIRED arguments rather than defaulted — an absent predicate
would widen the population silently — and that requirement caught a real error on
the first run (`SO_TERMINAL_STATES` is an array, not a Set, so a `.has` default
would have quietly matched nothing).

Proved RED before the change (the gate printed 220 with no contested class at
all) and green after (220 = 177 + 43, with the 43 listed). The extraction is
behaviour-preserving for the probe, proven by running it against prod before and
after: UPPER 726 and LOWER 155 both times, same per-reason split (1,332 stored
READY / 533 service / 1,121 sofa / 10,523 gated / 983 candidates).

**Ref.** chore/golive-parity-staleness, 2026-09-07.
