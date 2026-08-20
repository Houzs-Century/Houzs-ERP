## The sofa purchase orders were never dedicated, and the delivery dates were lost to a renamed key [high]

**Symptom** — 274 of 714 processed bedframe/sofa sales-order lines (38%) have no
dedicated purchase order. Measured live on 2026-08-10 rather than taken on
trust: **400 of 975** `scm.purchase_order_items` rows carry `so_item_id IS
NULL`, of which the existing three-tier backfill can stamp **zero** (Tier 1/2/3
all 0; 392 have no delivered chain and no usable note). Separately **110** of
the 864 migrated PO lines and **48** headers show a blank EXPECTED DELIVERY
although AutoCount has a date on every line, and `backfill-po-expected-at.mjs`
cannot rescue them — its own production dry-run says so in one line: `can be
filled from their own lines: 0; still blank because no LINE carries a date
either: 48`. It derives the header from the LINES, and the lines are the thing
that is null.

**Root cause, traced not guessed** — three faults on the same rows, and the
first theory was REFUTED before any of them was found. It is NOT that the sofa
compartment decoder fails: 184 sofa PO-to-SO pairs share the same AutoCount
ItemCode 184/184 and the same `Desc2` 182/184, and decoding all 126 sofa lines
gives ZERO cases of "the PO fails where the SO succeeds".

1. **`import-ac-outstanding-po.mjs`'s INSERT column list has no `so_item_id`.**
   Not a broken lookup — no column. `grep so_item_id|FromSODtlKey` in that file
   returned nothing. The script that DOES dedicate,
   `import-ac-so-linked-pos.mjs`, then skips a document whole when it already
   exists ("PO docs in file: 366; already in ERP: 267"), so it never went back
   for the 267 the first importer had created. In the whole log of run
   31359369768 the string `009830` appears zero times.
2. **A renamed export key.** The same importer read `l.DelivDate` at three
   sites. The snapshot was re-cut in `a5f51653` (PR #1779) with the key
   `DeliveryDate`: 0 of 338 rows carry `DelivDate`, 338 of 338 carry
   `DeliveryDate`. Reading an absent key is `undefined` in JavaScript, not an
   error, so every line imported blank and nothing anywhere said so.
3. **The line key was computed and thrown away.** `import-ac-so-linked-pos.mjs`
   builds `dtlKey: Number(l.DtlKey)` at three sites; its INSERT has 21 columns
   and none of them is it. `PODTL.DtlKey` is the PRIMARY KEY of AutoCount's PO
   detail table and all 738 keys in the committed snapshots still resolve in the
   live AED_HOUZS book (checked read-only over ODBC), so a durable handle was
   discarded and every later repair has had to re-derive the link by matching.

Both hops work when you walk them. For `HC-PO-009830`:
`soLineByDtl.get("773519")` -> `SO-011207` / `HOK-5530 SOFA`, and
`SOFA_MODEL_ALIAS` 5530->9028 decodes the same `Desc2` to `9028-2A(LHF)` +
`9028-L(RHF)` — exactly the two rows already on that ERP purchase order.

**Fix** — one repair over the same rows, `repair-migrated-po-lines.mjs` +
`.github/workflows/repair-migrated-po-lines.yml`, DRY-RUN by default: it stamps
`so_item_id`, `delivery_date` and `linked_ac_dtlkey` per line and then the
header's `expected_at`, every UPDATE re-asserting the column is still NULL so a
re-run plans nothing. Both importers are fixed too, not only the data: the
date is read through `scripts/lib/ac-po-line.mjs`, the dedication through the
SHARED `scripts/lib/so-line-dedication.mjs` (the taker was extracted from the
one script that had it right), and both now write `linked_ac_dtlkey`
— **#1819's `0273` already added exactly that column**, so this PR adds no
migration of its own; a second column would have been the real mistake.
Recovering which ERP row descends from which AutoCount line lives in `scripts/lib/ac-po-line-match.mjs`
and refuses rather than guesses: a group whose two sides do not split the same
way is refused whole, and so is one whose AutoCount lines disagree on anything
the repair would write.

**The zip's premise was FALSE, and review caught it before it wrote anything.**
The first version of this fix zipped "indistinguishable" rows in `DtlKey` order,
justified as *"identical on every field the ERP stores... any bijection is the
same set of facts."* That is true of the ERP rows and false of the AutoCount
lines, which is the side every written value is read from. Measured against the
committed snapshots: **all 5 surviving buckets (10 AutoCount lines) carry
DIFFERENT `FromSODtlKey`s** — `PO-000290` 60700/60702, `PO-009024`
829179/829180, `PO-009596` 871212/871213, `PO-009746` 796552/796553, `PO-009767`
887681/887682. Delivery dates agree in all 5, so `delivery_date` was never at
risk; `so_item_id` and `linked_ac_dtlkey` were a coin flip on 12 rows. Worse,
`PO-000290`'s two keys resolve to two different PRODUCTS on one order (60700 ->
`SO-000870` "MYLATEX LUMBARIA (K)", 60702 -> `SO-000870` "NB-KHJ57(K)"). The fix
refuses any bucket whose AutoCount lines disagree on `FromSODtlKey` or
`DeliveryDate` and prints both candidates; on today's data that repairs 0 of
those 12 rows.

