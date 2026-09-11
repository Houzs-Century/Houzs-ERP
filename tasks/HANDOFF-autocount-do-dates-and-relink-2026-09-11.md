# Handoff — AutoCount DO delivery dates + keyless-conversion relink (2026-09-11)

Updated 2026-09-11, third pass. **The open decision from the second pass is
CLOSED, and the premise the first repair rested on was measured WRONG. Read
Thread 1 before touching anything on this subject.**

Everything here was traced/observed against production unless labelled LIKELY/UNKNOWN.

---

## THREAD 1 — the delivery dates. ROOT CAUSE FOUND; the first repair was 28% wrong

### What the owner reported, and what is actually true

「Syu - HC12445. Pick DO at autocount before implement of ERP. Delivery date is
19/09. Pick DO on 05/09. now the ERP write down DO date 19/09 and cus delivery
date 05/09.」

PROVEN, by reading the live book read-only over ZeroTier
(`backend/scripts/export-ac-delivery-dates.py` against `AED_HOUZS`) and the live
ERP (the `.db-align` read-only DSN) in the same session:

| | AutoCount (live) | ERP (live, before this PR) |
|---|---|---|
| `SO-011302` line DeliveryDate | 2026-09-19 (all 3 lines) | `customer_delivery_date` 2026-09-05 — WRONG |
| `DO-011559` DocDate | 2026-09-19 | `do_date` 2026-09-19 — correct |
| `DO-011559` line DeliveryDate | 2026-09-19 (all 3 lines) | `line_delivery_date` NULL on all 3 — WRONG |
| the DO's delivery date | the line date, 2026-09-19 | `expected_delivery_at` = `customer_delivery_date` = 2026-09-05 — WRONG |

### The root cause — a STALE PULL, not a bad import

The committed 2026-08-11 snapshot `backend/scripts/data/ac-fidelity-so-lines.json.gz`
— which is what the import read — has `SO-011302`'s lines at **2026-09-05**. The
import was RIGHT when it ran. The customer moved the date, a staff member changed
it in AutoCount, and **nothing in the ERP reads that column a second time**:

- **Inbound**: `/DeliveryOrder/getSince/{checkpoint}` is a NINE-COLUMN HEADER
  projection (`backend/src/types.ts` `ACDeliveryOrder`) and the delivery date
  lives on the LINE (`SODTL/DODTL.DeliveryDate`). It is not in the full `getAll`
  dump either — that is header rows too.
- **Outbound**: `backend/src/scm/lib/autocount-outbox.ts` DOES map our
  `line_delivery_date` onto `SODTL.DeliveryDate`.

One-directional sync on one field is drift by construction. The DO cut from that
sales order then inherited the stale 05/09 through the SO -> DO carry, which is
why the two dates on the DO look swapped.

### The first repair (#3615) would have written a WRONG date on 65 documents

`repair-do-delivery-dates-to-autocount.mjs` set a linked DO's delivery dates to
its own `do_date`, premised on "the book's line delivery date equals its document
date (the norm)". That premise was recorded as a known caveat and never measured.
MEASURED 2026-09-11 across our 235 linked delivery orders: equal on 170,
**different on 65 (28%)**. `HC-DO-011559` read correct under it only because that
one document happens to have both dates equal.

**The script and its workflow are DELETED** so nobody can dispatch them from an
older copy of this handoff. It was never applied — plan run 34561432704 was
read-only.

### The OPEN DECISION from the second pass is CLOSED

It asked whether to revert the new-document half of #3615 (a new DO taking its
own `do_date` instead of the SO's customer date). The owner settled it the same
morning and it shipped as **#3623 (docs/bugs/0807-do-line-delivery-date-silently-dropped-by-payload-key-mismat.md)**: every date a new DO opens
with — `do_date`, `customer_delivery_date`, and every LINE's delivery date —
defaults to the SO's `customer_delivery_date`. 「我开 DO 之前我改 SO 就行 ……
当我开 DO 的时候，你就跟着 default 这个 date 来开」. Deployed (run head
`9b7bb66db`, `backend` job success). Nothing further to decide here.

That also makes **the SO the single place a date is edited**, which is why
keeping the SO in step with AutoCount is the thing that matters.

### Measured scale (company 1, AutoCount-linked, 2026-09-11)

| | total | agrees with book | DIFFERS | ERP blank | book lines disagree |
|---|---|---|---|---|---|
| sales orders | 2,939 | 600 | **100** | 39 | 2,205 |
| delivery orders | 237 | 152 | **81** | - | 4 |
| SO lines | 15,500 | - | **510** | 288 | - |
| DO lines | 859 | - | **850** | 850, all of them (bug 0807-do-line-delivery-date) | - |

Only **7** of 237 linked DOs have a `do_date` differing from the book's DocDate,
so the DOCUMENT date is fine; it is the DELIVERY date that drifted.

### What THIS PR ships

- `backend/scripts/export-ac-delivery-dates.py` — read-only export of the book's
  real `SODTL/DODTL.DeliveryDate`, per document and per `DtlKey`, to
  `backend/scripts/data/ac-delivery-dates.json.gz` (563 KB). READ UNCOMMITTED, so
  a wide read cannot starve the outbound write-back.
