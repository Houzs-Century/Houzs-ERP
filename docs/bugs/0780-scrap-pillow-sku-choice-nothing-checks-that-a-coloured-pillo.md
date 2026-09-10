## Scrap pillow SKU choice: nothing checks that a coloured pillow sits on the CUSTOM SKU [medium]

<!-- area: Cutover + migrated data -->
<!-- status: owner-decision -->

**Symptom.** The owner, 2026-09-10: *"并且你要确保我的 scrap pillow 是选对的:
1. 有颜色的是选 custom scrap pillow 2. 没有颜色是选 random。另外,你之前查回去一下
我的 AutoCount 记录,之前 SKU 我不确定你有没有选对,可能你选错了。如果 proceed 了
这个单呢,custom SKU below 一定会写有颜色的;还没有 proceed 的呢,那可能就没有"*

In plain terms: a scrap pillow whose colour the customer chose belongs on the
CUSTOM item; one with no colour belongs on the RANDOM item; and the colour is
only required once the order has been PROCEEDED — an unproceeded order may
legitimately be blank, which is his standing rule of 2026-09-04:
"还没proceed还没确认的就可以直接放空的". He suspects the cutover picked the wrong
one on some lines.

**Root cause (traced, and it is a MISSING RULE rather than a broken one).**
Nothing in this system ever enforced, or even measured, the pairing. Traced in
the tree rather than guessed:

- `REQUIRED_VARIANT_AXES_BY_CATEGORY` (`backend/src/scm/shared/so-variant-rule.ts`,
  mirrored for scripts in `backend/scripts/lib/variant-axes.mjs`) declares
  required axes for **`bedframe` and `sofa` only**. A pillow is `accessory`, so
  no colour axis is required of it at confirm time or at Processing-Date time,
  and no gate can therefore notice a coloured pillow on the wrong item.
- Until PR #3507 landed on 2026-09-10 there was nowhere on the Sales Order to
  TYPE a custom pillow's colour at all — the owner's first message in the same
  thread. So for the whole migrated corpus the colour lives in free text, not
  in a field.

**And AutoCount does not have the split at all, which is what makes this a
cutover question.** Measured on the committed snapshots, offline, with no
production access:

- `backend/scripts/data/align-skus-houzs-century.json` (AutoCount item export,
  2026-08-05, 1,242 rows): **zero item CODES** contain `(CUSTOM)` or
  `(RANDOM)`. **Three item NAMES** contain `(CUSTOM)` —
  `AMN-SQUARE PILLOW` → `AMN-SQUARE PILLOW (16"x16") (CUSTOM)`,
  `DSL-SQUARE PILLOW`, `HOK-SQUARE PILLOW`. **No name anywhere says RANDOM.**
- `backend/scripts/data/ac-live-item-master.json.gz` (AutoCount live,
  2026-09-09, 1,591 items): 32 codes mention PILLOW; none says CUSTOM or RANDOM.
- `backend/scripts/data/ac-fidelity-so-lines.json.gz` (60,939 book SO lines,
  2026-08-11): the book states the distinction in the **line text**, not the
  code — `[ COL: HUGYP 3383-6 ]`, `Col: J9883-10-MOGANO` on one side;
  `COLOUR: RANDOM`, `col: random`, `randome colour` on the other. Of the **727**
  scrap-pillow lines in that snapshot the classifier reads **204 as naming a
  colour, 203 as saying random, 78 as TBC/KIV** and the rest as saying nothing
  decidable.

So the CUSTOM/RANDOM choice was made on OUR side, per line, by reading that
text — which is exactly where a wrong pick would come from, and it had never
been measured either way.

**Fix — this entry ships the MEASUREMENT, not a repair.**
`backend/scripts/check-scrap-pillow-sku-choice.mjs` +
`.github/workflows/scrap-pillow-sku-choice.yml` cross-tab every scrap-pillow
sales-order line by SKU family x colour recorded x order proceeded, and print
AutoCount's own words for each mismatch beside our choice. Read-only: SELECTs
only, no DDL, no writes, no transaction, no APPLY. It deliberately does **not**
propose re-coding a line — changing a live document's item code moves stock and
can move money, so that is the owner's decision and a separate gated script.

The text classifier was proved against the real corpus before being wired to
production: run over all 727 book scrap-pillow lines, with the fabric library
stubbed out, its residue was inspected string by string, and `Col -02 Beige#`,
`col - JF236-4 dark linen`, `Col：GD8371-02#Beige` (a full-width colon) and
`rondom` are in its patterns because they are in the data, not because they were
imagined.

