## The purchase-order line has no tool to keep AutoCount's Desc2 in its notes, so every re-import leaves book text unparked [medium]

**Symptom.** The owner, 2026-09-07, on a line card whose "Type remarks…" box was
empty: 「你要确保它的 Type Remark 这一边是有把 AutoCount 的 description 都写进来
的。」 Asked on 2026-09-04 where his original request applied, he had already
answered 「SO line 和 PO line 的 remarks」 — both sides.

The sales side has had a tool since 2026-09-04
(`preserve-autocount-desc2-in-remark.mjs`, `docs/bugs/0639-*`). The purchase
side got only the three RENDER seams (`docs/bugs/0640-*`), because the
migration had already filled `notes` on 923 of the 1,117 migrated company-1 PO
lines and the data therefore looked done.

**Root cause (traced, not inferred).** "Already filled" is a statement about one
moment, not about the table. The migration is not a standing process: it filled
`notes` on the lines it imported and nothing keeps a LATER line's book text
parked. The sales side proves the gap is real rather than theoretical, and the
measurement is the whole finding:

| sales-side run | date (MYT) | rows written |
|---|---|---|
| apply `33855560127` | 2026-09-04 16:52 | 4,139 |
| plan `34132679201` | 2026-09-07 22:23 | 200 still unparked |
| apply `34132958644` | 2026-09-07 22:26 | 200 |

200 lines arrived in three days carrying the book's wording and nothing had
parked it. The purchase side has had no equivalent run at all since the
migration, and no way to make one.

The column is `scm.purchase_order_items.notes`, not `remark` — a PO line has no
`remark` column. `notes` is the right home for the same two reasons the sales
twin uses `remark`:

- **Not regenerated.** The PO item PATCH recomputes `description2` from
  `buildVariantSummary` on every write, exactly as the SO route does.
- **Not on the write-back path.** `PO_ITEM_COLS`
  (`backend/src/scm/lib/autocount-outbox.ts:396-397`) is `id, item_code,
  item_group, description, description2, qty, unit_price_sen, variants,
  linked_ac_dtlkey, warehouse_id, delivery_date, photo_urls` — `notes` is
  absent. The only `notes` the write-back sends is the HEADER's
  (`purchase_orders.notes` → `Description`, `autocount-outbox.ts:1478`).

So `description2` can be lost on BOTH sides in one save, and a copy in the
line's `notes` survives every save and never reaches the account book.

**Fix.** `backend/scripts/preserve-autocount-desc2-in-po-notes.mjs` +
`.github/workflows/preserve-autocount-desc2-in-po-notes.yml` — the exact shape
of the sales twin: plan by default inside one rolled-back transaction, a CONFIRM
phrase on the apply path, and a fresh-connection re-read that asserts the SHAPE
(the note is a string, it ENDS with the book text byte-for-byte, and
`description2` is still what the plan read) rather than a row count.
`npm --prefix backend run audit:release-discipline` reports **no new
violations** — all four rules satisfied on a new script, no grandfathering.

Two deliberate differences from the sales twin, both because this table's
history differs:

- **A note that already CONTAINS the book text is skipped, not relabelled.**
  891 of the 1,117 lines hold `notes` byte-identical to `description2` and 32
  hold it plus a suffix (`docs/bugs/0640-*`). Relabelling them would churn ~923
  production rows to prepend a label a reader gains nothing from.
- **The discard list is the review, and the header says so.** The sales table's
  663 occupied remarks were grouped and shown to the owner, who then ruled
  「如果是我们导入的就不需要」. The occupied notes on THIS table have never been
  enumerated for him, so `shape=overwrite` prints every value it would drop, in
  full, in the plan run, with an instruction to switch to `shape=append` if any
  looks like a person's typing rather than an importer's.

**RUN, and what it found (2026-09-07, all times MYT).** The tool's first plan
died on a copied column name — `docs/bugs/0673-*`, fixed the same hour, nothing
written. It then ran for real:

| run | mode | time | result |
|---|---|---|---|
| [`34137460950`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34137460950) | plan | 23:19 | 47 to write, **0 to discard**; rollback HELD |
| [`34137603133`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34137603133) | **apply** | 23:24 | **52 written**; 52/52 re-read on a fresh connection carrying the book text byte-for-byte; `description2 moved: 0` |

The apply wrote 5 more than the plan because the corpus grew from 1,328 to
1,333 migrated lines in the five minutes between them — the tool reads live and
re-decides, which is the behaviour wanted, and it is why a plan count is a
forecast rather than a contract.

**The measured shape of the purchase side**, from the apply's BEFORE block:

| | lines |
|---|---|
| migrated company-1 PO lines | 1,333 |
| carry a `description2` (the book's wording) | 1,094 |
| `notes` already CONTAINED that wording — skipped, not relabelled | 1,042 |
| `notes` empty and the book had text — **filled by this run** | **52** |
| the book holds no Desc2 at all — blank stays blank | 239 |

**Zero rows were discarded**, on the plan and the apply alike, so the header's
"read the discard list before applying" caution turned out to be moot on this
table: every occupied note already held the book's words. The caution stays,
because that is a fact about today's data and not a property of the script.

**Not fixed here, and named so it is not mistaken for done:** the root overwrite
itself. `description2` is still regenerated on every save on both tables. These
scripts preserve the text; they do not stop the overwrite. Same open item as
`docs/bugs/0639-*`.

**Ref.** `feat/ac-desc2-remark-visible`, 2026-09-07.
