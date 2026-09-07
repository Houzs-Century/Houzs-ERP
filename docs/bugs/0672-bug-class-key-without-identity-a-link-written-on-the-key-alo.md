## BUG CLASS - key-without-identity: a link written on the key alone [high]

**The shape.** A link between two rows is written on the strength of a KEY — an
AutoCount `DtlKey`, a document number, a row POSITION, a client-supplied uuid —
without asserting that the IDENTITY of the two sides agrees: same `item_code`,
same variant, same company, same document. The link is then structurally
valid and semantically wrong, and nothing downstream can tell. A foreign key
that points at a real row of the wrong product does not dangle, does not
violate a constraint, and does not lower any coverage count.

It is not a cousin of `unverified-completeness-claim` (0099) — it is its
opposite number in the data. That class is a sentence nothing checks; this one
is a ROW nothing checks.

**Why it is expensive here specifically.** `purchase_order_items.so_item_id` is
not bookkeeping. A bedframe or sofa line is HARD-BOUND (`isHardBoundLine`,
`backend/src/scm/lib/so-stock-allocation.ts`) and reads READY only through its
OWN dedicated purchase order's `received_qty`, never through the pooled
balance. So a wrong dedication tells the floor that a customer's REGAL is ready
when a TRION arrives, and the real REGAL can never light. The owner's answer
when he was shown the first nine, 2026-09-07: 「办得到呢？那有什么奇怪的呢？再查看
有没有什么类似的问题？」 — this entry is that sweep.

---

### The two confirmed instances that named the class

1. **SO -> PO dedication, `sync-ac-delta.mjs` lane `links`.** Resolved
   `PODTL.FromSODtlKey` and `PODTL.DtlKey` to ERP rows by `linked_ac_dtlkey` and
   wrote `so_item_id` on that key pair alone. Run 34123720786 (2026-09-07 20:46
   local) wrote 10; nine bound a sales-order line to a purchase-order line for a
   different bed. Guarded in PR #3076. Full trace: `docs/bugs/0671`. **The nine
   production rows are owned by another agent; nothing here touches them.**

2. **Delivery-order sofa colours that are EXACT SWAPS between two lines of one
   document.** `DO-011505` DtlKey 920097 book PC151-01 / ERP PC151-17 and 920099
   book PC151-17 / ERP PC151-01; `DO-011478` 917532 book PC151-13 / ERP PC151-06
   and 917534 book PC151-06 / ERP PC151-13 (reconcile run 34130727594). A
   perfect swap on two separate documents is not two colour errors, it is
   positional pairing. **Those two documents are owned by another agent; the
   WRITER is traced below as site 6.**

---

### The sweep — what was enumerated, and how

The population searched was every WRITE of a line-to-line link column under
`backend/src` and `backend/scripts`:

```
$ git grep -nE "([Ss][Ee][Tt][[:space:]]+[a-z_.\"]*((so|do|grn|purchase_order|delivery_order|sales_invoice)_item_id|linked_ac_dtlkey)[[:space:]]*=)|(^[[:space:]]*((so|do|grn|purchase_order|delivery_order|sales_invoice)_item_id|linked_ac_dtlkey)[[:space:]]*:)" -- backend/src backend/scripts ':!*.test.*' ':!*/migrations*' | wc -l
72
```

72 write-shaped occurrences in 39 files, on `e1604f649`.

**That number is a FLOOR, not a census, and saying so is the point.** The grep
cannot see a link written inside a multi-line SQL `INSERT` column list
(`lib/migrated-do-writer.mjs`, `import-ac-so-linked-pos.mjs` both write
`so_item_id` that way), and it cannot see the inverse shape — a script that
overwrites `item_code` by joining ON the link (`open-5526-model.mjs`). Those
were found by reading, not by the grep. Do not quote 72 as "the number of link
sites".

Reading was split four ways — the runtime converters, the backfill/repair
scripts, the photo / fabric / SKU matchers, and the allocator + AutoCount
write-back. What follows is what each site asserts BEFORE it writes.

---

### The findings

Verdicts: **KEY-ONLY** = writes on the key with no identity assertion.
**PARTIAL** = asserts something (code, count, company) but not the identity that
can actually differ here. **AMPLIFIER** = trusts an upstream link without
re-asserting; not itself a defect, but it is how the damage travels.

