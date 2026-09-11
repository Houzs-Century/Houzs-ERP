# Handoff — AutoCount DO delivery dates + keyless-conversion relink (2026-09-11)

Updated 2026-09-11 evening. The DO-delivery-date code is **MERGED and LIVE in
production**, but the owner has raised an **open decision** (whether to revert the
NEW-document half) and asked for a handover. **Read "THE OPEN DECISION" first and
resolve it with the owner before doing anything else on Thread 1.**

Everything here was traced/observed against production unless labelled LIKELY/UNKNOWN.

---

## THE OPEN DECISION (owner asked "是不是要revert", then asked for handover)

The owner's goal was always: **the OLD documents that were imported from AutoCount
don't tally with AutoCount, and those need to match.** He was NOT asking to change
how NEW documents behave. PR #3615 changed BOTH, and after it shipped he asked
whether the new-document half should be reverted.

**What the fix changed, in three parts:**

1. **NEW-document path** (`backend/src/scm/routes/delivery-orders-mfg.ts`, the
   SO->DO conversion): a newly-created delivery order now sets both delivery-date
   fields to its own `do_date` (= today = what gets written to AutoCount), instead
   of the sales order's customer-requested date. **This is the part the owner is
   questioning.** IT IS LIVE.
2. **IMPORTED/migrated-document path** (`backend/scripts/lib/customer-block.mjs`
   `DO_SALES_CARRY` + `backend/scripts/lib/migrated-do-writer.mjs`): an imported DO
   now takes its delivery dates from `do_date` (= AutoCount's DocDate). The owner
   DOES want this — it is the fix for his original complaint.
3. **One-time repair of the 113 existing wrong rows** (see Thread 1 below).
   **NOT YET RUN** beyond a read-only plan.

**The tension, plainly.** For an IMPORTED doc, the delivery date showing the
customer's old date (05/09 instead of AutoCount's 19/09) was a genuine defect —
fix it. For a NEW doc, the "customer delivery date" showing the customer's
requested date is arguably CORRECT information, not a defect — forcing it to the
document date removes a real planning field (the customer's original ask still
lives on the sales order, so it is not lost, but the DO no longer shows it).

**Options (owner decides — this is a product judgement, not a provable defect):**

- **Option A — keep as shipped.** New + imported + existing all show `do_date`
  (= AutoCount). Pro: one consistent date everywhere, which is literally
  「全部要跟 autocount」 and kills the two-different-dates confusion that started
  this. Con: a new DO no longer surfaces the customer's requested delivery date.
  Then: run the 113 repair (below).
- **Option B — revert ONLY the new-document half (part 1), keep parts 2 + 3.**
  New DOs again default their delivery dates to the customer's requested date;
  imported/existing DOs still get aligned to AutoCount. Pro: preserves the
  planning field for new docs. Con: a doc created tomorrow behaves differently
  from the near-identical recent docs the 113 repair just forced to `do_date`
  (the HC-DO-2609-* rows) — an inconsistency someone will ask about.
- **Option C — revert everything, do NOT run the repair.** Back to before this
  change. REJECTED by the owner's own original complaint (HC-DO-011559 showing
  05/09 is exactly what he said "不太对"), so this is not really on the table.

**Recommendation: confirm the new-doc intent with the owner in one question —
"新开的单,交货日期要显示 AutoCount 的单据日期(A),还是保留客户要求的日期(B)?"**
Both are cheap and low-risk (a display/default field, fully reversible). His
recent messages ("新开的不利啊", "不关新的单事情") lean toward **B**; his standing
ruling 「全部要跟 autocount」 reads as **A**. He is the only one who can settle it.
**Until he does, do NOT run the 113 apply** (it hard-codes direction A onto 113
live documents).

### Exact steps once he decides

**If A (keep):** nothing to change in code. Run the repair — Actions ->
**Repair DO delivery dates to follow AutoCount** -> `mode=apply`,
`confirm=DO-DATES-FOLLOW-AUTOCOUNT`. Plan already showed 113 rows (below).