**The class** — *"the rows are indistinguishable" is a claim about ONE side of a
match, and the side you are copying FROM is the one that has to be checked.*
Two corollaries were fixed in the same pass. The `base` fallback could bind a PO
line for product A to an SO line for product B, defended by a comment claiming
the importer makes the same attempt — it does not: `import-ac-so-linked-pos.mjs`
uses `base` only and never the PO row's own code. (Re-measured on the snapshots
2026-08-11: exactly **1** of 579 resolvable lines is cross-product —
`PO-000290` DtlKey 61216 `NB-KHJ57(K)` -> ERP `CODY-(K)`, pointed by
`FromSODtlKey` at `SO-000870` "MYLATEX LUMBARIA (K)" -> ERP
`LUMBARIA MATT (K)`. So the guard costs one link today and that link would have
been the only wrong write.) That decision is no longer inline prose in the
script: it is `dedicationCandidates()` in `scripts/lib/so-line-dedication.mjs`,
one implementation with its own tests, so the rule and the comment defending it
cannot drift apart again. And the zip's tie-break sorted a serial `id` with
`localeCompare`, so ids `[9,10,11,12]` order as `[10,11,12,9]` and split a
sofa's compartment rows across different AutoCount lines; it sorts numerically
now.

**Guards, each proven by breaking it** (`tests/acPoLineRepair.test.mjs`, 24
tests, all passing): disable the coin-flip refusal -> **3 fail** (18/21 before
the cross-product tests were added); drop the `sameProduct` gate so `base` is a
blanket attempt again -> **1 fails** (23/24); restore the `localeCompare` row
sort -> **1 fails**; point the date accessor back at the old `DelivDate` key ->
**3 fail**. A test that does not fail without its fix proves nothing, so each
was run both ways rather than asserted.

Two smaller faults from the same review: `i.cancelled = false` (three queries)
silently dropped NULL-cancelled SO lines out of a **claim-once** pool, which
both under-repairs and can hand a different line to the next PO row — this repo
reads the column as nullable everywhere else, `check-po-so-links.mjs` (the
checker for this exact link) included, so all three now use
`COALESCE(cancelled, false) = false`. And the APPLY log reported `plan.length`
as the RESULT; it now prints the three affected-row counts the database returns.

**The class, for next time** — *a field you read by name from a file you did not
write is a silent dependency, and JavaScript will not tell you when it breaks.*
Reading a renamed key produced `undefined`, which flowed all the way into a
`NULL` column with no error, no warning and no failing test — the same shape as
the five-copies-of-findColour entry above, one layer earlier. The guard is
`tests/acPoLineRepair.test.mjs`, which asserts the accessor still resolves on
every row of the COMMITTED snapshots (917 rows). A fixture would never have
caught this, because a fixture carries whatever key the test author typed;
revert the accessor to `DelivDate` and that test fails 338 + 579 times. The
second half of the class: *a column missing from an INSERT is invisible to
every reader* — nothing downstream can distinguish "never written" from
"genuinely absent", which is why the second importer's skip-if-exists looked
correct while it was silently the reason nothing ever went back.