- `backend/scripts/repair-delivery-dates-from-book.mjs` +
  `.github/workflows/repair-delivery-dates-from-book.yml` — sets ERP header and
  line delivery dates from that column, keyed by `linked_ac_dtlkey` (never item
  code: the book keeps a sofa as ONE line). PLAN default,
  `CONFIRM=DELIV-DATES-FROM-BOOK`, fresh-connection shape verify.
- `DO_SALES_CARRY` and the hardcoded mirror of the same UPDATE in
  `migrated-do-writer.mjs` no longer set a delivery date at all — both values they
  could reach for are measured wrong. Pinned by
  `backend/tests/migratedDoSalesFields.test.mjs`.
- Ledger `docs/bugs/0810-*.md`, guide `docs/modules/delivery-order.md`.

### The repair is APPLIED (2026-09-11)

Actions -> **Repair delivery dates from the AutoCount book**, `mode=apply`,
`CONFIRM=DELIV-DATES-FROM-BOOK`. Plan run **34567150379** (success) reported the
same numbers as the local plan; apply run **34567236846** (success) wrote
**1,541 rows** in one transaction and re-read on a fresh connection: *"VERIFIED
on a fresh connection: 100 SO + 81 DO now hold the book's delivery date."*

Checked independently afterwards with the read-only DSN, on the document the
owner reported:

| | before | after |
|---|---|---|
| `HC-SO-011302` `customer_delivery_date` | 2026-09-05 | **2026-09-19** |
| `HC-DO-011559` expected + customer | 2026-09-05 | **2026-09-19** |
| its three line delivery dates | NULL | **2026-09-19** |
| `HC-DO-011559` `do_date` | 2026-09-19 | 2026-09-19 (untouched, already the book's) |

It took ~9 minutes: 1,541 statements, each its own round trip inside one
transaction. Nothing was blocked on it. **Do not re-run it to "check"** — it is
idempotent, but a second apply is nine more minutes of write locks for zero
rows; the plan mode answers the same question for free.

### FINISHED 2026-09-11 — every book date is now in the ERP, and the remainder is named

Three apply/plan rounds, all from Actions -> **Repair delivery dates from the
AutoCount book**:

| run | what | result |
|---|---|---|
| 34567150379 | plan | 100 SO, 81 DO, 510 SO lines, 850 DO lines to fix |
| 34567236846 | apply | **1,541 rows**; verified on a fresh connection |
| 34569351426 | plan, INCLUDE_BLANKS | 39 SO headers + 288 SO lines still blank where the book has a date |
| 34569433132 | apply, INCLUDE_BLANKS | **327 rows**; verified |
| 34569746197 | plan, INCLUDE_BLANKS | **to fix = 0 on all four** |

**The end state, and what is deliberately still not equal.** Checked
independently against the read-only DSN and the committed export:

- 2 sales-order lines carry `line_delivery_date_overridden = true` — an operator
  typed those on purpose and the repair refuses them. They are the ONLY lines
  left where the book has a date and we hold a different one.
- 11,597 sales-order lines and 9 delivery-order lines are still blank because
  **the book is blank too** (of 11,599 still-blank SO lines the book has a date
  for 2 — the two overridden ones; of 9 DO lines, none).
- 2,205 sales-order headers and 4 delivery-order headers hold no single date
  because THE BOOK'S OWN LINES DISAGREE within those documents. Their LINES are
  aligned, and `scm/shared/effective-delivery.ts` resolves a line with a blank
  header to `line_delivery_date` at step 4, so those orders now plan on the
  book's per-line dates. Giving the header the earliest of them is a product
  decision nobody has asked for; do not invent it.

Do NOT re-run `apply` to "check". It is idempotent, but a second apply is
minutes of write locks for zero rows; `plan` answers the same question free.

### What it deliberately does NOT touch

- rows with `amended_delivery_date` — a deliberate ERP amendment; if it disagrees
  with the book the fault is the write-back, not the pull;
- documents whose book lines disagree among themselves — no single value can be
  the header date, so only the LINES are repaired;
- **blank SO delivery dates (39 headers, 288 lines).** MRP gates on this field,
  so filling them changes what the floor sees and waits on the owner. Behind
  `INCLUDE_BLANKS=1` / the workflow's checkbox. Blank DO LINE dates ARE filled by
  default: those are bug 0807-do-line-delivery-date's residue and nothing upstream reads them.

### DO NOT DO THE HOST STEP — the owner retired the reason for it (2026-09-11)

An earlier version of this section told the next person to rebuild
`AcSyncService` on the office machine and switch the sweep on. **Do not.** The
owner, asked why the backfill was wanted: 「不需要每天啊 我只是要 backfill 一次
啊」 and 「autocount是没用了的」.

**What that means, and the distinction that matters.** Nobody KEYS DOCUMENTS in
AutoCount any more — staff work in the ERP, which is the go-live rule (the ERP is
the only editing surface). So there is no longer a stream of AutoCount-side
delivery-date changes for an inbound sweep to chase. The whole case for the
sweep was "the drift returns", and it does not return if nobody edits there.

**AutoCount is still RECEIVING, though, and that half is untouched.** Measured
2026-09-11 15:00 MYT, ERP -> book in the previous three hours: 29 `so_to_do`,
24 `so_to_po`, 40 SO `edit`, 4 DO `edit`, 2 `create_po`, newest
`HC-PO-2609-087` at 07:00Z. So it remains the account book and the write-back
stays live. "No longer used" means no longer EDITED BY PEOPLE, not disconnected.

**So the state to leave this in:**

- the one-time backfill is DONE and measured to zero (the section above);
- `/delivery-dates` on the host service and
  `scm/lib/autocount-delivery-date-sweep.ts` are MERGED and DEPLOYED but
  **deliberately asleep** — the `scm.app_config` row does not exist, and the host
  route does not exist either. Two independent reasons nothing happens. Leave
  both alone;
- **nobody needs to visit the office machine for this.** The rebuild buys an
  inbound sync for edits that will not be made.

**When this code WOULD earn its keep**, so it is not deleted by someone who did
not read this: if AutoCount is ever keyed by a person again — a parallel-run for
another company, a month someone works in the book during a cutover, an audit
correction made there — then the two steps in the git history of this file
(host rebuild, then the **Set AutoCount delivery-date sweep** workflow) turn it
on. Until that happens it is dormant, and dormant is the intended state.

**If a delivery date ever looks wrong against the book again**, the answer is one
manual pass, no host change: run `export-ac-delivery-dates.py` from the owner's
desktop (it needs ZeroTier), commit the snapshot, then the **Repair delivery
dates from the AutoCount book** workflow — `plan`, read it, then `apply`. It took
minutes today.

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
  **Thread 1 adds weight to this**: the same DtlKey-vs-item-code problem is why
  the new repair keys on `linked_ac_dtlkey` and never on the code.

**NEXT for Thread 2:** give the sweep an observable run-summary (per doc:
book-lines-read / stamped / refused-and-why) that a read-only workflow can print,
then re-run `plan` and read it. Then confirm the sofa hypothesis. The live book IS
reachable from this desktop (Thread 1 proves it), so reading it is no longer a
blind spot — `export-ac-delivery-dates.py` is the connection recipe.

---

## THREAD 3 — The date-comparison tool (main has a BROKEN copy)

`compare-ac-erp-dates` (PR #3600 merged) compares our DO/SO dates vs AutoCount's
two mirrors. **The version on `main` is buggy** (wrong schema, wrong column). The
WORKING version is on branch `chore/ac-erp-date-compare` (3 fix commits: mirrors
are in `public` not `scm`; `scm.delivery_orders` has `do_number` not `doc_no`;
find the DO by `so_doc_no`; ISO dates). **Next: delete the tool.** Thread 1
supersedes it and shows why it could never answer the question: it compares
against the MIRRORS, and `public.autocount_delivery_orders` holds `doc_date` only
while `public.ac_snapshot_sales_orders` is EMPTY — so its "70 linked DOs, 0
differ" was a true statement about DOCUMENT dates and blind to the delivery date
entirely. The mirror also does not contain `DO-011559` at all. Compare against the
book, not against the mirrors.

---

## Facts the next person should not re-derive

- **The live AutoCount book is readable from the owner's desktop**, read-only:
  `backend/scripts/export-ac-delivery-dates.py` (pyodbc, `SQL Server Native
  Client 11.0`, `10.147.17.100,55500`, `AED_HOUZS`, `AC_CRED_FILE`). Use
  `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` so a wide read takes no
  locks — a wide scan has starved the outbound write-back before.
- **The book's delivery date is on the LINE**: `SODTL.DeliveryDate`,
  `DODTL.DeliveryDate`. There is NO header delivery date on `SO` or `DO`, and no
  UDF holding one. `EstimatedDeliveryDate` exists on both detail tables and is
  NULL on every row (0 of 49,049 DO lines).
- **AutoCount mirrors live in `public`**, not `scm`: `public.autocount_delivery_orders`
  (mig 0215, DO headers, `doc_date` only), `public.ac_snapshot_sales_orders`
  (mig 0288, SO headers + `raw`, currently EMPTY). The SCM tables are in `scm`.
  The DO mirror is also INCOMPLETE — 11,276 rows and `DO-011559` is not among
  them.
- **`scm.mfg_sales_orders` has NO `id`** — it keys on `doc_no`, and
  `mfg_sales_order_items` joins by `doc_no`. `scm.delivery_orders` DOES have `id`,
  and `delivery_order_items` joins by `delivery_order_id`. Both item tables carry
  their own `company_id`, so a line-level scan needs no parent join.
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
  · #3600 date-compare tool (merged, buggy on main — DELETE it, see Thread 3)
  · #3615 DO delivery dates follow `do_date` (merged + deployed; **its repair was
  28% wrong, never applied, and is now deleted**)
  · #3623 DO dates default to the SO's date (merged + deployed — this closed the
  open decision)
