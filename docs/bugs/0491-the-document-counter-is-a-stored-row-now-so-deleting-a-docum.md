## The document counter is a stored row now, so deleting a document no longer returns its number [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 单据号码以前是「看现有单据的最大号 + 1」算出来的。把单据删掉，最大号就掉
回去，同一个号码会再发一次 —— 而 AutoCount 账本永远记得那个号码，所以它会拒收
（`Primary Key Error`）。现在改成一张计数器表：号码只往上加，删单据不会把号码还回
来。中间断号是正常的，AutoCount、SAP、Odoo、NetSuite 全部都这样。Houzs Century 这个
月的起点已经调到账本已有号码的上面，每一格都写着凭据是哪一份文件。

**Symptom.** On 2026-08-20 the AutoCount Sync page refused four documents with
three words: `Primary Key Error`. The ERP had minted `HC-SO-2608-001`,
`HC-SO-2608-002`, `HC-PO-2608-001` and `HC-PI-2608-001` a SECOND time; the
licensed AED_HOUZS account book had held those numbers since 2026-08-14/17.
AutoCount was right to refuse them. Diagnosed in entry 0480 and
`docs/doc-number-reissue-coe.md`; this entry is the FIX.

**Root cause (traced).** `nextMonthlyDocNo` (`backend/src/scm/lib/doc-no.ts:18`)
returned `max(suffix) + 1` over the rows that STILL EXISTED for the month, fed by
`fetchMonthlyDocNos`' `LIKE '<prefix>-%'` scan. There was no sequence and no
counter table: **the surviving rows WERE the counter.** The file's own header
anticipated a deleted MID-month row (max+1 steps over the gap) and not a deleted
TOP-of-month row, which lowers the max and hands that number straight back.
`golive-wipe-hc.mjs` then did exactly that, deliberately and in writing — its
header said *"deleting HC's document rows IS the reset"*.

A counter derived from live data is not a counter, it is a query, and a query
answers whatever the data currently says. The unexamined assumption was that the
surviving rows are a faithful record of what was ISSUED. The moment a number
leaves the ERP for a second namespace nobody wipes, they are not.

**Fix.** `scm.doc_number_counters` (migration 0316) — one row per SERIES, where
a series is the doc number without its `-NNN` tail (`HC-SO-2608`, `TRIP-2608`,
`JE-2608`). That string is the namespace the number lives in, so keying on it
needs no company id and no special case for TRIP, which carries no company prefix
and stays ONE sequence shared by both companies. `scm.next_doc_no_n(series,
floor)` claims the next number in a single `INSERT … ON CONFLICT … DO UPDATE …
RETURNING`, so two concurrent saves cannot read the same value.

Changed INSIDE `mintMonthlyDocNo`, so all 29 call sites inherit it untouched;
`nextJeNo` takes the same counter and keeps its 4-pad. The live-row scan stays as
a FLOOR — the answer is `GREATEST(counter, floor + 1)` — which is what lets a
series the seed never covered self-seed from its own live max instead of
restarting at 001, and which makes the 1000-row PostgREST truncation trap
documented in `doc-no.ts` unable to cause a re-issue any more: a truncated read
returns a LOW floor, and a low floor is now harmless.

**Gaps are the point.** AutoCount, SAP (NRIV), Odoo (`ir.sequence`) and NetSuite
all store a counter, never re-derive one from surviving documents, and all four
accept gaps. Ours was the only one that re-derived. There is deliberately no
gap-filling.

**The seed is where the risk was, so every value names its source.** Seed 1 is
the live max per minter-owned column (which is why 2990, never wiped, lands on
exactly the number it would have minted today). Seed 2 is `scm.autocount_outbox`
plus `public.autocount_delivery_orders`, the DO mirror pulled FROM the book.
Seed 3 is the only hardcoded part — the numbers AED_HOUZS is evidenced to hold,
each row's `seed_source` naming its `ac-live-proof.json` entry. `HC-GRN-2608` is
the one value that is NOT book evidence and its source row says so in words.

**Test.** `backend/tests-pg/docNoCounter.pg.test.ts`, 13 tests against real
PostgreSQL (CI's `postgres:16` service, `npm run test:pg`; SKIPPED without
`TEST_DATABASE_URL`). The RED is IN THE FILE: every assertion about the new
behaviour is paired with the PRE-COUNTER answer computed by `nextMonthlyDocNo`,
which is still exported and still returns what shipped before — so the test shows,
on the same rows, the number the old minter would have handed back
(`expect(nextMonthlyDocNo('HC-SO-2610', survivors)).toBe('HC-SO-2610-003')`
beside `expect(next).toBe('HC-SO-2610-004')`). Concurrency is proved with real
contending transactions — one holds its row lock while a second blocks on it —
and with 40 claims across 8 separate connections coming back as 1..40 with no
repeat. A mocked client cannot contend for a row, which is why none of this is a
unit test.

**Ref.** `fix/doc-no-counter-table`, 2026-08-21. Supersedes the "NOT SHIPPED"
line in entry 0480. `docs/doc-number-reissue-coe.md`, production seed measured
read-only in run 32454881949 (section G).
