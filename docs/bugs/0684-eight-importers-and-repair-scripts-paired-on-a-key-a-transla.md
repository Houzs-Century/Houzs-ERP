## Eight importers and repair scripts paired on a key a translation had already made ambiguous [high]

Sites **4, 5, 7, 8, 9, 10, 16 and 20** of the bug class
[`0672`](0672-bug-class-key-without-identity-a-link-written-on-the-key-alo.md).
Every one writes or rewrites a pairing from a key, and every one had the same
hole in a different disguise.

---

### The measurement that made two of these cheap to guard

`probe-link-identity.mjs` **run 34172468269, 2026-09-08 08:13 local**, against
production. `0672` left the duplicate-`linked_ac_dtlkey` question UNKNOWN
because its discriminator asked whether the rows naming one key have different
ITEM CODES and answered 295 of 296 — worthless, since a sofa's compartments
always do (`MODEL-1S`, `MODEL-2S`, `MODEL-CNR`).

Replaced by the two tests that can actually separate the cases:

| table | rows keyed | keys on >1 row | rows | same MODEL | different MODELS | on >1 DOCUMENT |
|---|---|---|---|---|---|---|
| `mfg_sales_order_items` | 14,807 / 15,623 | 310 | 774 | **310** | **0** | **0** |
| `purchase_order_items` | 1,298 / 1,532 | 106 | 275 | **106** | **0** | **0** |

**PROVEN: every shared AutoCount line key in production is one book line
expanded into a sofa's compartments.** Zero collisions, on both discriminators
independently, largest group 6, none crossing a company. So the guards at sites
8 and 9 refuse nothing today and refuse the first group that ever regresses.

---

### Site 20 — the one detector that compared item codes could not see the damage state

`scripts/audit-mrp-pairing.mjs`. Its (C2) block compares each PO line's
`item_code` with its stored SO line's — the only item-code detector in the file
— and it iterated `poOpen`. `poOpen` drops a line **the moment it is fully
received** (`if (left <= 0) continue`), and fully received is exactly the state
all nine wrong dedications of `0671` converge on: the goods ARRIVED, so the
customer's order reads READY against a bed that is not theirs.

So it answered *"which OUTSTANDING lines disagree"* and printed as though it had
answered *"which lines disagree"*. **A detector blind to the finished state is
not a detector; it is a report about the unfinished one.**

**Fixed:** a second list `poAll` carries every live line; the ITEM CODE half runs
over it and prints how many of its hits are already fully received. The warehouse
and variant halves still count open lines only — a received line's warehouse is
history — and every shortage and pairing figure in the file is untouched, so the
outstanding numbers stay comparable.

### Site 5 — the inverted one: it rewrote the PRODUCT from the link

`scripts/open-5526-model.mjs`. Its follow-on statements were
`UPDATE … SET item_code = <new> WHERE so_item_id = <parent>` with **no predicate
on the code the row currently states**.

That is worse than a wrong link, because it destroys the evidence. If a
downstream row's `so_item_id` points at the wrong parent — `0671` put nine such
rows in production — this restamps that row's `item_code` to the parent's new
code, **making the two sides AGREE**. `probe-link-identity.mjs` compares exactly
those two columns, so this script could erase its own findings.

**Fixed:** every follow-on names its OLD code (`AND item_code = <old>`), and rows
that do not state it are left untouched and **counted** under
*"downstream rows LEFT ALONE because they do not state the code being migrated
from"*. A non-zero there is a finding.

### Site 7 — the equal-count refusal passed BECAUSE the merge made the counts equal

`scripts/backfill-ac-line-keys.mjs` buckets AutoCount rows by
`(DocNo, TRANSLATED erp code)`. Measured on this tree's own
`data/autocount-erp-mapping-1561.csv`: 1,577 rows, `ac_code` distinct 1,577, but
`erp_code` distinct only **1,445 — 117 ERP codes are claimed by two or more
AutoCount codes, and 249 rows (15.8%) sit on a shared ERP code.**

So a bucket can hold lines that are different products in the book, and the
positional zip hands an ERP line a key belonging to one of the others. The
existing equal-count refusal cannot catch it: the counts agree **precisely
because** the merge made them agree — the bug class exactly, a check that answers
a different question and prints like a clean one.

**Fixed:** the AutoCount ItemCodes behind each bucket are carried, and a bucket
built from more than one is refused and counted.

