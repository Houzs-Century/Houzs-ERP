## The purchase order told the factory to build the other end piece, because the supplier code never moved with the item code [high]

**Symptom.** The owner, 2026-09-11, on HC-PO-2609-053: 「我说的是 PDF 跟里面内容
不一样，你看为什么那么奇怪？」 The screen and the PDF put a different piece on the
same row:

| row | our code (screen) | Supplier Code (PDF, what the factory builds from) |
| --- | --- | --- |
| 1 | `8030-`**`1A(LHF)`** | `5540-`**`L(LHF)`** |
| 2 | `8030-1NA` | `5540-1NA` |
| 3 | `8030-`**`L(RHF)`** | `5540-`**`1A(RHF)`** |

The build's two end pieces are **exchanged**, and the document itself says which
column the supplier acts on: *"Item codes shown are SUPPLIER codes; our model &
reference appear in the Description."* So Hookka was told to make a lounger where
we need an arm, and an arm where we need the lounger.

**Root cause (traced, not guessed).** Nothing crossed them at convert time:

- the master binding is **correct** — `8030-1A(LHF)` → `5540-1A(LHF)` for Hookka
  Industries;
- `scm.entity_audit_log` holds **exactly one** entry for that PO: `CREATE`,
  2026-09-10 02:53, raised from HC-SO-013503, never edited.

So the convert copied `supplier_sku` from the sales-order line's code **as it
stood then**, and the code was corrected afterwards. The correction moved
`item_code`, and (since docs/bugs/0818, the same day) the printed NAME — and no
writer has ever moved `supplier_sku`. Three writers, three different subsets of
the same row:

```
item_code only ......... every writer, from the start
+ the printed name ..... taught 2026-09-11 (0818)
+ supplier_sku ......... never, until this entry
```

**Measured across the whole system** (owner: 「你查看一下全套系统，看有没有类似的
问题，都要同一时间解决掉」) — 14 printed line tables, every column on them that
can state a piece, company 1:

```
purchase order    supplier_sku   24   <- never swept; the factory reads it
goods received    supplier_sku   13   <- never swept
purchase invoice  material_name   7   <- this table had no arm at all
purchase order    material_name   4   <- its `description` holds the supplier's own
                                         model name, so the earlier sweep looked
                                         at that column and left this one
sales order / delivery order / goods received  name    0   (swept 2026-09-11)
sales invoice, purchase return, delivery return,
and all six consignment tables                         0
```

48 values on 28 documents. Company 2: **0**.

**Two traps this census walked into first, both now pinned as named test cases.**

1. Comparing the matcher's own capture against the code's piece reported **67
   false positives** on the sales-order arm — every recliner code
   (`8050-1A(R)(LHF)` beside "SOFA LAZIO 1A(R)(LHF)") read as a mismatch. The
   comparison has to ask *"does this text state OUR piece, delimited"*, not
   *"is the first token I can find equal to it"*.
2. The delimiter test must not run on whitespace-SQUASHED text: squashing deletes
   the very space that separates the model word from the piece, so every name
   reads as undelimited. This is the second time this matcher has produced a
   wrong count from a subtle boundary bug — the first, a trailing `\b` after a
   token ending in `)`, reported 0 findings on 17 real ones.

**Fix.** One rule in one place, and every writer calls it.

- `backend/scripts/lib/sofa-piece-token.mjs` — `pieceOf` / `namesAPiece` /
  `disagrees` / `movePieceTo`, with `assertMatcherSane()` that throws before any
  caller reads a row. 14 cases in `backend/tests/sofaPieceToken.test.mjs`,
  including both regressions above.
- `backend/scripts/lib/align-sofa-piece-columns.mjs` — the step a WRITER calls
  with the row whose code it just changed. Resolved from the table, never
  assumed, so a new sibling column is added here once instead of in three
  scripts.
- `backend/scripts/repair-sofa-line-shown-vs-code.mjs` + its workflow — the
  system-wide sweep, replacing `repair-sofa-line-name-to-code.mjs` [gone], which
  examined ONE column per row (`description` when present, else
  `material_name`). That is right for what PRINTS and wrong for what is STORED,
  and it is exactly how those 4 purchase-order rows were classified as "the
  supplier's own product name" while a stale piece sat in the column beside it.
  Two overlapping repairs over the same rows is a hazard, so the old one is
  deleted rather than left running.
- `apply-sofa-compartment-corrections.mjs` and `rename-sofa-line-in-place.mjs`
  now align every piece column inside the transaction that moves the code, so no
  window exists in which a row states two different pieces. The rename tool's
  private copy of the matcher is gone.

**ONLY the piece token moves.** A supplier code keeps the supplier's own spelling
— `HOK-5540 SOFA 2A(LHF)` → `HOK-5540 SOFA 1A(LHF)` — rather than being replaced
from a master row whose spelling has since changed: a document is a snapshot of
what was sent. A column stating no piece is left exactly as it is; 373 purchase
lines and 47 receipt lines carry the supplier's own model name by design.

**Closed documents are corrected too**, by the owner's decision the same day (he
chose 甲): a received purchase order and a posted invoice are still read back and
reconciled against, so a wrong piece left on one misleads a second time. The
repair writes one text column per row — no money, no quantity, no status, no
stock.

**Ref.** `fix/sofa-shown-vs-code-sweep`, 2026-09-11. Supersedes
docs/bugs/0818-a-corrected-sofa-line-kept-the-old-piece-in-its-printed-name.md.
