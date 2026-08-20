## The Processing Date had two storages, and one gate read the other one [high]

<!-- area: Sales orders + pricing -->

**The ruling, three times.** 2026-07-31: *"不要又 Processing Date,又 Proceed,全
系统直接统一一个叫 Processing Date... Processing Date 就是当天 Proceed 的意思。"*
2026-08-13: *"把 internal expected date、processing date 和 process date 都直接
整合变成一个... 因为每一次讨论到 processing date 的时候,你就有各种各样的 bug,
原因就是因为你有太多个了。"* 2026-08-18, naming the scope himself: frontend,
backend AND database.

**What had actually survived.** The 2026-08-13 work unified the DATA (519
company-1 orders) and the NAME (mig 0286). It deliberately kept
`scm.mfg_sales_orders.proceeded_at` as a second COLUMN, on a stated and coherent
argument recorded at `order-rules.ts:51-53`: *"it is a timestamp the system
writes, not a date the user picks; what is unified is the RULE, not the
storage."* The owner has overruled that for the purpose of DECISIONS.

**Measured before touching anything** (`backend/scripts/probe-proceed-split.mjs`,
prod, run `32093080121`, read-only, counts and statuses only):

| | company 1 (2724 live) | company 2 (77 live) |
|---|---|---|
| date + stamp | 519 | 21 |
| date only | 0 | 5 (all CONFIRMED) |
| **stamp only** | **0** | **16 (12 CONFIRMED, 4 READY_TO_SHIP)** |
| neither | 2205 | 35 |

**Three claims the measurement REFUTED, each of which had been repeated as fact.**

1. *"`so-detail-gates.ts:95` is the lock decision, on `proceeded_at` ALONE."* It
   is not. Both that function and its backend twin read `processing_date` first
   and decisively (`if (!proc) return false`), and reach `proceeded_at` only when
   `status` is falsy — which never happens, because every caller's SELECT names
   `status` and the census found no NULL-status row in either company across
   2826 orders. Dead code, not a second opinion.
2. *"The split regenerates daily through Remove-Processing-Date."* Not shown. No
   `proceeded_at` value younger than 36 days exists on any dateless order in
   either company, which rules out both STAMPING paths as recent producers. It
   does not rule out the paths that make a row stamp-only WITHOUT writing a
   stamp, and those are real — so the leak was closed anyway.
3. *"Every write site is accounted for."* The **2990 mirror** was missed.
   `routes/so-mirror.ts` upserts `applyMap(body.header, …)`, which keeps every
   inbound key present on the Houzs table, so `proceeded_at` arriving from 2990
   is written straight through. It needs no code change — `applyMap` filters
   against `information_schema`, so the eventual DROP silently ends it — but an
   audit that says "zero writers" and has not looked at the mirror is wrong.

Also corrected while in there: the 2026-08-13 post-check that reported "every
migrated date equals `proceeded_at`'s day" used
`(proceeded_at AT TIME ZONE 'UTC')::date`, off by one for any evening-MYT stamp.
Re-run in Malaysia time: company 1 agrees 519/519; company 2 agrees 32/35, and
the 3 that differ do so under UTC too, so they are real, not a timezone artifact.
No gate compares the two columns, so nothing depends on it either way.

**Shipped — every item provably moves nothing in production.** Locks
(`soProcessingLocked`, `procLockActive`, the amendment door, Delivery Planning's
board guard) decide on `processing_date` + `status` alone. Payloads that merely
CARRIED the column stopped: SO list, detail, POS board, dashboard summary,
`/status` response — nothing consumed any of them (the desktop "Proceed Date"
field was deleted 2026-06-05, and `useMfgSalesOrdersSummary` has zero callers in
`frontend/src`, `native/` or `e2e/`). The frontend now contains no
`proceeded_at` at all.

**The replacement for the deleted fallback is a type, not a column.** The old
`return Boolean(header.proceeded_at)` existed "so we never over-lock a
status-blind header". `status` is now REQUIRED on both predicates' parameters, so
a caller that has not fetched one fails to COMPILE instead of quietly deciding
out of a different fact; an empty status at runtime answers *not locked*, the
same side the marker protected.

**The leak, closed by removal rather than by a second clear.** Remove-Processing-
Date cleared the date and left the stamp; the stamp-once filter then made that
stamp permanent — the one live path that manufactures a row saying "proceeded"
out of one column and "not proceeded" out of the other, and the source of the 25
company-2 rows that carry that shape. An interim fix cleared both together; the
final state is stronger and simpler — there is no stamp to orphan, because
nothing writes one.