### Site 4 — two translations from two different source codes, never compared

`scripts/import-ac-so-linked-pos.mjs:320`. The general (non-sofa) bind resolved
`FromSODtlKey` to a sales-order line, then asked for the SO line carrying the
**SO's own** AutoCount code translated. The purchase line's own `l.erp` — the
translation of the **purchase** line's AutoCount code — was never compared. Two
translations from two different source codes through a non-injective mapping can
differ while the key pair still resolves.

**Fixed:** it binds only when the two translations agree, and counts the
refusals. The SOFA paths are deliberately NOT gated — their placeholder bind is
an owner-sanctioned mismatch (a build's `${model}-1S` against a compartment code)
and is already counted separately as `sofaPlaceholderBind`.

### Sites 8 and 9 — "the first row" of a group nothing proved was one product

`scripts/backfill-photo-urls-from-keys.mjs` and `scripts/lib/line-photo-keys.mjs`
(`planRepoint`) both take the first row of a group keyed on
`(doc_no, linked_ac_dtlkey)` — which is not unique. Taking the first is the
owner's own sofa rule (2026-08-10, 「每个 SKU 的照片都一样,留第一个就可以了」)
when the group is one build's compartments, and a coin flip when it is not.

**Fixed:** both assert the group is ONE MODEL first (`scripts/lib/one-model-group.mjs`).
The MODEL and not the item code, because compartments deliberately differ in
code — comparing codes would refuse every sofa, which is the entire population
this planner serves.

**A test that passed for the wrong reason, caught and recorded.** The first draft
of `planRepoint`'s three fixtures put the live key on a row INSIDE the group
under test, so the function's `shows` short-circuit returned `[]` before any
model test could run and **all three passed against the unfixed code**. That is
this bug class wearing a test's clothes, and the same shape `0672` records the
PR #3076 guard falling into once already. The key now lives on a row with a
different DtlKey, and the corrected fixtures fail RED (2 of 3) as they should.

### Site 16 — a bare number was silently given a series

`scripts/lib/fabric-colour-match.mjs`. A document that writes `03` and nothing
else had `PC` prepended and matched `PC03`. In the owner's data that is usually
right, which is why the pass exists and why it stays — deleting it would lose
real matches on real documents. What was wrong is that the answer came back
**indistinguishable from a colour the document actually named.**

**Fixed:** `assumedSeries` rides the result, exactly as `padded` and `redirected`
already do and for the reason that file's header gives. `propose-sofa-colour-matches.mjs`
now prints `*** THE SERIES WAS ASSUMED ***` and can never rate such a match
`HIGH`. Nothing is refused; the assumption is put in front of the person
confirming it.

### Site 10 — logged, and raised as a decision

`scripts/import-so-line-photos.mjs`, `scripts/import-po-line-photos.mjs`. The
key branch is correct (bug `0624`); the fallback for lines with no key takes the
first of several same-code candidates, which can differ in COLOUR. Refusing
would lose the photograph, and a sofa without a picture has a real operational
cost — so this one is a genuine trade. **The ambiguous groups are now counted and
each is logged with its candidates' variants**, so the size is a number instead
of an assumption. Options and a recommendation:
`docs/link-identity-open-decisions.md`.

---

### Proved RED first

```
scripts/lib/line-photo-keys.test.mjs   pass 9  fail 2   (site 9, corrected fixtures)
```
After: `pass 11 fail 0`. Sites 4, 5, 7, 8, 16 and 20 are one-shot scripts against
production data with no local fixture; each was verified by `node --check` and by
reading the changed statement against the query it replaces. **That is weaker
evidence than a red test and is stated as such.**

### UNTESTED as a remedy — and this matters more here than usual

**Not one of these scripts was executed.** They are importers and repair tools;
every change makes a future run write LESS or say MORE. **Nothing here repairs a
row, and no count in this entry was produced by running any of them.** The only
numbers measured against production are the probe's, named with their run id.

Site 20's fix in particular is a claim about what a FUTURE audit run will see,
not a report of what it saw.

**Nothing moves stock or readiness.** No script here was run in APPLY mode, and
the two guards added at sites 8 and 9 only ever cause fewer rows to be written.

**Ref.** fix/link-identity-14b, 2026-09-08. Class: `0672` sites 4, 5, 7, 8, 9,
10, 16, 20.
