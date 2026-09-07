# Are the migrated delivery orders and goods receipts verified?

The owner, 2026-09-07, before tallying stock against AutoCount:

> 可是 DO GR 你都检查对了？

This document is the answer, with the evidence, and the three things still open.
It is written because the previous answer to the goods-receipt half was the
string `NOT APPLICABLE`, printed by `check-migration-fidelity.mjs`, which
everything downstream read as a pass.

Every claim below is labelled **PROVEN** (a run, or values printed from a
committed snapshot), **LIKELY** (mechanism read in code, counts predicted
offline), or **UNKNOWN**. Times are Malaysia local (UTC+8).

---

## 0. The trap that nearly went into this document, recorded first

The first production run of the new goods-receipt check
(**34134695504**, 2026-09-07 22:46) reported:

```
goods receipts INVENTED      86 of 320 migrated goods receipts
   they assert 259 unit(s) received across 194 line(s)
```

**It was false.** The check read `ac-fidelity-*`, cut **2026-08-11**.
`ac-convert-edges.json.gz`, cut from the live book **2026-09-07 08:39**, shows
**40 of the 40** named purchase orders had been received — in the window between
the two cuts. Across the whole book: **145 purchase orders received more, 8,935
unchanged, 0 fewer.**

Full entry: `docs/bugs/0672-the-goods-receipt-check-called-86-receipts-invented-against.md`.
The rule it bought: **a checker that reads a committed snapshot must compare its
age against the freshest snapshot in the tree, and may not call anything a defect
on the older one alone.** Printing a timestamp is not using it.

**PROVEN.**

---

## 1. Goods receipts — what the ERP's goods receipt actually IS

`create-migrated-documents.mjs` `doGrns()` selects `purchase_order_items` with
`received_qty > 0`, groups by PURCHASE ORDER, and writes one `grn_item` per PO
line with `qty_received = it.received_qty`.

So a migrated goods receipt is a **mirror of `purchase_order_items.received_qty`
and nothing else.** Two consequences, and the second is why the old
"NOT APPLICABLE" was half right:

- Every statement about the goods receipt is equally a statement about
  `received_qty` — the column the outstanding-PO list and supplier chasing read.
- Comparing a GRN line to AutoCount line-for-line would measure the ERP's own
  derivation. AutoCount's `GRDTL` carries **no key back to the PO line** (0 of
  21,001 rows, `ac-fidelity-manifest.json`), and one ERP GRN covers a whole PO
  while an AutoCount receipt can span several.

What does NOT follow is that nothing is comparable. Three axes survive:
`(PO, item code)`, the PO document total, and — needing no arithmetic at all —
**did AutoCount receive anything against this purchase order?**

**PROVEN** (read in `create-migrated-documents.mjs:58-160`).

## 2. What `check-gr-fidelity.mjs` measures

`backend/scripts/check-gr-fidelity.mjs` + `.github/workflows/check-gr-fidelity.yml`.
Read-only, manual dispatch, own concurrency group. Four tests, each with its
denominator and an UNVERIFIABLE bucket printed rather than dropped:

| test | question |
|---|---|
| 1 | is each goods receipt line still a faithful mirror of its PO line? |
| 2 | receipts the ERP has that the LIVE book never made, and receipts it is missing |
| 3 | received quantity per PO — sofa-free population separately from sofa-bearing |
| 4 | received quantity at `(PO, item code)` grain, sofa excluded |

Sofa is reported as its own population because one AutoCount sofa line becomes
one ERP line per COMPARTMENT and the importer copies the same received quantity
onto every compartment — so an ERP total there is a compartment count, not a
receipt count. Averaging the two populations into one percentage would hide both.

## 3. Delivery orders — what the reconcile already proved

From `ac-erp-reconcile.yml` run **34130727594** (2026-09-07 22:03):

- **171 of 173** in-scope delivery orders are in the ERP. **0 phantom.**
- The COPIED header fields agree **82 of 82** (document date, debtor code,
  debtor name, source sales order). Item code, quantity and description agree
  **353 of 353** on the documents that could be line-matched.
- **26 documents could not be line-matched at all** — their line data is
  UNVERIFIED, not verified-clean.

**PROVEN** (that run).

---

