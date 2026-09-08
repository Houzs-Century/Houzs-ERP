## A hand-typed model in the sofa corrections file outranked the book, and nothing graded it [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Three sofas whose sales order AND purchase order agree with each
other and both disagree with the account book. The owner, 2026-09-08:
*"账本跟我们写的不一样呢，我们一定要对回账本啊，所以你可能是其他的文件有问题"* and
*"你的 SKU 会选择跟我们的账本不一样的 SKU 呢?"*

| order | customer | book item code | book model | ERP held |
| --- | --- | --- | --- | --- |
| `HC-SO-010882` | Tee | `DSL-8030 SOFA` | 8030 | 9058 |
| `HC-SO-011660` | Sulaiman | `AMN-SF9058 SOFA` | 9058 | 8030 |
| `HC-SO-012629` | KONG KIT YING | `HOK-5535 SOFA` | 5535 | 8030 |

**Root cause (traced).** Not the importer. Run against the book's own rows from
today's cut, `import-ac-outstanding-so.mjs`'s model derivation —

```js
let model = (erp || "").replace(/-1S$/i, "");
model = SOFA_MODEL_ALIAS[model] || model;
```

— produces the book's answer on all three, pieces included:

```
Tee            DSL-8030 SOFA   -> 8030-1S -> 8030   pieces 8030-1A(LHF), 8030-CNR, 8030-2A(RHF)
Sulaiman       AMN-SF9058 SOFA -> 9058-1S -> 9058   pieces 9058-1B(LHF), 9058-CNR, 9058-2A(RHF)
KONG KIT YING  HOK-5535 SOFA   -> 5535-1S -> 5535   pieces 5535-1A(LHF), 5535-CNR, 5535-2A(RHF)
```

Those piece lists are byte-identical to the ones
`data/sofa-compartment-corrections-2026-08.json` states. **Only the MODEL
differs**, and it differs because the file states one as a free-standing string
and `apply-sofa-compartment-corrections.mjs` takes it verbatim:

```js
const model = K(c.model || modelOf(rows[0].code));
```

The fallback arm is the safe half — with no `model`, the applier keeps what the
importer derived from the AutoCount item code, which is the book's own answer.
The STATED arm had nothing grading it, so a typed value silently overwrote a
correct one and the ERP has disagreed with the book since 2026-08-10.

Read in the file's original order (`git show 78de4d942`), rows 1 and 4 hold each
other's model and row 3 holds a fold that does not exist:

```
1  HC-SO-010882  model 9058   book 8030    <- these two
4  HC-SO-011660  model 8030   book 9058    <- are swapped
3  HC-SO-012629  model 8030   book 5535    <- 5535 is deliberately NOT in SOFA_MODEL_ALIAS
```

Every one of those three `why` fields argues the PIECES only — "Desc2 1R+C+2R",
"Desc2 1B+C+2R". The model was carried along, never justified. That the swap is a
transcription slip is LIKELY, not proven; what is PROVEN is that nothing ever
compared the stated model to the item code on the same book line.

This is the inverse of `docs/bugs/0689-the-reconcile-read-the-mapping-sheet-with-split-comma-so-40.md`
and of the `?? "others"` classification miss: there a silence became a value,
here a hand-typed value outranked a derived one. Same root shape — **two
descriptions of one fact and nothing comparing them.**

**Fix.** Three things, in one PR.

1. The three entries in `data/sofa-compartment-corrections-2026-08.json` now
   carry the book's model, each with the book's own DtlKey in its `why`. The
   Sulaiman entry's document list also moves from `HC-PO-010026` to
   `HC-PO-009017`: the book raises that sofa's purchase order as `PO-009017`
   (`PODTL` 829659, `FromSODtlKey` 803503), while `PO-010026` is a bedframe
   (`NB-KHA01(K)`) on another customer's order.
2. `scripts/lib/sofa-corrections-book-grade.mjs` + `check-sofa-corrections-vs-book.mjs`
   grade EVERY entry in both files against `data/ac-reconcile-truth.json.gz`,
   folding through `SOFA_MODEL_ALIAS` and reporting an alias agreement as its own
   verdict rather than as agreement. Offline, read-only, exit 0 on any answer.
3. `tests/sofaCorrectionsVsBook.test.mjs` makes a re-assertion a CI failure. It
   was proved RED on the unfixed tree — reverting the KONG KIT YING entry to
   `8030` fails with the document and both models in the message:

```
AssertionError: expected [ Array(1) ] to deeply equal []
+   "HC-PO-009712+HC-SO-012629 file=8030 book=5535"
```

**Applied.** Per DOCUMENT, never as a whole-file run - the file also holds an unapplied insert for HC-SO-012929 that belongs to another lane. Runs 34188339400 / 34188392136 (Tee), 34188453353 / 34188506374 (Sulaiman), 34188567217 / 34188619213 (KONG KIT YING), each VERIFY OK on a fresh connection with both money columns unchanged. Probe 34188689460 re-read all six documents afterwards: every purchase-order row still dedicated to the sales-order row with the SAME code. Reconcile 34189267879: sales-order item-code differences 10 -> 1, purchase-order 9 -> 0.

**Ref.** fix/sofa-book-model-2026-09-08, 2026-09-08 (#3185, #3190). Supersedes the OPEN status
of `docs/sofa-model-disagreement-2026-09-08.md`.