| # | Site | Key it links on | Identity asserted | Verdict |
|---|---|---|---|---|
| 1 | `scripts/sync-ac-delta.mjs` lane `dedi` (~:930-956) | `FromSODtlKey` + `DtlKey`, both via `linked_ac_dtlkey` | none — three refusals, all about CLAIMS | **KEY-ONLY — FIXED HERE** |
| 2 | `src/scm/routes/mfg-purchase-orders.ts` POST `/` (~:1146-1263) | client-supplied `soItemId` uuid | company, orderable, qty cap — no item | **KEY-ONLY — FIXED HERE** |
| 3 | `scripts/import-po-so-links.mjs` (~:82-95) | positional zip; `FromSODocList[0]`; `soCands[i % soCands.length]` | doc only | **KEY-ONLY — FIXED HERE** |
| 4 | `scripts/import-ac-so-linked-pos.mjs`, `scripts/topup-ac-po-lines.mjs` | `FromSODtlKey` -> (SO doc, the SO's OWN AutoCount code) | the PO row's own `item_code` never compared | KEY-ONLY — NOT fixed |
| 5 | `scripts/open-5526-model.mjs` (~:312-328) | the link column itself | none: `UPDATE … SET item_code = ? WHERE so_item_id = ?` with no predicate on the old code | KEY-ONLY (inverted) — NOT fixed |
| 6 | `scripts/lib/migrated-do-writer.mjs:145` `targets = [cands[used]]` | `(SO no, ERP code)` then POSITION | code + doc; not colour, not qty, not the book's DtlKey | **PARTIAL — the writer behind instance 2** |
| 7 | `scripts/backfill-ac-line-keys.mjs:~64-88` | `(AC doc, TRANSLATED ERP code)` then positional zip `list[i]` <-> `keys[i]` | equal line COUNT only | PARTIAL — NOT fixed |
| 8 | `scripts/backfill-photo-urls-from-keys.mjs:~45-58` | `(doc_no, DtlKey)` parsed out of an R2 FILENAME | none | KEY-ONLY — NOT fixed |
| 9 | `scripts/lib/line-photo-keys.mjs` `planRepoint` (~:109) | DtlKey from the address; `target = firstRow(group)` | none — `itemCode` is carried for the printout only | KEY-ONLY — NOT fixed |
| 10 | `scripts/import-so-line-photos.mjs`, `import-po-line-photos.mjs` | `(doc, code)` then `cands[0]`; sofa falls back to the model prefix | code at group level, then first-match | KEY-ONLY — NOT fixed |
| 11 | `src/scm/lib/so-line-relink.ts:~96-103` | `item_code` bucket + ORDINAL within it | code only; `variants` is not in `SoLineIdentity` | PARTIAL — NOT fixed |
| 12 | `src/scm/lib/autocount-line-keys.ts` `persistNewLineKeys` (~:239) | ascending new DtlKey zipped by index | ItemCode only — its sibling 90 lines above adds Desc2 AND refuses a repeated code | PARTIAL — NOT fixed |
| 13 | `src/scm/lib/autocount-read.ts:~219` -> `shared/po-transfer-shape.ts:144` | `so_item_id` -> SO line's `linked_ac_dtlkey` -> the book | cardinality, distinctness, one source doc — never the item | KEY-ONLY — NOT fixed |
| 14 | `src/services/autocount-writeback.ts` `composeEdit` (~:1479) | `linked_ac_dtlkey` | none, and `ItemCode` is deliberately STRIPPED off a keyed line | KEY-ONLY by design — see below |
| 15 | `routes/sales-invoices.ts:392`, `purchase-invoices.ts:833/:2059`, `grns.ts:1641/:2932`, `purchase-returns.ts:835/:1539`, `delivery-returns.ts:738`, `lib/do-item-row.ts:104` | client-supplied uuid | company + parent status + qty cap on most; **no item comparison on any** | KEY-ONLY — NOT fixed |
| 16 | `scripts/lib/fabric-colour-match.mjs:~379` | a BARE NUMBER, series assumed to be `PC` | none about the series | KEY-ONLY — NOT fixed |
| 17 | 13 call sites in 12 scripts select `fabric_colours` without `active` | colour string | company yes, LIVENESS of the row no | PARTIAL — already `docs/bugs/0669`, owner-deferred |
| 18 | `src/scm/lib/so-stock-allocation.ts:~683-717`, `routes/mrp.ts` `isDedicated` | `so_item_id` FK | none — `item_code` is not even in the projection | **AMPLIFIER** |
| 19 | `scripts/backfill-do-line-snapshot.mjs:~158` | existing `so_item_id` | none before copying variants/desc2/group across | AMPLIFIER |
| 20 | `scripts/audit-mrp-pairing.mjs:276` `if (left <= 0) continue` | — | the one item-code detector skips FULLY RECEIVED lines, which is the state all nine of 0671 converge on | **DETECTOR BLIND SPOT** |

**Sites that came back clean, and are worth copying:**
`src/scm/lib/autocount-line-keys.ts` `persistLineKeys` (count + ItemCode +
prefix-tolerant Desc2, and an outright refusal when a code repeats with no
Desc2 to separate the two); `soLinkTargetRefusal` in `mfg-purchase-orders.ts`
(code AND `specSignature` — fabric/colour/SEAT/LEG); `derive-do-so-item-id.ts` +
`scripts/lib/do-so-item-pairing.mjs` (doc + code + variant identity, refuses a
non-bijective group); `scripts/lib/po-so-dedication-plan.mjs`,
`repair-do-so-item-links.mjs`, `repair-po-so-links-autocount-text.mjs`,
`backfill-po-ac-dtlkey.mjs`; `lib/po-allocations.ts`; `lib/batch-claimed-stock.ts`
and `sofa-set-coverage.ts` (item + variant on every lookup — no batch-code-only
match anywhere); `scripts/lib/ac-master-matcher.mjs`, which computes an identity,
refuses ties, and never auto-binds.

**Two structural observations, which are the real content of this entry:**

- **The rule is written correctly four or five times over and applied at N-1 of
  its N call sites.** `soLinkTargetRefusal` guards the add-line, the patch-line
  and both allocation paths in `mfg-purchase-orders.ts` — and not the create.
  `planSoPoDedications` guards `sync-ac-delta`'s `links` lane — and not `dedi`,
  thirty lines further down the same file. `persistLineKeys` refuses a repeated
  code — `persistNewLineKeys`, in the same file, does not.
- **Every existing "unlinked line" guard is scoped to `link IS NULL`.**
  `do-unlinked-so-lines`, `grn-unlinked-po-lines`, `return-unlinked-lines` and
  `unlinked-line-edit-guard` all defend against a MISSING link. Before this
  entry, nothing in `backend/src/scm/` defended against a PRESENT and WRONG one
  on any chain except the purchase order's. Worse, four edit paths
  (`delivery-orders-mfg.ts:~4993`, `sales-invoices.ts:~1866`,
  `purchase-invoices.ts:~2221`, `delivery-returns.ts:~1660`) let `item_code` be
  rewritten UNDER a live link — so a line can drift out of identity with its
  parent after the fact. Only the GRN edit path freezes it
  (`grns.ts:~3179`, `grnInheritedFieldChanges`).

**Site 14 is not a defect to fix, it is a boundary to know.** `composeEdit`
addresses a book row by `DtlKey` and strips `ItemCode` off it, because
`AcSyncService.cs`'s `doc.EditDetail(dtlKey)` is the only handle the SDK
exposes. So the write-back has no field in flight that could reveal a wrong
key: the correctness of `linked_ac_dtlkey` IS the correctness of the edit. That
is what makes sites 7 and 12 — the two positional writers of that column —
matter more than their verdicts suggest. `docs/bugs/0025` already named this
residual; it is still open.

**The 117 that make the buckets unsafe.** `backend/scripts/data/autocount-erp-mapping-1561.csv`,
measured on this tree: 1,577 data rows, `ac_code` distinct 1,577 (so no
first-match-win is possible in the direction it is keyed), but `erp_code`
distinct only 1,445 — **117 ERP codes are claimed by two or more AutoCount
codes, and 249 of 1,577 rows (15.8%) sit on a shared ERP code.** Every site
that groups by the TRANSLATED code (7, 8, 10) therefore merges up to five
AutoCount item codes into one bucket before pairing positionally inside it.

---

### The instrument, and why the one we had could not see this

`backend/scripts/probe-doc-link-matrix.mjs` counts each link FILLED and
DANGLING. All nine wrong dedications were filled and none dangled — a valid
foreign key pointing at a different bed is neither. **A dangling count answers
"is the foreign key valid", which is a different question from "are the two rows
the same thing".** That is this class's signature false negative, and it is the
same trap the guard added in PR #3076 fell into once already: it reported 0 live
because the lane skips PO lines that already carry a dedication.

`backend/scripts/probe-link-identity.mjs` (new, read-only, counts only) asks the
other question, in four parts:

1. per line->line link column in `scm`: rows whose parent exists and whose
   `item_code` DISAGREES — printed next to the total and the NULL count, because
   a count taken only over rows that already carry a link cannot see a link that
   was never written;
2. of those, how many sit in a document where the children's codes are a PERFECT
   PERMUTATION of their parents' — the fingerprint of positional pairing;
3. `linked_ac_dtlkey` duplicates per table and ACROSS companies — migrations
   0273 and 0280 index it NON-uniquely on six line tables, so a lane that builds
   a `Map` keyed by DtlKey silently keeps one row per key;
4. the same permutation test on `variants->>'colourCode'`.

### What production actually says — run 34137796488, 2026-09-07 23:22 local

`probe-link-identity.mjs` against `secrets.DATABASE_URL`, read-only, conclusion
`success`. Counts only, per the privacy rule.

**1. Rows whose link points at a DIFFERENT product**

| link | linked / total rows | carry no link | dangling | **wrong product** |
|---|---|---|---|---|
| `delivery_order_items.so_item_id` (DO -> SO) | 1000 / 1007 | 7 | 0 | **0** |
| `grn_items.purchase_order_item_id` (GR -> PO) | 715 / 715 | 0 | 0 | **0** |
| `purchase_order_items.so_item_id` (PO -> SO) | 1122 / 1532 | 410 | 0 | **10** |
| `sales_invoice_items.do_item_id` (SI -> DO) | 182 / 182 | 0 | 0 | **2** |
| `sales_invoice_items.so_item_id` (SI -> SO) | 0 / 182 | 182 | 0 | 0 (nothing to compare) |
| `purchase_invoice_items.grn_item_id` (PI -> GR) | 198 / 198 | 0 | 0 | **3** |

**15 wrong links in production, on three chains.** Every one is FILLED and NONE
dangles, which is exactly why the existing matrix reported them clean.

**The PO -> SO number is 10, and the sofa audit's was 9.** The audit counts sofa
and bedframe; this counts every purchase-order line. So one wrong dedication was
outside the audit's population and has never been reported — LIKELY the
`AMN-SOFA PILLOW` accessory line that run 34123720786 wrote alongside the nine
(0671 names it), but that is an inference from the run's own enumeration, not a
row-level match. UNKNOWN until someone lists the ten.

**SI -> DO 2 and PI -> GR 3 are NEW.** Nobody has reported these. They are on the
two chains site 15 flags: an invoice line that names a delivery line for a
different product, and a purchase-invoice line that names a goods-receipt line
for a different product. Both routes take the link from the client and check
company, parent status and quantity — never the item.

**2. None of the fifteen is a permutation.** 8 purchase orders, 2 sales invoices
and 3 purchase invoices carry a wrong pairing, and **0 of the 13 documents is a
perfect permutation of its own codes**. So these are not positional swaps: the
parent is a product the document does not even order. That REFUTES the tidy
theory that one mechanism produced everything, and it is consistent with the DO
colour swap being a separate shape — there the codes MATCH and only the colour
moves, so an item-code test cannot see it by construction.

**3. The AutoCount line key is duplicated on the purchase-order lines.** 1,281 of
1,532 PO lines carry a `linked_ac_dtlkey`; **98 keys are carried by more than one
row, 250 rows in total.** The other five line tables carry none at all. The
LIKELY explanation is benign — one book line for a sofa becomes several ERP
compartment lines, and they share the book's key — but the consequence does not
care: `composeEdit` addresses a book row by `doc.EditDetail(dtlKey)`, and any
lane that builds a `Map` keyed by DtlKey keeps ONE row per key. The first run
could not tell benign from collision; the probe now splits the count by whether
the sharing rows name the same product. **UNKNOWN until that re-run.**

### The probe's own two blind spots, found by running it

Both are the trap CLAUDE.md names — the check that answers a different question —
and both were in MY instrument, so they are recorded rather than quietly fixed:

- **The sales-order lines were not measured at all.** Section 3 answered
  `NOT COUNTABLE: column h.id does not exist` for `mfg_sales_order_items`,
  because a sales-order LINE joins its header by `doc_no`, not by an id foreign
  key. The one table the whole incident is about produced no number.
- **The colour test compared a key nothing writes.** It read
  `variants->>'colourCode'` and found **0 comparable pairs on every edge** — an
  EMPTY answer that prints identically to a clean one. The importers write
  `colourId` and `colourLabel` (`import-ac-outstanding-so.mjs:302`).

Both fixed, and the comparable-pair count is now printed beside every colour
answer so an empty result can never read as a clean one again. Re-run recorded
below.

---

### Fixed here, each proved RED first

Run at 22:54 local on 2026-09-07 against `e1604f649`,
`backend/tests/keyWithoutIdentityGuards.test.mjs`:

```
 ❯ tests/keyWithoutIdentityGuards.test.mjs (5 tests | 5 failed) 12ms
     × refuses a dedication whose two ERP rows name a different product 7ms
     × records the refusal instead of dropping it silently 1ms
     × imports the rule rather than restating it 2ms
     × reads the SO line item_code, so the two sides CAN be compared 1ms
     × refuses a bind whose two lines name a different product 1ms
 Test Files  1 failed (1)
      Tests  5 failed (5)
```

After the two fixes: `Test Files  1 passed (1) / Tests  5 passed (5)`.

**Site 1 — `sync-ac-delta.mjs` lane `dedi`.** It writes the same `so_item_id`
column from the same `FromSODtlKey`/`DtlKey` pair as lane `links`, built its
plan inline, and so kept the defect that `links` had removed hours earlier. It
is in the workflow's DEFAULT `lanes` string (`desc,pay,links,recv,do,dedi`), so
an `apply` dispatch with untouched inputs runs it against `secrets.DATABASE_URL`.
Both codes were already in hand — `pi.item_code` is selected at `:269` and
`si.item_code` was already being printed in the plan line. It now imports
`normItemCode` from `lib/ac-po-line.mjs` (the rule keeps ONE home) and refuses,
into its own `dediMismatch` list kept apart from `dediRefused`: a claim conflict
is this script deciding who gets a line, an item mismatch is a disagreement
inside the ERP that no script may resolve.

**Site 2 — `POST /purchase-orders`.** Its own comment said it "mirrors
soLinkTargetRefusal"; it mirrored the company half only. It now reads
`item_code` in the batch SO read it was already taking and refuses with the same
`so_link_material_mismatch` 409 the other four call sites use — in memory, no
extra round trip.

**Site 3 — `import-po-so-links.mjs`.** Three refusals added. `soCands[i %
soCands.length]` picked the target with the counter of an unrelated outer loop
whenever a sales order carried two lines of the same code — two of the same sofa
in different colours, the normal case. A consolidated `FromSODocList` naming
several sales orders is now refused instead of `[0]` being taken. And the two
sides, derived through the CSV from DIFFERENT AutoCount codes, are compared.

**Why the tests read source instead of calling the code.** The property being
pinned is not "the rule is right" — the rule for site 2 now lives in
`backend/src/scm/lib/so-link-item-identity.ts` and has its own behavioural test
(`backend/tests/soLinkItemIdentity.test.ts`, 11 assertions including five of the
real wrong pairs from 0671), and site 1's rule is `normItemCode`, already covered
by `soPoDedication.test.mjs`. What the structural test pins is that the rule is
APPLIED AT THIS CALL SITE, and a call-site population is precisely what a unit
test cannot see; that is 0099's lesson and the instrument
`scripts/check-optional-decision-params.mjs` already uses here.

Site 2's guard was moved into its own module rather than inlined, because the
file-size ratchet charges GROWTH: `mfg-purchase-orders.ts` is 4,538 lines at the
merge base and 4,538 after this change.

---

### NOT fixed, and why

- **The nine production dedications from 0671** — another agent owns the revert;
  the underlying question (did the customer change the bed, or did the SO import
  mis-map it?) is the owner's.
- **`DO-011505` and `DO-011478`** — another agent owns those rows. Site 6 is
  the writer that produces that shape and is unfixed: `buildMigratedDoPlan`
  consumes candidate SO lines in ERP `line_no` order against the AutoCount export's
  row order. When one sales order carries two lines of the same code in different
  colours and the two orders disagree, the result is an exact swap — and because
  the writer copies `variants` from whichever SO line it paired with, the DO line
  inherits the other line's colour. Fixing it means deciding what to do when the
  book carries no line-level key to settle it, which is a design call, not a guard.
- **Sites 4, 5, 7-13, 15-17.** All are real; none is a one-line refusal, and
  several (10, 15, 17) have owner-facing consequences. They are listed here with
  file and line so the next session starts from the list rather than the hunt.
- **Site 20** — `audit-mrp-pairing.mjs` skips fully received PO lines before its
  item-code comparison runs, so the detector cannot see the damage state the
  nine converge on. Worth fixing before it is trusted again.

**UNTESTED as a remedy:** none of the three fixes has been RUN against
production. They are refusals — they cause a future run to write less, and
neither undoes an existing wrong link nor proves one absent. Nothing in this PR
repairs a row.

**Ref.** fix/bugclass-key-without-identity, PR #3087, 2026-09-07.