**If B (revert new-doc half only):** in
`backend/src/scm/routes/delivery-orders-mfg.ts`, the conversion insert
(`createDoFromSoLinesHandler`, ~L3976) currently reads:
```
expected_delivery_at: today, // both delivery dates = the DO's own date ...
customer_delivery_date: today,
```
Restore the pre-#3615 default:
```
expected_delivery_at: (head.customer_delivery_date as string | null) ?? today,
customer_delivery_date: (head.customer_delivery_date as string | null) ?? null,
```
Leave parts 2 + 3 (imported writer + repair) as they are. Update
`backend/src/scm/routes/doDeliveryDateFollowsAutocount.test.ts` (it pins the
new-doc conversion to `today`; that pin must change or be dropped for the
conversion half), and note the reversal in `docs/bugs/0804-*.md`. Then decide WITH
the owner whether the 113 repair still runs for the imported subset only (it
currently targets all AutoCount-linked rows, including the recent HC-DO-2609-*).

---

## THREAD 1 — DO delivery dates follow AutoCount (PR #3615) — MERGED + DEPLOYED

**Business problem.** A delivery order showed the customer's ORIGINAL requested
date as its delivery date instead of AutoCount's. `HC-DO-011559` (customer ref
HC12445): ERP showed Expected/Customer = **05/09**; AutoCount `DO-011559` and the
DO's own document date said **19/09**. Owner 2026-09-11: 「全部要跟 autocount」.

**Root cause (PROVEN, code-traced).** Two paths seeded the DO's
`expected_delivery_at` + `customer_delivery_date` from the SALES ORDER's
`customer_delivery_date` (a deliberate 2026-09-08 default, docs/bugs/0716/0723):
the SO->DO conversion, and the migrated-DO backfill (`DO_SALES_CARRY`). For an
IMPORTED doc the `do_date` came in correct (= AutoCount DocDate) but a later
"fill the blank header fields from the SO" step (2026-09-08, when DOs opened to
staff) overwrote the delivery-date fields with the customer's ask.

**What PR #3615 shipped (MERGED 04:12Z, DEPLOY run 34561313825 = success,
`backend` job = success -> LIVE).** All three parts above. Bug ledger
`docs/bugs/0804-a-delivery-order-showed-the-sales-order-s-customer-date-as-i.md`,
guide `docs/modules/delivery-order.md`, pinned by
`backend/src/scm/routes/doDeliveryDateFollowsAutocount.test.ts` +
`backend/tests/migratedDoSalesFields.test.mjs`.

**The CI-red detour (why this took a second pass).** The first push was RED on the
required `backend-typecheck` (test:light) and I had wrongly recorded it as "queued
green". Changing the SHARED list `DO_SALES_CARRY` missed two things bound to it:
`migrated-do-writer.mjs` HARDCODES the same UPDATE (mirror, not import) and a
pinned test (`migratedDoSalesFields.test.mjs`) asserted the OLD expression. Also
`file-size` (a grown comment) and `working-agreement` (the guide quoted
`customer-block.mjs` without the `backend/` prefix, so the gate matched only
sales-order.md). All fixed; full CI green; merged. **Lesson: when a shared const
list changes, grep EVERY binding — hardcoded SQL mirrors AND pinned tests — and
run the full `test:light`, not just the new test file.**

### The one-time repair — PLANNED, NOT APPLIED (blocked on THE OPEN DECISION)
Existing rows need a catch-up. Read-only plan run **34561432704** (2026-09-11
04:14Z) reported:
- **113** AutoCount-linked delivery orders whose delivery dates differ from their
  own `do_date` — all **company 1 (HC)**.
- Samples: `HC-DO-011559` 05/09 -> 19/09 (the flagged one), `HC-DO-011558`
  08/29 -> 09/19, `HC-DO-011557` 08/03 -> 09/19, and a batch of recent
  ERP-created `HC-DO-2609-*` 09/11 -> 09/10.
- The 113 is a MIX: mostly imported (`HC-DO-011xxx`, AutoCount's own number) plus
  a handful of recent ERP-created (`HC-DO-2609-*`, written back to AutoCount) that
  caught the same bug before the fix deployed. (Exact split not yet counted.)

Script `backend/scripts/repair-do-delivery-dates-to-autocount.mjs`; scope
`linked_ac_docno IS NOT NULL AND (expected_delivery_at IS DISTINCT FROM do_date OR
customer_delivery_date IS DISTINCT FROM do_date)`; sets both = `do_date`; verifies
zero remain on a fresh connection. Workflow
`.github/workflows/repair-do-delivery-dates.yml`, plan by default, apply needs
`CONFIRM=DO-DATES-FOLLOW-AUTOCOUNT`.

**Known caveat.** AutoCount's per-LINE delivery date is not mirrored (the header
pull carries only DocDate); `do_date` is the faithful proxy, right whenever
AutoCount's line delivery date = its doc date (the norm, and true for HC-DO-011559).