## 4. Why 26 delivery orders cannot be checked, and why that is largely benign

### The mechanism

`check-ac-erp-reconcile.mjs:841` refuses to pair a document when
*neither side carries a line key AND the counts differ*. For migrated delivery
orders neither side ever carries one:

- **The book has no such key.** `ac-convert-edges.json.gz` (live, 2026-09-07)
  shows `fromSoDtlKey` populated on **10,792 of 18,890 PO lines** and on
  **0 of 48,772 DO lines**; `fromDocDtlKey` is NULL on all ~220,000 rows of all
  six detail tables. **AutoCount does not record which sales-order LINE a
  delivery-order line fulfils** — only `FromDocType='SO'` + `FromDocNo`. This is
  a property of the book, not a gap in our export, and it is already written down
  in `export-ac-convert-edges.mjs:31-36`.
- **The ERP does not stamp its own.** `lib/migrated-do-writer.mjs:200-210` names
  15 columns for `scm.delivery_order_items` and `linked_ac_dtlkey` is not among
  them — nor is `line_no`. `migrations-pg/0280` says it outright: *"Nothing
  backfills it."*

With no key and no `line_no`, the ERP line order falls through
`check-ac-erp-reconcile.mjs:770-776` to `a.id > b.id` — a **random UUID order**.

**PROVEN** (snapshot counts, and the column lists in both files).

### What the 26 actually are

21 of the 26 are named in the run (`SHOW = 20` truncates the rest; the other
**5 are UNKNOWN**). Of the 21:

| classification | count | note |
|---|---|---|
| ERP has MORE lines — sofa decomposition | **16 of 21** | expected; one AutoCount sofa line becomes one ERP line per compartment |
| ERP has FEWER lines, and is CORRECT | **2 of 21** | DO-000097 line 20982 is `"COLOUR : 885-4"`, DO-002544 line 282781 is `"* PENDING 2PCS LATEX PILLOW WITH CS COVER"` — description-only rows, no item, correctly no ERP line |
| ERP has FEWER lines — **genuine gap** | **3 of 21** | DO-001953 (−2), DO-004903 (−2), DO-010332 (−1) — **5 missing delivery lines** |

Mechanism **PROVEN**, per-document counts **LIKELY** (predicted offline from the
snapshot, not read from the ERP).

A structural corroboration: **15 of the 21** were mirrored post-cutover by
`sync-ac-delta.mjs`, which is ALL-OR-NOTHING (`:784-789` refuses a whole delivery
if any book line fails to resolve). Those 15 **cannot** have lost a line. All
five ERP-FEWER cases sit in the 6 that came from the cutover cut, whose writer
logs a drop and creates the document anyway. **PROVEN.**

---

## 5. The four "sofa colour swaps" are a checker artefact. Do NOT change them.

Reported: `DO-011505` DtlKey 920097 book `PC151-01` / ERP `PC151-17` and DtlKey
920099 book `PC151-17` / ERP `PC151-01`; `DO-011478` the same shape with
`PC151-13` / `PC151-06`.

The two lines of each pair are **identical on everything the matcher uses**. The
keyless fallback buckets on `${qty}|${unitPriceSen}` then `${qty}`
(`check-ac-erp-reconcile.mjs:880-903`):

```
DO-011478  dtl=917532 "HOK-1007 (Q)" qty=1 price=0  COLOR:PC151-13
           dtl=917534 "HOK-1005 (Q)" qty=1 price=0  COLOR:PC151-06
```

Both land in bucket `1|0`, and they are the only two lines of that document in
it. Which ERP row gets which AutoCount row is decided **entirely by UUID order —
a coin flip.** `DO-011505` has *four* lines in bucket `1|0`.

Item code would have separated them, and the reconcile **suppresses it**:
`:315` sets `itemCodeDeclared`, so at `:941-946` every item-code disagreement on
a delivery order is counted as declared and never reported. The one signal that
would have exposed the mis-pairing is deliberately switched off.

Two corroborations that the ERP data is right:

1. **The colour multiset matches exactly on both documents** — same colours,
   permuted. An exact permutation on two separate documents is a pairing
   signature, not two independent data errors.
