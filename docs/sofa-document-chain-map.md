# The sofa document chain: SO -> PO -> GRN -> DO

What one sofa build looks like at each stop on its way through the system, which
column carries it from one stop to the next, and — the part that actually costs
people time — **which of those stops update themselves and which have to be
pushed**.

> Read this before writing anything that "fixes a sofa build". A sofa is stored
> as one ERP row PER COMPARTMENT, so correcting a build changes the ROW COUNT,
> and four different tables hold their own independent copy of the answer.

Scope is the 2026-08 AutoCount cutover corpus on `company_id = 1` (Houzs). The
counts in section 5 are measured, not estimated; the run is named there.

Companion reading: `docs/modules/document-traceability.md` (what each link
column means and does NOT mean), `docs/autocount-cutover-ledger.md` (how to
tell an imported row from a hand-made one), `docs/modules/sales-order.md` /
`purchase-order.md` / `grn.md` / `delivery-order.md` (each document on its own).

---

## 1. The chain at a glance

| # | Document | Header table | Line table | Link column on the LINE | Points at | Snapshot or live? |
|---|----------|--------------|------------|--------------------------|-----------|-------------------|
| 1 | Sales Order | `scm.mfg_sales_orders` | `scm.mfg_sales_order_items` | — (the origin) | — | origin of truth |
| 2 | Purchase Order | `scm.purchase_orders` | `scm.purchase_order_items` | `so_item_id` | SO line | **SNAPSHOT** |
| 3 | Goods Received Note | `scm.grns` | `scm.grn_items` | `purchase_order_item_id` | PO line | **SNAPSHOT** |
| 4 | Delivery Order | `scm.delivery_orders` | `scm.delivery_order_items` | `so_item_id` | SO line | **SNAPSHOT, and a partial one** |

The table names matter: it is `scm.grn_items` and `scm.delivery_order_items`.
There is no `mfg_goods_received_note_items` and no `mfg_delivery_order_items` —
guessing those names is a `42703` on first dispatch.

Two things this shape implies and that nothing in the UI tells you:

- **The DO does not hang off the GRN.** The chain is not a line. It forks at
  the SO: `SO -> PO -> GRN` is the factory branch and `SO -> DO` is the customer
  branch, and the only thing joining them is the SO line they both name. Two
  branches can therefore describe different builds while each is internally
  consistent. That is what LEG 4 of the audit exists to catch.
- **There is no view anywhere in this chain.** Every child row is a physical
  copy taken at creation. Correcting a parent changes the parent only.

---

## 2. What each child actually copied

Written by `backend/scripts/create-migrated-documents.mjs` for the cutover
corpus. The columns each writer names are the whole story:

| Child | Copies from parent | Does NOT copy |
|-------|--------------------|---------------|
| GRN line (`:142`) | `purchase_order_item_id`, `material_code`, `material_name`, `item_group`, `variants`, qty, price | `description2` |
| DO line (`:257`) | `so_item_id`, `item_code`, `description`, `uom`, `qty` | **`item_group`, `variants`, `description2`** |

**The DO line is the weak one, and it is weak in a way that bites silently.**
Because `item_group` is never written, every migrated DO line has a NULL group.
Any audit, report or repair that filters DO lines with
`WHERE item_group IN ('sofa','bedframe')` returns **nothing at all** and reads
as "clean". The classification has to be inferred instead, in this order:

1. the line's own `item_group`, when a human made the line;
2. the `item_group` of the SO line its `so_item_id` names;
3. `scm.mfg_products.category` for its `item_code`.

Only step 3 works for a line whose `so_item_id` is NULL — which is exactly the
population that most needs classifying (section 4).

Because `variants` is never written either, a SO -> DO variant comparison
reports "the child has no fabric / seat height" for the entire migrated corpus.
That is the writer's shape, not drift, and the audit keeps it in its own bucket
(`child carries no variants`) rather than folding it into the mismatch count.

---

## 3. What propagates automatically, and what needs a re-sync

Nothing propagates automatically. There is no trigger, no view, and no
recompute on read anywhere in this chain.

