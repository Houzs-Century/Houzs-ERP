## Two identical sofa lines were corrected as one build, and the money check on a purchase order asserted nothing [high]

**Plain version for the owner.** 客人订两张一模一样的沙发，系统会把两张当成一张来
补；补完以后单上只剩一张。另外，采购单那边的「不能动到钱」的检查，其实检查的是一
个永远等于 0 的栏位 —— 它挡住了三张本来应该补的采购单，而真正的价钱它一次都没看过。

**Symptom.** Three defects, all in
`backend/scripts/apply-sofa-compartment-corrections.mjs`, found while preparing
the 2026-09 round of owner-approved sofa builds.

1. **Two identical lines became one sofa.** `HC-SO-013384` carries two
   `8030-1S` lines with byte-identical `description2`, and so does
   `HC-SO-012025` with its purchase order `HC-PO-009024`. Those are two
   identical sofas. The matcher returned both rows correctly; the pairing then
   dealt them onto the piece list as if they were two compartments of ONE build
   — row 1 became the first piece, row 2 the second, the third was inserted.
   One sofa where the customer ordered two, with no error and no refusal.
2. **The money check on a purchase order asserted nothing, and refused correct
   work.** Measured on prod (read-only DSN, company 1, 2026-09-04):
   `scm.purchase_order_items.line_total_sen` is **0 on all 289 company-1 sofa
   lines**, while `unit_price_sen` carries the price. The check compared the sum
   of that column (always 0) against a recomputed `unit x qty`, so it (a) could
   never have caught a real move — `0 == 0` passes for any price — and (b)
   refused every PO build whose lead line has a price. Three owner-approved
   2026-08 builds have been sitting refused because of it: `HC-PO-009597`
   (383,200 sen), `HC-PO-010117` (431,700), `HC-PO-010023` (421,500), plus two
   of the 2026-09 round, `HC-PO-009582` (183,200) and `HC-PO-009260` (254,000).
3. **A seat with a unit would have been stored as inches.** `HC-SO-003295`'s
   slip says `2S (60cm)`. `variants.seatHeight` holds bare inches — the live
   values across company-1 sofa lines are 22, 24, 25, 26, 28, 30, 31, 32, 35, 38,
   40 and null, with no unit anywhere — so `"60cm"` makes a numeric field
   non-numeric and `"60"` makes a 60-inch seat out of a 60-centimetre one.

**Root cause (traced, not guessed).**

1. The pairing loop had no concept of a build appearing more than once on a
   document. `desc2Match` deliberately selects every row of one build, and
   `selectBuildRows` is right to return both rows — one Desc2 is one build. What
   was missing is that one build can be ORDERED TWICE. Observed by reading the
   two documents on prod and by planning them through the old code path: the
   plan consumed both rows and inserted one piece, ending at three rows where
   six were owed.
2. `line_total_sen` on the PO table is written by nothing in the sofa import
   path; the price lives in `unit_price_sen`. This is the repo's documented "check
   that answers a different question" (CLAUDE.md): the successful result — sum
   0 before, sum 0 after — was ALSO true of every wrong plan. Counted directly:
   `SELECT (line_total_sen = 0), count(*) ... item_group = 'sofa'` returns a
   single row, `true / 289`.
3. The seat was written with `String(c.seat)` and no shape check at all.

**Fix.**

- `scripts/lib/sofa-build-plan.mjs` (new, pure, tested) holds the three
  decisions: `splitBuildCopies` turns N placeholder lines under one Desc2 into N
  sofas and REFUSES the one case it cannot read (several placeholders sitting
  beside rows that are already correct pieces — nothing says which sofa those
  belong to); `planCopyMoney` asserts **both** money columns and RECOMPUTES
  NOTHING, the lead piece keeping the lead row's own `unit_price_sen` and its own
  total verbatim while every other piece goes to 0; `seatHeightToWrite` writes a
  seat only when it is a bare number of inches and says so in the operator's log
  when it does not.
- `scripts/lib/sofa-corrections-source.mjs` (new, pure, tested) loads EVERY
  corrections file rather than one. The 2026-08 file stays the record of the
  cutover round — re-running is inert on it only while it is still loaded — and
  2026-09 is a second file beside it. The two name their array differently
  (`corrections` vs `entries`); the loader reads either, because editing
  owner-approved data to fit a loader is the wrong direction.
- The script now also REFUSES a build whose downstream actually moved stock: a
  GRN or DO that is not `migrated_no_stock`, or any `scm.inventory_movements`
  row naming the document. It used to assert this in a comment.
- An APPLY run now ends by re-reading every corrected document **on a fresh
  connection** and asserting the piece MULTISET and both money columns — not a
  row count, which is the check that passed while the pieces were wrong.
- The workflow gains a `file` input so one round can be applied without
  re-opening the other, and its header comment — which described creating
  `scm.special_addons` codes, a copy-paste from `add-missing-sofa-fabrics.yml` —
  is replaced by what the job actually does.

**Proved.** `node --test scripts/lib/*.test.mjs`. The two-sofa defect is pinned
from both sides: one test asserts the split, and a second asserts what the OLD
pairing did with the same rows (`["ade292ec", "68958b94", null]` — both rows
consumed by one build) so the shape cannot come back silently.

Dry-run against prod, 2026-09 round, before applying: 15 documents planned,
18 sofas, 0 refused for money, 1 refused for an un-minted SKU
(`5526-L(LHF)`, HC-SO-000814), 1 seat not written (HC-SO-003295, `60cm`). The
2026-08 round re-planned in the same run is **inert on every build already
written** — every line reads `keep`.

**Two things this deliberately does NOT do**, so the next reader is not
surprised:

- The three 2026-08 purchase orders un-blocked by the money fix
  (`HC-PO-009597`, `HC-PO-010117`, `HC-PO-010023`) are **not applied here**.
  They are correct and owner-approved, but they are a different round; they can
  be dispatched on their own with `file=2026-08`. UNTESTED as an operation —
  they have only been planned, not run.
- `HC-SO-000814` stays a placeholder. Its build needs `5526-L(LHF)`, which does
  not exist in `scm.mfg_products` (5526 has 1A(LHF), 1A(RHF), 1ABOX(LHF), 1NA,
  1S, 2A(LHF), 2A(RHF), 2S, Console, DB, STOOL and no chaise). Minting a product
  code is a master-data decision with a name and a tier behind it, and it is not
  this script's to make.

**Ref.** `fix/sofa-1s-builds-2026-09`, 2026-09-04.
