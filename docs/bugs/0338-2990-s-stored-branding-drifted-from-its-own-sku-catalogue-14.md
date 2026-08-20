## 2990's stored branding drifted from its own SKU catalogue — 147 lines, 100 blank SO headers, 27 blank models [low]

**Symptom.** The owner, reviewing the Brands maintenance screen on 2026-08-18,
asked whether his SKUs carry the branding he maintains there. They do — all 353
2990 SKUs, zero blank, every value one of the seven brands on that screen. What
had drifted is everything DOWNSTREAM of the catalogue.

**Root cause (measured, not inferred — read-only prod queries).** Three
populations, each for its own reason:

| where | rows | why |
| --- | --- | --- |
| `mfg_sales_order_items.branding` blank | 136 | `derive-line-branding.ts` fills branding from the SKU at WRITE time, and these orders predate it |
| same, non-blank but disagreeing with the SKU | 11 | free text typed before the catalogue was the source: `2990` / `2990s` on rows whose SKU says `2990s Mattress`, and `Happi.S` on rows whose SKU says `Accessories` |
| `mfg_sales_orders.branding` blank | 100 | the SO create form has never had a branding field, so 2990's header column was never written at all |
| `product_models.branding` blank | 27 | 17 sofa + 10 bedframe models seeded before the field existed |

Two earlier scripts covered parts of this and neither closed it:
`backfill-2990-so-branding-from-sku.mjs` is blank-only, so it cannot touch the
11 disagreements; `backfill-branding-to-canonical.mjs` requires a category word
in the free text, so `2990` and `2990s` fall through its matcher. Neither writes
the header.

**Fix.** One script under the owner's 2026-08-18 rule — 「如果那个 SKU 有
branding 就根据 branding」 — which subsumes both: a line takes its own SKU's
branding, a header takes the representative line's SKU branding, a model takes
the single distinct branding of the SKUs minted from it. Every value is COPIED
from a row that already holds one; nothing is derived. Notably NOT the display
label: `brandingLabel` prints `Accessory` while the brand list holds
`Accessories`, so writing the label would have put a value outside his own
vocabulary into 16 rows — the script now refuses to apply if any planned value
is absent from `project_brands`.

**Houzs is untouched**, on the owner's instruction (「Houzs 的不需要」). Its
13,916 blank lines have no per-line source in AutoCount, so filling them would
invent values rather than copy them.

**And the write path, so it does not re-open.** The backfill alone repairs today
and decays tomorrow: `createSalesOrderCore` inserted `branding: body.branding ??
null` and no shipped client sends that field, so the next order created would
land with a blank header exactly like the 100 being filled. It now stamps the
header from the representative line's SKU when the caller supplied none —
copied, so the value is inside `project_brands` by construction rather than by
anyone remembering.

**Guarded by a check, not by care.** `check-branding-vocabulary.mjs` +
`audit:branding-vocabulary` scan all four branded tables against each company's
active `project_brands`, with a CASE verdict separate from NOT-IN-LIST because a
case-only drift is what stops a PMS rename cascading. It refuses rather than
passes on an empty corpus, and was proven red (`--strict` exits 1 on the live
drift, an unreachable DB exits non-zero) before being trusted green.

**Dry-run against prod, 2026-08-18:** 147 lines, 100 headers, 27 models = 274
rows, 0 outside the brand vocabulary, 0 headers left blank, 0 models refused.
The checker scans 5,722 branded rows and reports exactly the 11 this fixes.

**Ref.** 2026-08-18, branch `fix/branding-backfill-2990`.