**The production DRY-RUN, MEASURED after all the review fixes** — 2026-08-11,
read-only, `APPLY` hardcoded to `0`
([run 31457184673](https://github.com/hello-houzs/Houzs-ERP/actions/runs/31457184673)):

```
migrated purchase orders: 449; their lines: 864
  lines missing so_item_id 374; missing delivery_date 110; missing linked_ac_dtlkey 589
matched: sole 657; split by (qty, Desc2) 127; indistinguishable, zipped in DtlKey order 0
PLAN: 551 line(s) to update - so_item_id 95; delivery_date 83; linked_ac_dtlkey 509
       new dedications by item group: sofa 62; accessory 27; bedframe 6
       45 header(s) to give an expected_at; 17 of them are in the PAST
REFUSED groups: 6      NOT REPAIRED - every line, with its reason: 302
```

Every one of the 551 is printed individually, and the printed list tallies to
exactly `95 / 83 / 509` — the plan is built ONCE and both the log and the writer
consume that same array, so the dry-run cannot claim one thing and write
another. **`indistinguishable, zipped in DtlKey order 0`** is the coin-flip
refusal working: all 5 buckets are refused, plus `HC-PO-009620`.

The earlier `796 / 87 / 99 / 46` were the PRE-FIX figures and, as predicted,
every one moved DOWN. The line-key drop is the largest and is NOT this PR's
doing: 275 of the 864 were keyed by another script the day before (below).

**Dispatching it did not require merging.** A `workflow_dispatch` is resolved to
a workflow by its PATH on the default branch but RUNS the file content at the
requested ref. So the dry-run was dispatched at a throwaway ref that borrowed the
path of `po-so-links-check.yml` — an on-main, no-input, read-only check in the
same PO<->SO domain — whose content at that ref ran this repair with `APPLY`
hardcoded to the literal `"0"` and no input able to override it. The ref was
deleted as soon as the run was read. `repair-migrated-po-lines.yml` itself still
cannot be dispatched until it is on `main`, which remains true and is why the
technique was needed:

```
$ gh workflow run repair-migrated-po-lines.yml --ref fix/po-dedication-and-dates -f target=prod -f apply=0
HTTP 404: workflow repair-migrated-po-lines.yml not found on the default branch
```

**FIVE WRONG LINE KEYS ARE LIVE IN PRODUCTION RIGHT NOW, and they are not this
PR's.** On 2026-08-10 `backfill-ac-line-keys.mjs` ran in APPLY mode against
production (run 31416597720) and wrote 275 purchase-order `linked_ac_dtlkey`
values by a weaker rule: a match on (DocNo, ERP item code) zipped by a `line_no`
it selected as `NULL::int`, so the sort was a no-op and the pairing was whatever
order postgres returned. This repair's `IS NULL` guard skips those 275 — correct,
it must never overwrite a value it did not write — but it now AUDITS them:
**270 agree, 5 DISAGREE.** All 5 are permutations within a document, and the
evidence is the ERP row's own `Desc2`, copied verbatim by the import, matching
the DERIVED line's `Desc2` exactly:

| PO | row | stored | derived | evidence |
|---|---|---|---|---|
| HC-PO-009770 | HAPPI SLEEP SOLITUDE MATT (Q) x3 | 889395/889396/889397 | 889397/889395/889396 | `Desc2` names three different roadshow venues; each row's text matches its DERIVED line |
| HC-PO-009722 | CODY-(Q) x2 | 884635 / 884637 | 884637 / 884635 | `M'GP:10"` vs `M'GP:14"` — swapped; and the two lines carry DIFFERENT `FromSODtlKey` (884180 / 778589) |

A wrong `DtlKey` is not a cosmetic difference: migration 0273's own header says
`AcSyncService` dereferences it on the edit path, and a wrong one makes it
**APPEND** a line to the live account book instead of editing the one the
operator changed. **This repair neither writes nor reverts them** — nothing is
ever deleted here — it reports them for an owner ruling.

**The "589 are decomposed sofa compartments" hypothesis is REFUTED as the
explanation**, though the mechanism is real. That run's `no AC match 589` is
re-derived here as exactly **589** against the same two files and the same
mapping CSV, then given a reason each:

```
464 x the AutoCount document is only in ac-so-linked-pos.json.gz, which the
      code match never opens (it reads ac-outstanding-po.json.gz alone)
 65 x the ERP row is a COMPARTMENT of a decomposed line
 46 x the AutoCount document is in NEITHER committed PO export
 11 x the AutoCount ItemCode has no row in autocount-erp-mapping-1561.csv
  3 x document and item are both mapped, but no line maps to this material_code
by item_group: bedframe 315; sofa 215; accessory 26; mattress 22; others 11
DECOMPOSED COMPARTMENT? asked of every row: yes 173; no 336; unanswerable 80
```

**79% of the gap has nothing to do with item codes.** The dominant cause is
file scope: that script opens ONE of the two committed PO exports, so 464 lines
were invisible to it whatever their SKU — a plain mattress line on such a
document fails identically. The largest `item_group` is **bedframe (315)**, not
sofa, and **0** bedframe rows are compartments. The compartment mechanism is
real and accounts for **173** rows (all sofa — 173 of the 215 sofa lines), which
is 29% of the 589, not the explanation for it.

Note the two compartment numbers differ on purpose: the reason list says 65
because `codeMatchGapReason()` returns the FIRST cause that applies and the
document-level causes are tested first — correctly, since an unopened document
fails whatever the code is. Read as the answer, 65 would understate; the census
therefore asks `isCompartmentSku` of every row independently, and keeps
"unanswerable" (80 rows this repair cannot reach either) distinct from "no",
because an unreachable row is not evidence in either direction.

This repair reaches **509 of the 589** the code match could not.

**Ref** — 2026-08-10 / re-verified 2026-08-11, PR #1905
(fix/po-dedication-and-dates).