2. **This pipeline cannot produce a real cross-line colour swap.** The ERP DO
   line's colour is a straight copy of its own SO line
   (`migrated-do-writer.mjs:133`, `variants: t.variants ?? null`), and the book's
   sales orders carry exactly the colours the deliveries do
   (`SO-008172` → PC151-01, PC151-01, PC151-17; `SO-013142` → PC151-13, PC151-06).

**PROVEN artefact. No colour is wrong in the ERP.** Repairing these four values
would introduce the error the report was describing.

---

## 6. The two absent delivery orders — cause proven, and the repo's own note was wrong

`DO-001800` and `DO-005583` are genuinely in scope: the migration's scope
(`ac-partial-dos.json.gz`, 84 documents) and the checker's scope
(`lib/ac-scope.mjs:237-242`, 84 documents) are **set-identical, 84/84**, and both
contain them. **PROVEN.**

**Cause.** Both delivery notes ship a **substituted SKU** — an item code that is
not on the sales order they name:

| DO | Seq | shipped | the SO line at that Seq | qty |
|---|---|---|---|---|
| DO-001800 | 32 | `HB109NL` | `AK- LTX CLS PIL` | 3 / 3 transferred |
| DO-001800 | 48 | `HB109M-CC` | `NTYR-CS LTX PIL + CSC` | 3 / 3 |
| DO-005583 | 144 | `AK-SK FX AIRLOFT PIL` | `AK-SK + MICROFIL PIL` | 2 / 2 |

`buildMigratedDoPlan` matches on `${SoNo}|${erpCode}`
(`migrated-do-writer.mjs:107`); with no line of that code on the order, every
line of the document hits `stats.noSoLine` (`:125-130`) and **the document is
never created** — silently, with no name printed (`:184-192` logs only counts and
the first 5 examples). **PROVEN.**

**The repo's existing explanation is wrong.**
`docs/ac-reimport-2026-08-28-ledger.md:454` records:

> DO 71/73(差 2 = duplicate-guard 故意拒: DO-001800/DO-005583,其 SO 行已被别张 DO 认领)

`taken` is keyed `DoNo|SoNo|code` (`:110`) so it can never be exhausted "by
another DO", and `exhausted` requires `cands.length > 0`, which is false for
both. Measured `stats.exhausted = 0` over all 369 source rows. **PROVEN wrong** —
which is presumably why nobody chased these two for a week.

**The same defect silently shortens two documents that DO exist:** DO-001953 and
DO-004903 each lost 2 lines to the same substituted headboard codes. Total damage
**10 dropped rows of 369 (2.7%)** — 7 substituted SKUs and 3 rows whose
`ItemCode` is literally null.

### The candidate fix, measured — and why it is an OWNER decision, not a defect fix

A last-resort fallback in `buildMigratedDoPlan`, between the empty-`cands` branch
(`:119`) and the `noSoLine` refusal (`:125`): when code match and sofa-model match
both fail, fall back to the sales-order line at the **same AutoCount `Seq`**,
requiring `SO.Qty === DO.Qty`, `SO.TransferedQty === SO.Qty`, and that no earlier
line of the same note has claimed it.

Measured blast radius: **7 rows of 369 (1.9%)** — 2 new documents (DO-001800: 2
lines / 6 units; DO-005583: 1 line / 2 units) and 4 lines / 10 units belonging on
2 existing documents. The other 3 unresolved rows stay refused. No over-delivery
is created on any of the four orders.

**Why it needs the owner's word.** It is an INFERENCE, and this migration's
standing rule is *copies, never computes*. Quantified: across all 369 rows where
a DO line's Seq resolves to some SO line, **243 carry the same ItemCode and 27
carry a DIFFERENT one** — so a Seq-*first* matcher would mis-link **27 of 270
measurable rows (10.0%)**. Seq is only defensible as a guarded last resort.

**Cheaper alternative, also his call:** the underlying truth is that staff shipped
a substitute SKU. Correcting `DODTL.ItemCode` on those 7 lines in AutoCount makes
the existing matcher resolve them with no ERP code change at all.

---

## 7. The missing line LOCATION — the recommendation is NOT a new column

The book records a location per delivery line (`DODTL.Location`); the ERP has
nowhere to put it, so 353 book values land nowhere in the reconcile.

**Measured over all 47,329 AutoCount delivery lines** (`ac-fidelity-do-lines.json.gz`):

