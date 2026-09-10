## The supplier PO does not say the pillow's colour, the SP mattress's size or which dining model was ordered [high]

**Symptom.** The owner, 2026-09-10: 「查回去autocount的记录看那些square pillow
custom 和special order 的mattress 和dining table diningleg 的spec全部放进去那个
special custom的地方。这样子，当我们发给 Supplier PO 的时候，他才能看得到这个
pillow 是什么颜色的，然后 mattress 是什么尺寸，以及我们的 dining table、dining
leg、dining chair 是什么款式。」 A purchase order is raised for a custom square
pillow and the supplier is not told what colour it is.

**Root cause (traced).** The spec text EXISTS — it is the account book's own
Desc2, and the 2026-08-28 re-import wrote it onto
`scm.mfg_sales_order_items.description2`. What it is not in is
`variants.extraAddonNote`, and that is the only place a purchase order can read
it from: a PO line is built by copying the SO line's `variants` and stamping
`description2` from `buildVariantSummary(item_group, variants)`
(`backend/src/scm/routes/mfg-purchase-orders.ts:2259`, `:2394`), and
`buildVariantSummary` prints `SPECIAL: <extraAddonNote>` after the per-group
attribute branch — so an accessory, which contributes no attributes of its own,
carries nothing at all when that key is empty. Measured on production, plan run
34451571333: 417 company-1 sales-order lines have a book text and an empty note
(355 accessory, 52 mattress, 10 dining).

Two things the same run refuted rather than assumed. First, the brief said the
dining items sit under the `others` category: company 1 has ZERO `others` lines
and TEN `dining` ones, so `dining` had to be in the write scope or the exact
thing the owner named would have been missed. Second, a SQL-NULL `variants` was
first treated as damage and skipped — it is an empty bag and the normal state of
a mattress or accessory line (11,259 of them), and refusing it dropped the plan
from 417 rows to 13.

**Fix.** `backend/scripts/backfill-book-spec-into-extra-addon-note.mjs` plus
`.github/workflows/backfill-book-spec-into-extra-addon-note.yml`, PLAN by
default. It copies the book's own text — `description2`, then the 2026-08-11
`ac-line-desc2.json.gz` snapshot by DtlKey, then the `账本原文:` label that
`preserve-autocount-desc2-in-remark.mjs` parked in `remark` — into ONE key by
jsonb MERGE. It never writes `variants.specials` (that key enters
`computeVariantKey` and would re-key the line into a different stock bucket),
never `custom_specials`, and never touches the account book. The guard that
makes it a copy rather than a re-derivation: `buildVariantSummary` is re-run per
line from that line's own `item_group` + `variants` and a candidate equal to our
generated summary is excluded — 56 lines on the production plan. Verification
re-reads on a fresh connection and asserts that every pre-existing variant key
survived the merge: 0 lost, 0 changed, rollback held on all 417.

**Ref.** `feat/special-note-backfill`, 2026-09-10. Plan run 34451571333 — the
APPLY is the owner's call and has NOT been run.
