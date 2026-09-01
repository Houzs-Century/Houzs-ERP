## A typed payment row was silently dropped by the page Save [high]

**Symptom.** Owner, 2026-08-31: 「我明明有 update 到 payment，可是为什么 payment 那边
没有 save 成功呢」 — and, when the same answer was given about the wrong half:
「不是啊进来了的 已经不能改了，可是我是可以添加 payment 的啊 可以 second third
payment 的啊」. He was ADDING a payment, not editing the imported one.

**Root cause (traced).** A typed payment row is booked ONLY by its own Save
button on the row. The page's Save saves the document and leaves the row exactly
where it is.

The page does have a warning for unbooked rows — and it is wired to the payments
card's Done and to the page's BACK button, **and to nothing else**:
`guardUnsavedPayments` in `SalesOrderDetail.tsx` has three occurrences, its own
declaration and those two calls. Pressing **Save** never reaches it. So the
operator pressed Save, the order saved, the page left, and the money row went
with it — no error, no prompt, nothing recorded.

The production probe agrees: on HC-SO-013393 the audit log holds **zero** payment
actions of any kind (`probe-doc-writeback`, run 33375221382), and the only
payment on the order is the imported one from 2026-08-29, still at version 1.

**Fix (the owner's choice, asked and answered: 「我要按页面 Save 的时候，连同打好的
付款行一起存进去（不是只弹个提醒）」).** `PaymentsTable` hands the page an
awaitable `commitAllDrafts` through `onRegisterCommitAll`, and the page's Save
calls it **after** the document write — a payment must not be booked against a
save that did not happen. Every row keeps its own idempotency key, so a retry
after a partial failure de-dupes instead of booking the money twice.

A row that could not be sent at all (no amount, missing sub-field) is RETURNED as
blocked, never skipped — skipping in silence is the defect. Anything short of
"every row landed" keeps the page OPEN, because leaving is what discards them.

The stay-or-leave decision and its wording are one rule in
`vendor/scm/lib/payment-save-outcome.ts`, tested on its own: a 4,000-line page is
not where a consequence like that should live.

**Tests.** `payment-save-outcome.test.ts` — five cases: silent when there is
nothing to book, silent when everything booked, and the page STAYS with the row's
own reason named for a refusal, for an incomplete row, and for several.

**What is NOT covered by a test, said plainly.** The wiring itself — that Save
calls the registered commit — is held by the typechecker and by reading, not by a
mounted-page test; `SalesOrderDetail` has no rendering harness today and building
one for this was not attempted. The rule it calls IS tested.

**Ref.** fix/so-save-commits-payments, 2026-08-31.