**MEASURED ON PRODUCTION.** Run
[34455827116](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34455827116),
`success`, 2026-09-10, company 1. Population: **330 scrap-pillow sales-order
lines across 294 orders**, none cancelled, 122 on a PROCEEDED order.

**1. The two families DO exist here — AutoCount has no such split, so they were
minted on this side.** Nine scrap-pillow products, and the family is readable
only from the NAME:

| family | code | name |
| --- | --- | --- |
| CUSTOM | `SQUARE PILLOW` | `AMN-SQUARE PILLOW (16"x16") (CUSTOM)` |
| RANDOM | `AMN-SOFA PILLOW` | `AMN-SOFA PILLOW (RANDOM) (FREE GIFT)` |
| RANDOM | `SOFA PILLOW (FOC)` | `SOFA PILLOW (FREE GIFT) (RANDOM)` |
| neither | `THL-SOFA PILLOW` | `SOFA PILLOW (FREE GIFT)` |
| neither | `LONG PILLOW`, `822 SQUARE PILLOW`, `823 LONG PILLOW`, `5142 PILLOW`, `5543 LONG PILLOW` | the supplier long/square pillows |

`SOFA PILLOW (FOC)` and `THL-SOFA PILLOW` carry the SAME name, `SOFA PILLOW
(FREE GIFT)`, and only one of them says `(RANDOM)`. That is the same
two-identities-one-piece shape as `9058-Console` / `9058-CONSOLE`, and it splits
stock and demand between them.

**2. The colour is in NO structured field on ANY of these lines.** Measured over
all 330:

```
    0 / 330  variants (structured colour keys)
    0 / 330  variants.extraAddonNote
  289 / 330  description2                  COLOUR=131 PENDING=87 RANDOM=51 NONE=20
  295 / 330  remark                        COLOUR=130 PENDING=90 RANDOM=52 NONE=23
```

The only key present in `variants` anywhere is `variants.remark`, on 5 lines. So
every colour these lines have is FREE TEXT, and the Special Order field shipped
on 2026-09-10 (PR #3507) is empty on all of them — which is what the AutoCount
backfill stream exists to fill.

**3. The cross-tab.** Family x colour x proceeded, the four numbers that decide:

| | lines |
| --- | --- |
| **A. CUSTOM SKU, no colour, order PROCEEDED** (the owner's hard defect) | **2** |
| **B. RANDOM SKU but a colour IS stated** (wrong SKU the other way) | **9** |
| **C. CUSTOM SKU, no colour, NOT proceeded** (LEGITIMATE, not work) | **11** |
| **D. on NEITHER family** | **59** |
| E. CUSTOM SKU, colour TBC/KIV, proceeded | 0 |
| F. CUSTOM SKU whose own text SAYS random | 9 (1 proceeded) |

Both of A are text that is present and is not readable as a colour, not blanks:
`HC-SO-010214` line 3 holds `CH151-5 (PEARL)` — a colour CODE the fabric library
cannot look up (it holds `CH141-5`, not `CH151-5`) — and `HC-SO-012128` line 3
holds `FOR CONPESSANTION WRONG ITEM DELIVERY`. So the true count of proceeded
CUSTOM pillows with no colour anybody wrote down is **at most 2, and arguably 1**.

**4. The migration copied the book FAITHFULLY. What it did not do is pick the
SKU to match what it copied.**

```
  book NAMES a colour, we sit on the RANDOM SKU : 8
  book says RANDOM, we sit on the CUSTOM SKU    : 7
  book NAMES a colour, our line carries NONE    : 0
  book says RANDOM, our line carries a COLOUR   : 0
  book is SILENT about colour on this line      : 31
  no book line at all (post-snapshot / unlinked) : 82
```

**Zero colours were dropped and zero were invented** — those are the two ways a
migration corrupts text, and neither happened. The defect is **15 lines whose SKU
family contradicts the book's own words on the same line**, which is a different
fault with a different remedy.

**One value divergence found and NOT explained here.** `HC-SO-010120` line 2
holds `HR805-10` in `description2` while the book's Desc2 for the same DtlKey
reads `colour : B0315-29`. The probe compares the KIND of statement, not the
VALUE, so it cannot say whether that is a post-cutover correction by staff or a
mis-copy. **UNKNOWN — it needs its own look.**

**5. The purchase-order side**, which is the document the owner actually asked
about: 82 scrap-pillow PO lines — 59 CUSTOM/colour, 18 neither/colour,
2 CUSTOM/none, 2 CUSTOM/random, 1 RANDOM/random.

**Ref.** `audit/scrap-pillow-sku` (probe, PR #3533),
`audit/scrap-pillow-sku-results` (this measurement), 2026-09-10.
