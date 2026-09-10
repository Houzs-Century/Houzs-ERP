# Special-order TEXT: where it can be typed, where it must show, and getting the old ones back

**Owner ask, 2026-09-10.** Three messages, one thread. Read them in order — each
one widens the last, and the third is the one that has to survive a handoff.

1. 「我有一些单一的SKU 好像mattress SP和这个custom 需要选颜色 SP需要写尺寸 这种我可以
   在哪里填写呢？」 — there was nowhere to type a custom pillow's COLOUR or an SP
   mattress's SIZE.
2. On seeing it work on the Sales Order: 「你确定是 CS order 有而已，还是全部吗？我们
   的包括 DO 等等，全部都是要带过去的哦，要不然你有 column 的话也带不过去。POGR 是不是
   也是要能看得到这些数据？…简单来说，它的跑法应该跟正常的 bed frame 和 sofa 是一样的」
3. 「查回去autocount的记录…把这些资料抽取回来，然后放回进去这个 column…当我们发给
   Supplier PO 的时候，他才能看得到这个 pillow 是什么颜色的，然后 mattress 是什么尺寸，
   以及我们的 dining table、dining leg、dining chair 是什么款式」

**The business outcome he is buying**, in one sentence: the supplier's purchase
order must say what the pillow's colour is, what size the SP mattress is, and
which dining款式 was ordered — instead of that living in a remark, in AutoCount,
or in somebody's head.

---

## Where the work is

| stream | worktree | branch | state |
| --- | --- | --- | --- |
| A. the field exists on the Sales Order | (removed, merged) | `feat/so-custom-note-all-categories` | **SHIPPED + DEPLOYED** — PR #3507, deploy run 34446155533 `success` |
| B. it must carry to PO / GRN / PI / PR / adjustment | `hz-baseline-worktrees/special-carry-through` | `fix/special-carry-through` | **IN PROGRESS** — this file's tree |
| C. backfill the old specs out of AutoCount | (delegated) | — | brief below |

A fresh worktree has NO `node_modules`: `npm run install:all` before anything.

---

## A. What already shipped (do not redo)

`frontend/src/vendor/scm/lib/special-order-surface.ts` — one module, its own
tests, read by the desktop card and by both mobile call sites. It answers TWO
questions separately:

- `block` — does this line get the standalone Special Order panel?
- `optionPicker` — inside it, may the operator TICK a catalogue add-on?

| line category | panel | checkboxes |
| --- | --- | --- |
| sofa, bedframe | inside their own configurator | yes |
| mattress | yes | yes |
| accessory, others | yes | **no — free text only**, unless the line already carries a pick |
| service | no | no |

**Why the checkboxes stay shut on accessory/others and the free text does not.**
`computeVariantKey` (`backend/src/scm/shared/variant-key.ts:106`) builds a line's
stock bucket from the group's own attributes plus `normSpecials(a.specials)`. A
ticked add-on therefore appends `special=…` and SPLITS the bucket, which for
goods that pool by item code stops a line matching its stock and the purchase
orders raised for it. `extraAddonNote` is read by NO branch of that function.
**Describe freely, re-key never.** This is the answer to the owner's 「它其实是当成
variant 来看到的嘛，对吗？」 — the TICKED options are part of the identity; the free
TEXT is carried and printed but never changes what the line is.

**The note already prints.** `buildVariantSummary` appends the `SPECIAL:` segment
AFTER the per-group attribute branch, not inside it, so a category contributing
no attributes still carries its note — and `description2` on a purchase order is
exactly this string. Pinned in
`backend/src/scm/shared/variantSummarySuperseded.test.ts`.

---

## B. The carry-through gap — MEASURED, not assumed

The owner is right, and here is the evidence rather than agreement.
`SpecialOrders` is the one shared editor for every document, but each caller
decides for itself whether to render it, and every cost document gates on
bedframe/sofa:

| file | gate | mattress / accessory / others |
| --- | --- | --- |
| `frontend/src/vendor/scm/components/PoLineCard.tsx:510,567` | `l.category === 'bedframe'` / `=== 'sofa'` | **nothing rendered** |
| `frontend/src/pages/scm-v2/GrnNew.tsx:1247` | inside a bedframe/sofa branch; options are `l.itemGroup === 'bedframe' ? bedframe : sofa` | **nothing rendered** |
| `GoodsReceivedDetail.tsx`, `PurchaseInvoiceNew.tsx`, `PurchaseOrderNew.tsx`, `PurchaseReturnNew.tsx`, `StockAdjustmentNew.tsx` | each inside its own bedframe/sofa branch | **to be confirmed line by line — do not trust this row, open each one** |
| DELIVERY ORDER | `SpecialOrders` has NO delivery-order call site at all (`git grep -n "<SpecialOrders" -- frontend/src`) | **nothing rendered** |

**The distinction that matters, and it is not obvious:** the note PRINTS on the
purchase order regardless of the editor UI, because `description2` is stamped
server-side from `buildVariantSummary`. So the supplier's document is already
correct once the text exists. What is missing is the operator being able to SEE
and EDIT it on the PO/GRN screen — which is what the owner asked for, and also
what stops somebody re-typing it.

**Rule for the fix:** the same shared module, extended — never a second copy of
the gate per document. The cost documents pass `showPrices={false}` (the selling
surcharge is not theirs to show), and a PO/GRN line linked to a parent passes
`sourceLinked` so the value is read-only with an explicit Override.

---

## C. Backfill from AutoCount — the source is ALREADY HALF INSIDE THE ERP

Do not go to the office host for this. Read
`backend/scripts/preserve-autocount-desc2-in-remark.mjs` in full first — it
solved the same sourcing problem on 2026-09-02 and its header is the map:

- `scm.mfg_sales_order_items.description2` is the FRESHER book copy (the
  2026-08-28 re-import wrote it straight from the book; 14,342 of 14,445
  migrated lines carry that `created_at`).
- `backend/scripts/data/ac-line-desc2.json.gz` is AutoCount's own Desc2 keyed by
  DtlKey, snapshot 2026-08-11 — OLDER, but it recovers lines the re-import left
  blank. Neither source alone is complete.
- That script has already copied the book's wording into
  `scm.mfg_sales_order_items.remark` under the label `账本原文:`, so for many
  lines the text is sitting in the ERP right now.

**The guard that makes this a COPY and not a re-derivation** (the migration's
standing rule): `buildVariantSummary` is re-run per line from that line's own
`item_group` + `variants`, and a value that EXACTLY equals our generated summary
is EXCLUDED — it is our text, not the book's. 3 of 4,123 lines were excluded that
way on 2026-09-04.

**Scope for THIS backfill:** company 1, lines whose category is ACCESSORY,
MATTRESS or `others` (dining), where `variants.extraAddonNote` is empty and a
book text exists. Write ONE key, `variants.extraAddonNote`. Nothing else.

**Two traps, both already paid for once:**

- `variants` is a jsonb bag and REBUILDING it deletes every key it has not heard
  of. Merge, never replace (`docs/bugs/` — the jsonb double-encoding COE).
- `custom_specials` is DERIVED and self-erasing. Never write there.
- Writing `variants.specials` would re-key the line (see A). This backfill writes
  the NOTE only.

**Release discipline is mandatory** for a write script: MODE defaulting to plan,
a CONFIRM phrase, verification on a FRESH connection asserting the SHAPE (not a
row count), and a `RE-RUN:` line. Copy `unify-processing-date.mjs` or
`preserve-autocount-desc2-in-remark.mjs`; `npm --prefix backend run
audit:release-discipline` enforces it.

---

## What is NOT decided, and must not be decided without him

- Whether a backfilled note should also be written for lines that are already
  DELIVERED or CLOSED. His standing rule elsewhere is 「只针对新的order生效 旧的就
  不理了」, but he asked for this one explicitly to reach suppliers — so ASK,
  with the count of each.
- Whether the dining (`others`) text should be split into structured fields
  later. Out of scope here; the free text is the agreed answer for now.

## Open finding parked here so it is not lost

`9058-Console` and `9058-CONSOLE` are TWO product rows with the same description
(SOFA MAYBATCH CONSOLE) and DIFFERENT main suppliers (HOOKKA INDUSTRIES vs
HOOKKA MANUFACTURING). Same physical piece, two identities — stock and demand
split in half. Found by `check-supplier-binding-visibility.mjs`, run
34447806315. Needs the owner's decision on which spelling survives; merging them
moves documents already raised.