**The allocator, and why the ORDER mattered.** `so-stock-allocation.ts`'s
`allocGated` was the one reachable decision left — the one whose own comment had
described the *Processing Date* rule since 2026-08-10 while the code read the
other column. #2396 moved it while this work was in flight, and shipped saying
so: *"Blast radius on production is UNKNOWN and not invented — the probe that
measures it is on a branch that is not yet dispatchable."* **That probe is this
one, and the radius is above:** company 1 no-op; company 2 gains 5 and loses 16,
of which 4 are READY_TO_SHIP and drop visibly to CONFIRMED. Those 4 are the rule
working — *"没有 processing date 就代表没有 proceed"* — not a new fault, and the
repair is a human supplying the date, never a script inventing one
(`PROCEED_NEEDS_DATE`: a guessed start date is a real order in the factory queue
on the wrong day, with nothing to show it was guessed).

That flip is also what UNBLOCKED the writes, and the order was not optional: the
create stamp, the `/status` stamp, the `['proceededAt','proceeded_at']` map entry
and its stamp-once filter could only go once nothing read the column. Removing
them first would have landed every NEW order with a NULL stamp and gated it out
of allocation forever. They are gone now, along with `autoProceed` (which existed
only to decide the create stamp — and could only ever be true when a Processing
Date was ALSO being written, which the create already refuses to do unless the
same gate passes) and `soProceedGateBlocked` (both call sites gone). The RULE it
enforced did not move: every path that sets a Processing Date runs
`collectProcessingGateProblems`, which checks the same four completeness facts
inline and the money through `meetsDepositGate` — and after unification that is
every path that proceeds an order. The `/status` branch it guarded fired only
when the order ALREADY had a date, so it re-gated a state that had passed — and
inconsistently, since an order carrying a stamp as well was not re-gated at all.

**Two loose ends this creates, named rather than tidied away.** #2383 landed
hours earlier and lifted the proceed gate into `lib/so-proceed-gate.ts` with a
per-condition refusal. Removing the last two call sites leaves BOTH that module's
`soProceedGateBlocked` and `order-rules`'s `meetsProceedGate` with no caller in
routes, lib or the frontend. **Neither is deleted.** Deleting a freshly-shipped
export to tidy a merge is how work gets silently undone, and if a future proceed
path needs to refuse, that is what it should call. `docs/modules/sales-order.md`
has warned since 2026-08-13 that this rule had TWO enforcement sites held in step
*"by agreement, not by construction"*; that agreement now has one party,
`collectProcessingGateProblems` — which checks the same four completeness facts
inline and the money through `meetsDepositGate`, across 7 call sites.

**No code anywhere reads or writes `proceeded_at`.** That is the precondition the
DROP needed.

**The DROP is the one step left, and it is one deploy behind the code on
purpose.** `deploy.yml` runs
`pg-migrate` BEFORE `wrangler deploy`, so a column dropped in the same release
that stops selecting it leaves the still-live old Worker doing a PostgREST select
on a missing column — 42703 on every SO read for the length of the deploy. That
is exactly #1191/0189. `scm.mfg_sales_orders_with_payment_totals` also projects
it (`SELECT so.*`), and 0189 → 0190 → 0191 is the record of what happens when
that view is dropped and recreated: prod died twice with *permission denied for
view* because a recreated view is a NEW object whose ACL and owner do not
survive. The drop SQL and that constraint are written out at
`shared/so-processing-date.ts` under "RETIRING THE SECOND STORAGE".

**Two tests that were green while describing the wrong world.**
`tests/soDatePairWiring.test.ts` anchored its "the pair rule runs before the
`/status` proceed writes the date" assertion on `patch.proceeded_at` — a
neighbouring statement, not the write. When that statement stopped existing the
test failed loudly, which is the good outcome; it is now anchored on
`patch[SO_PROCESSING_DATE_COLUMN] = resolved.date`, the write it was always
about. And:
`tests/scaleRouteDrift.test.mjs` reconstructs the SO list projection from
`HEADER` plus a HAND-COPIED suffix and compares it to the scale benchmark's
column list. Removing `proceeded_at` from the route's real `LIST_COLS` left both
sides of that comparison unchanged, so the drift test stayed green while the
contract it guards no longer matched production. Both sides updated, and the
negative control run to confirm it does go red.

**Regression pins.** `backend/tests/soProcessingDateOneStorage.test.ts` (21) and
`frontend/src/vendor/scm/lib/so-detail-gates.one-storage.test.ts` (12). Source-
level, because re-adding `|| header.proceeded_at` to a lock passes every
behavioural test, reads as defensive in review, and only surfaces as an order
somebody cannot edit. Watched RED against pre-change source (5 backend / 1
frontend), green after. The behavioural half pins the lock against the four
presence classes at the statuses actually measured, so a future edit cannot
silently change who may edit an order. The count assertion enumerates the
surviving `proceeded_at` sites, so the follow-up cannot drift away from the plan
without going red.