| finding | number |
|---|---|
| line location equals the header's `SalesLocation` | **46,182 of 46,194** non-blank |
| line location differs from the header | **12** |
| blank | 1,135 |
| **documents whose lines span MORE THAN ONE location** | **2 of 11,134** — `DO-000140` (PG+HQ), `DO-000153` (KL+SUNWAY) |

Distribution: KL 28,938 · PG 13,704 · SRW 2,055 · SBH 1,065 · HQ 417 · SUNWAY 15.
(It is six locations, not the two the question assumed.)

**PROVEN** (computed from the committed snapshot).

### The options

| option | cost | what it buys |
|---|---|---|
| **A. Do nothing** | zero | loses a value that is redundant on 46,182 of 46,194 lines |
| **B. Carry it at the HEADER** — `scm.delivery_orders.sales_location` already exists (`migrations-pg/0240` builds a trgm index on it) and the migrated DO writer simply never sets it | a few lines in `migrated-do-writer.mjs` + a backfill; **no migration, no schema change** | the location of every delivery, and the DO list can filter on it. Loses only the 2 documents in 11,134 that mix locations |
| **C. Add a per-line column** | migration + writer + UI + every reader that would now have two answers for one document | correctness on 2 documents of 11,134 |

**Recommendation: B, with one thing checked first.** `scm.delivery_orders.sales_location`
is used by `assrFormIntake.ts:944` as `sales_location: o.venue` — i.e. that column
may already mean VENUE on a delivery order, not warehouse. **UNKNOWN until read
against the live table**; if it does mean venue, B needs a differently-named
header column and the comparison is B vs C on cost, where B still wins.

A normal ERP does put stock location on the LINE, because a line can ship from a
different warehouse. This book does not use it that way: 2 documents in 11,134.
Option C buys the general case at the price of a schema change, two sources of
truth for one document, and a UI that must explain which one wins.

---

## 8. Still open

| # | item | state |
|---|---|---|
| 1 | **Stamp `linked_ac_dtlkey` (from `ac-partial-dos.DoDtlKey`) and `line_no` on migrated DO lines**, then backfill the 171 already written | NOT DONE. This is a pure COPY of AutoCount's own delivery-line key, not an inference. `check-ac-erp-reconcile.mjs:848-870` already handles the sofa 1:N split ("a second ERP line on the same AutoCount line = the sofa split"), so stamping it dissolves §4 and §5 together: the 26 become pairable and the colour artefact cannot recur. `sync-ac-delta.mjs:775-781` builds its rows without `DoDtlKey` and would need it added too. Neither `backfill-ac-line-keys.mjs` nor `backfill-ac-sofa-line-keys.mjs` touches delivery orders — **new code is required** |
| 2 | The 5 missing delivery lines on DO-001953 / DO-004903 / DO-010332 | need a LINE-level backfill; a re-dispatch will not do it, because both writers skip documents already mirrored |
| 3 | The 2 absent DOs — §6 | **owner decision**: the guarded Seq fallback, or correct the 7 lines in AutoCount |
| 4 | Line location — §7 | **owner decision**: A / B / C |
| 5 | The 5 unnamed documents of the 26 | UNKNOWN — raise `SHOW` above 20 and re-run the reconcile |
| 6 | The DO money comparison is CURRENCY-BLIND on 171 of 171 | the reconcile snapshot has no `docTotal` for DO; fixed for PO in `docs/bugs/0666`, and a re-cut of the snapshot is what closes it |
| 7 | `repair-migrated-do-prices` | plan run **34119785887** says **0 repairable** — 648 of 650 zero-priced lines have a sales-order line that is itself 0, and 2 deliver 0 units. There is nothing to apply. Do not dispatch it expecting a fix |

---

## 9. What is now PROVEN clean

- Delivery order **presence**: 171 of 173 in scope are in the ERP, 0 phantom.
- Delivery order **copied fields**: 82 of 82 headers, 353 of 353 lines.
- The four sofa **colours** flagged as swapped are correct in the ERP (§5).
- Goods receipts: the numbers land in `docs/bugs/0668` from the corrected run of
  `check-gr-fidelity.yml`. **The 86-invented headline of run 34134695504 is
  withdrawn** (§0).