---

## THREAD 2 — Keyless-conversion relink: Fix A (DONE) + the sweep (SHIPPED, did NOT clear the docs)

**Fix A (MERGED + DEPLOYED).** "Match up lines" works for DO/GR/IV/PI now
(`backend/src/scm/routes/autocount-relink.ts`). Ledger 0792.

**The hands-free sweep (PR #3598, MERGED + DEPLOYED, currently OFF).**
`backend/src/scm/lib/autocount-relink-sweep.ts` on the 5-min cron, gated by
`scm.app_config 'scm.autocount_relink_sweep'` (off/plan/apply), set via the
**Set AutoCount relink sweep** workflow. Ran apply 2026-09-11 ~01:20Z: **nothing
changed** (5 keyless docs stayed keyless, before == after, no duplicates, no
harm). Flag set back to OFF.

**Why it didn't work — still UNKNOWN, needs a clear re-diagnosis.**
- NOT the office PC being off — the inbound pull is HEALTHY (autocount-pull-health
  0 days behind), so the host is reachable. (I claimed "off" once; it was wrong.)
- Blind spots: `wrangler tail autocount-sync-api` is DENIED for this token (no
  tails scope), so the sweep's cron logs are invisible; and the live book was not
  read.
- LIKELY cause: **SOFAS.** GRN-2609-008 (8060-*) and DO-2609-020 (9028-*) are
  per-compartment lines in our ERP but AutoCount keeps a sofa as ONE line
  (memory `sofa-is-one-book-line`), so item-code matching can't pair them.

**NEXT for Thread 2:** give the sweep an observable run-summary (per doc:
book-lines-read / stamped / refused-and-why) that a read-only workflow can print,
then re-run `plan` and read it. Then confirm the sofa hypothesis.

---

## THREAD 3 — The date-comparison tool (main has a BROKEN copy)

`compare-ac-erp-dates` (PR #3600 merged) compares our DO/SO dates vs AutoCount's
two mirrors. **The version on `main` is buggy** (wrong schema, wrong column). The
WORKING version is on branch `chore/ac-erp-date-compare` (3 fix commits: mirrors
are in `public` not `scm`; `scm.delivery_orders` has `do_number` not `doc_no`;
find the DO by `so_doc_no`; ISO dates). **Next: land those fixes on main, or
delete the tool** — it served its purpose (answered the date question: across all
70 AutoCount-linked DOs, document dates match AutoCount, 0 differ; the SO snapshot
`ac_snapshot_sales_orders` is EMPTY so SO comparison is blind).

---

## Facts the next person should not re-derive

- **AutoCount mirrors live in `public`**, not `scm`: `public.autocount_delivery_orders`
  (mig 0215, DO headers, `doc_date` only), `public.ac_snapshot_sales_orders`
  (mig 0288, SO headers + `raw`). The SCM tables are in `scm`.
- **`scm.delivery_orders`** keys on `do_number` (no `doc_no`); AutoCount link via
  `linked_ac_docno`; SO link via `so_doc_no`. A migrated/imported DO carries
  `linked_ac_docno` = AutoCount's own number; an ERP-created DO written back
  carries its own `HC-DO-2609-*`.
- **The office AutoCount PC is reachable** (pull healthy). Do not infer "off" from
  a quiet send window.
- **`wrangler` is authed** (weisiang329@gmail.com) but **`wrangler tail` is denied**
  (token lacks the tails scope).
- **Required CI checks = `backend-typecheck` + `frontend` only.** `working-agreement`,
  `file-size`, `completeness-claim` report but do NOT block. `test:light` runs
  inside `backend-typecheck`, so a pinned-source test failing there DOES block.
- **Merge = MERGE method, via auto-merge; branch auto-deletes on merge (verified).**
  Update a behind branch by merging `origin/main` LOCALLY, never the button.

## PRs from this work
- #3584 Fix A relink DO/GR/IV/PI (merged) · #3598 relink sweep (merged, flag OFF)
  · #3600 date-compare tool (merged, buggy on main; fixes on `chore/ac-erp-date-compare`)
  · #3615 DO dates follow AutoCount (MERGED + DEPLOYED) — **repair NOT run;
  new-doc half pending owner's keep/revert decision.**