| Change | Reaches the PO? | Reaches the GRN? | Reaches the DO? |
|--------|-----------------|------------------|-----------------|
| Edit an SO line in the UI | no | no | no |
| Edit a PO line in the UI | — | no | — |
| `apply-sofa-compartment-corrections.mjs` UPDATE of an SO line | yes, explicitly (`:244`) | yes, via the PO line it just wrote (`:251`) | yes, explicitly (`:257`) |
| `apply-sofa-compartment-corrections.mjs` UPDATE of a PO line | — | yes, explicitly (`:239`) | — |
| `apply-sofa-compartment-corrections.mjs` INSERT of a NEW piece | **no** | **no** | **no** |
| `apply-sofa-compartment-corrections.mjs` DELETE of a surplus piece | refused if a child points at it (`:156-169`) | refused | refused |
| **owner rule 2026-08-10: a surplus piece must be CANCELLED, never deleted** | see section 7 | | |
| `repair-leaked-sofa-lines.mjs` | **no** | **no** | **no** |

The last two rows are the structural gaps, and they are gaps by construction
rather than by bug:

- **An INSERTED piece has no children to carry to.** When a correction grows a
  build from two pieces to three, the SO gains the row and the PO, GRN and DO
  keep describing the two-piece build. The audit sees this as a build-level
  `child lacks <piece>`, never as a line-level mismatch, which is why the
  build-level multiset test cannot be dropped in favour of the cheaper
  pair-level one.
- **`repair-leaked-sofa-lines.mjs` writes `scm.mfg_sales_order_items` and
  nothing else.** It rewrites the lead line's `item_code`, `item_group` and
  `variants` and inserts the remaining pieces. Every downstream document is
  left stating the pre-repair build.

### Which script touches which leg

| Script | SO line | PO line | GRN line | DO line |
|--------|---------|---------|----------|---------|
| `apply-sofa-compartment-corrections.mjs` | write | write (own arm + carry) | carry only | carry only |
| `repair-leaked-sofa-lines.mjs` | write | — | — | — |
| `backfill-po-so-item-links.mjs` | — | writes `so_item_id` (the LINK, not the build) | — | — |
| `open-sofa-so-compartments.mjs` | — | — | — | — (mints SKUs + model options) |
| `set-compartment-art-1s2s3s.mjs` | — | — | — | — (`scm.compartment_library` artwork) |
| `fix-sofa-compartment-pool.mjs` | — | — | — | — (maintenance config) |
| `check-sofa-chain-alignment.mjs` | read | read | read | read |
| `check-po-so-completeness.mjs` | read | read | — | — |

---

## 4. Where the links are NULL, and what that costs

| Link | Nullable? | Why it is legitimately NULL | What goes blind when it is |
|------|-----------|------------------------------|-----------------------------|
| `purchase_order_items.so_item_id` | yes | a STOCK purchase is not raised for any order. Per `docs/modules/document-traceability.md` this column is procurement *provenance* and binds no execution. | nothing that matters — the leg simply has no parent to compare against |
| `grn_items.purchase_order_item_id` | yes | a free / manual receipt lands stock with no PO behind it (`docs/modules/grn.md`) | `received_qty` does not move and `verifyGrnOverReceipt` sees nothing, so the same delivery can be received twice. Guarded since 2026-08-04 by `findUnlinkedPoLines`; a prod scan found none in this state |
| `delivery_order_items.so_item_id` | yes | an ad-hoc line — a replacement part or a sample riding along | **this is the dangerous one.** `deductInventoryForDo` reads the DO's OWN lines, so the stock still goes out, but the line counts toward no SO line: `soDeliverableRemaining` cannot see it and the over-delivery guard cannot fire. `2990-DO-2607-005` and `2990-DO-2607-017` both shipped `2990-SO-2606-019` this way (`docs/unlinked-line-duplicate-coe.md`) |

**Every alignment check keyed on `so_item_id` is blind to that third row.** A
DO line with a NULL link is not "aligned" and not "mismatched" — it is not
looked at. `check-sofa-chain-alignment.mjs` therefore counts them as their own
category and then matches them a SECOND way, in decreasing confidence:

1. `delivery_orders.so_doc_no` + item code + quantity
2. `delivery_orders.so_doc_no` + item code alone (one candidate only)
3. otherwise: ambiguous, or the header names no SO, or that SO carries no such
   code — all reported individually and never scored

Recovered pairs are reported separately and are never folded into the leg's
primary counts, because a recovered link is weaker evidence than a stored one.
They are used for one derived number only: how many build-level mismatches
exist *purely* because a piece's DO line lost its link, versus how many survive
the recovery and are therefore real.

The same trick works on the GRN leg: `grns.purchase_order_id` survives on the
header even when the line's `purchase_order_item_id` does not, so header + code
recovers most orphaned GRN lines.

---

## 5. The measured state

Measured 2026-08-10 by `check-sofa-chain-alignment.mjs`: run
[31412356560](https://github.com/hello-houzs/Houzs-ERP/actions/runs/31412356560)
(company 1, Houzs) and
[31412605952](https://github.com/hello-houzs/Houzs-ERP/actions/runs/31412605952)
(company 2, 2990). Both read-only.

### The four legs

| Leg | Company | Child lines | Unlinkable | Linked pairs | Aligned | Code mismatch | Variant-value mismatch | Child has no variants | Builds | Piece-set mismatch |
|-----|---------|------------|-----------|--------------|---------|---------------|------------------------|----------------------|--------|--------------------|
| 1 SO -> PO | 1 | 625 | 181 | 443 | 413 | **0** | 16 | 14 | 376 | **8** |
| 2 PO -> GRN | 1 | 442 | 0 | 442 | 339 | **0** | 101 | 2 | 361 | **9** |
| 3 SO -> DO | 1 | 10 | 0 | 10 | 0 | **0** | 0 | 10 | 6 | 1 |
| 4 transitive | 1 | — | — | 6 builds reachable both ways | 5 agree | — | — | — | — | 1 disagree |
| 1 SO -> PO | 2 | 83 | 2 | 81 | 81 | 0 | 0 | 0 | 43 | 0 |
| 2 PO -> GRN | 2 | 68 | 0 | 68 | 68 | 0 | 0 | 0 | 38 | 0 |
| 3 SO -> DO | 2 | 41 | 1 | 40 | 40 | 0 | 0 | 0 | 20 | 0 |
| 4 transitive | 2 | — | — | 18 builds reachable both ways | 18 agree | — | — | — | — | 0 disagree |

**Company 2 (2990) is aligned on all four legs.** Company 1 is where the work is.
**No line anywhere in either company carries the wrong item code** - every
company-1 difference is a missing piece or a variant axis, never a piece that
changed identity.

### Snapshot fidelity, company 1

| Population | Lines | `item_group` null | `variants` null | `description2` null |
|---|---|---|---|---|
| SO | 3386 | 0 | 490 | 5 |
| PO | 625 | 0 | 56 | 0 |
| GRN (reachable from a PO line) | 442 | 0 | 10 | — |
| DO (sofa/bedframe) | 10 | **10 of 10** | **10 of 10** | **10 of 10** |

The DO row is the writer's shape, not drift, and it is why the DO leg has to
infer its classification. Company 2's 41 sofa/bedframe DO lines all carry their
own `item_group`, because they were not made by the migrated-document writer -
the contrast is the proof that the NULLs are the writer's doing.

### Is the compartment test applicable? Measured, not assumed

Lines per SO build, company 1:

- **sofa** 512 builds: 1 line x162, 2 x228, 3 x106, 4 x12, 5 x3, 6 x1 - a piece
  set exists, so the multiset test is meaningful.
- **bedframe** 2212 builds: 1 line x2054, 2 x147, 3 x11 - 93% are a single line.
  A bedframe piece set does not exist to be wrong, so bedframe is compared on
  the whole item code plus the variant axes and NOT on compartments.

### Why the compartment correction reported "DO lines 0"

Proven by query, not inferred:

| | |
|---|---|
| sales orders named by the correction file | 29 |
| their sofa SO lines now in the ERP | 75 |
| delivery orders whose header names one of them | **0** |
| DO lines whose `so_item_id` points at one of them | **0** |
| DO lines on those DOs with a NULL `so_item_id` | **0** |

**No delivery order exists for any corrected order.** The DO arm of the
correction was never exercised; it is not silently blind. Had a DO existed with
a NULL link, the same query would have shown a non-zero third row and a zero
fourth, and the verdict would read the other way.

### The link, company 1

- 181 of 625 PO lines carry a NULL `so_item_id`, and 1 has a dangling one.
- 0 GRN lines and 0 DO lines are unlinked in company 1. The `so_item_id` blind
  spot that `2990-DO-2607-005` demonstrates does exist in company 2, where 1 DO
  line carries a NULL link - recovered by `so_doc_no` + code + quantity and found
  aligned.

### The company-1 residue, adjudicated

Measured by `diag-sofa-cutover-residue.mjs`, run
[31414712614](https://github.com/hello-houzs/Houzs-ERP/actions/runs/31414712614).

**Compartment completeness, scored on the field instead of the import remark:**

| Population | Remark rule (reported today) | **Field rule** | Stale remarks | (i) no compartment | (iii) Desc2 differs |
|---|---|---|---|---|---|
| PO sofa | 187/219 | **213/219** | 26 | **0** | 6 lines |
| SO sofa | 233/272 | **262/272** | 29 | **0** | 10 lines |

Both self-check: field-complete minus remark-complete equals the stale count
exactly (213-187=26, 262-233=29), and complete + incomplete equals the total.
**No sofa line anywhere is missing a compartment or carrying an unminted SKU** -
category (i) is empty in both populations. The entire 26/29 gap is the remark
outliving its own truth.

The 6 PO defects sit on just two documents:

- `HC-PO-009469` (9050) - document has `2A(RHF)+1A(LHF)`, Desc2
  `1+2(28'INCH)/COL:BOO315-2` decodes `1S+2S`. Straight vs L-shape: the owner's
  hand-correction says corner, the AutoCount text says straight.
- `HC-PO-009596` (9028) - document has `1A(RHF)+1A(RHF)+1A(LHF)+1A(LHF)`,
  Desc2 `(1EL+1ER)32inch` decodes `1A(LHF)+1A(RHF)`. Each piece appears twice.
  This is either a duplicated build or two identical sofas on one document that
  the build key (doc + model + Desc2) collapses into one - it must be eyeballed
  before anything is concluded.

**The 8 short POs - 7 are a LINK defect, 1 is a real short order:**

| SO -> PO | Verdict |
|---|---|
| `HC-SO-011660` -> `HC-PO-009017` | the missing `2A(RHF)` is **on that same PO**, on a line whose `so_item_id` is NULL |
| `HC-SO-011733` -> `HC-PO-008783` | `CNR`, `CONSOLE`, `1A(RHF)` all on that same PO, unlinked. The SO wants **2x `1NA`** and the ambiguity means the second one is unconfirmed - check that quantity |
| `HC-SO-011965` -> `HC-PO-008986` | missing `CNR` is on that same PO, unlinked |
| `HC-SO-012525` -> `HC-PO-009402` | missing `CNR` is on that same PO, unlinked |
| `HC-SO-012774` -> `HC-PO-009584` | missing `2A(RHF)` is on that same PO, unlinked |
| `HC-SO-012775` -> `HC-PO-009585` | missing `2A(RHF)` is on that same PO, unlinked |
| `HC-SO-000870` -> `HC-PO-000290` | **not short.** The PO buys both `CODY-(K)`; its second line is MIS-LINKED to `HC-SO-000870` line 2, which is a MATTRESS line (`LUMBARIA MATT (K)`). Same defect class, wrong target instead of a null one - and it is the single dangling FK in section D |
| `HC-SO-012949` -> `HC-PO-009709` | **GENUINE SHORT ORDER.** `CODY-(S)` is on no purchase order at all, its `stock_status` is PENDING, and `HC-PO-009709` carries no unlinked line for it. The customer ordered a super-single frame nobody has been asked to build. |

So the factory is being asked to build the right thing in 7 of the 8 cases; the
piece is on the purchase order and only the per-line link is missing. **One
customer is short a bed frame.**

**The 30 variant differences, by direction:**

| Direction | Count | What to do |
|---|---|---|
| PO empty, SO has the value | 14 | fill the PO from the SO. All 14 are PO lines carrying **no variants at all** |
| SO empty, PO has the value | 2 | fill the SO from the PO - e.g. `HC-SO-000822` -> `HC-PO-000275`, where the PO holds the whole fabric and divan stack and the SO holds none |
| **CONFLICT - both stated, different** | **14** | **a human must choose.** These are not formatting: `PC151-12` vs `PC151-10`, `PC151-18` vs `PC151-02`, gap `14"` vs `16"`, gap `12"` vs `10"`. The customer's order and the factory's order name **different fabric colours** |
| mixed | 0 | |

The 14 conflicts are the most serious finding on this leg: nothing in the system
reconciles them, and each one upholsters a frame in a colour the customer did
not order.

**The link, split:**

| | Count |
|---|---|
| PO lines with a NULL `so_item_id` | 181 of 625 |
| ... on a PO where NO line is linked - a stock purchase, legitimate | **168** |
| ... on a PO where OTHER lines ARE linked - candidates for a lost link | **13** |
| ... of those 13, an unclaimed SO line matches on code AND AutoCount text | **8** |
| dangling FK | 1 - `HC-PO-000290` `CODY-(K)` points at a live MATTRESS line |

The 8 recoverable links are exactly the 8 lines behind 6 of the short-PO
findings above. Repairing the link resolves both symptoms at once.

---

## 6. Rows deleted in production, against the owner's rule

Owner, 2026-08-10: **"不可以删只可以 cancel"** - nothing may be deleted, only
cancelled. The rule arrived after the correction runs, so this records what had
already happened rather than blaming the script for a rule it predates.

`apply-sofa-compartment-corrections.mjs` DELETEs a surplus line when the
corrected build holds fewer pieces than the document does (it already refuses
when a GRN, PO or DO line points at that row). Across **all eight** production
runs of the workflow:

| Run | Mode | Result |
|-----|------|--------|
| 31389858759 | DRY-RUN | no writes |
| 31390455585 | DRY-RUN | planned 4 removals; refused `HC-SO-011957` (surplus referenced downstream) |
| 31392098941 | DRY-RUN | planned 2 removals |
| 31392248071 | **APPLY** | **crashed** on `relation "scm.goods_received_note_items" does not exist` after one build (change / change / add). No removal reached |
| 31393696809 | **APPLY** | **`removed 2` - two rows really were deleted** |
| 31401141301 | DRY-RUN | `removed 0` |
| 31401304734 | **APPLY** | `removed 0` |
| 31404463455 | **APPLY** | `removed 0` (the "added 2, removed 0" run) |

The two deletions, both on **sales orders**:

| Document | Model | Build before | Target | Row deleted |
|----------|-------|--------------|--------|-------------|
| `HC-SO-012624` | 9050 | `1S+2S+2S` | `1A(LHF)+2A(RHF)` | one `9050-2S` |
| `HC-SO-013167` | 8030 | `2S+2S+1S` | `2A(LHF)+1A(RHF)` | one `8030-1S` |

Both were surplus rows at 0 price (the importer puts the whole build's price on
the first piece), so **no money moved** - the script asserts that per build and
aborts otherwise. What was lost is the record that the piece was ever on the
order.

`diag-sofa-cutover-residue.mjs` section E re-checks this **against the
database** rather than against the log, because a log line is not evidence:
`refresh-sofa-colours.mjs` printed `APPLIED` three times while writing nothing.
It asks whether each corrected document still holds at least its target number
of lines, and prints these two documents' current rows in full.

---

## 7. Open questions for the owner

Each has a recommendation. None has been acted on; everything below is a
proposal.

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | The two deleted rows (`HC-SO-012624` `9050-2S`, `HC-SO-013167` `8030-1S`) - restore them as CANCELLED lines at 0 price, or accept the deletion as done? | **Restore as cancelled.** The rule is "只可以 cancel", and a 0-price cancelled row costs nothing and puts the order's history back. Restoring is cheap now and impossible once anyone renumbers the lines. |
| 2 | Should `apply-sofa-compartment-corrections.mjs` keep its DELETE branch? | **No - but the two arms are not symmetrical, and this is the trap.** `scm.mfg_sales_order_items` HAS a `cancelled` column, so the SO arm becomes `SET cancelled = true` with no schema change - and the SO arm is the only one that has ever actually deleted anything. `scm.purchase_order_items` has **no `cancelled` column** (verified against the table definition, not assumed), so the PO arm cannot simply mirror it. Recommendation: add `cancelled boolean NOT NULL DEFAULT false` to `scm.purchase_order_items` in a migration rather than overloading `qty = 0`, which is indistinguishable from a genuine zero and interacts with `received_qty`. Until both arms are changed, do not re-run the script on any build whose piece count shrinks. |
| 3 | The stale `SOFA UNPARSED` remarks - clear them? | **No, do not clear them.** The remark is load-bearing, not decoration: `import-ac-sofa-stock.mjs:164` reads it to decide `placeholder`, and a placeholder build **does not open stock** unless `PLACEHOLDER=1` (`docs/sofa-import-handoff.md:308`). `repair-leaked-sofa-lines.mjs:73` uses its ABSENCE to identify a leak, so clearing it on a `{model}-1S` line makes that line eligible for a repair it does not need. Fix the AUDIT to read the field instead - which is what `diag-sofa-cutover-residue.mjs` section A does - and leave the remark as the import provenance it is. |
| 4 | Company 1 LEG 2 has 101 PO -> GRN variant-value differences against 0 code differences. | Adjudicate by direction before writing anything, exactly as section C does for LEG 1. A GRN is a receipt of what physically arrived; where it is RICHER than the PO it may be recording reality. |
| 5 | 181 PO lines carry no `so_item_id`. | **168 are stock purchases and correct.** Of the 13 on part-linked POs, 8 have an unclaimed SO line matching on code AND AutoCount text. Repair those 8 links (an UPDATE that only fills a NULL, never overwrites - the shape `backfill-po-so-item-links.mjs:407-414` already uses) and 6 of the 8 short-PO findings resolve with them. |
| 6 | `HC-SO-012949` is short a `CODY-(S)` bed frame - on no PO, `stock_status` PENDING. | **Raise a purchase order for it.** This is the one finding here that reaches a customer. It needs the owner because it is a commercial act, not a data repair. |
| 7 | 14 linked pairs name **different fabric colours** on the SO and the PO (`PC151-12` vs `PC151-10`, `PC151-18` vs `PC151-02`, and two gap disagreements). | **The SO is the customer's instruction and should normally win** - but two of these POs may already be in production, so this cannot be resolved by rule. List them to the owner one by one. Do not auto-sync either direction. |
| 8 | `HC-PO-000290`'s second `CODY-(K)` line is linked to a MATTRESS SO line. | Re-point it at the unclaimed `CODY-(K)` line on the same order. Low risk: the link is provenance and binds no execution. |
| 9 | `HC-PO-009596` shows each piece twice against a Desc2 asking for one of each. | Eyeball before touching. The build key collapses two identical sofas on one document into one build, so this may be two orders and not a duplication. |

---

## 8. Traps

1. **`item_group` is not a filter you can trust on a DO line.** It is NULL on
   the entire migrated corpus. Classify by SO line, then by
   `mfg_products.category`.
2. **A build spans several rows, so compare piece sets as a MULTISET.** Row
   order is `line_no`, which is not the physical layout — an order difference is
   not a finding. A duplicated piece IS one, so a Set gives the wrong answer.
3. **`po_number` cannot identify a migrated PO; `linked_ac_docno` can.** The
   numbers were assigned by two different waves and have since been renumbered.
   See `docs/autocount-cutover-ledger.md`.
4. **`migrated_no_stock = true` means the document deliberately has no
   inventory movement** (migration `0276`). Do not "repair" that absence; the
   balance snapshot already counted those units.
5. **A pair-level check and a build-level check answer different questions.**
   Pair-level catches a piece that changed identity; only build-level catches a
   piece that was never created downstream. An audit running one of the two
   will report a clean chain that is missing a whole compartment.
