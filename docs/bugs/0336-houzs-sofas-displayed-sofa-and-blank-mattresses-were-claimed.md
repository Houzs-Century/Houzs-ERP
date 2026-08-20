## Houzs sofas displayed "Sofa", and blank mattresses were claimed for a 2990 house brand — the Branding label rule read the line instead of the company and the SKU [medium]

**Symptom.** Owner, 2026-08-18, restating a rule he had already given on
2026-08-08: *"houzs sofa=zanotti / 2990 sofa=2990s sofa"* and *"mattress follow
SKU branding if SKU no brand mean matress"*, then *"both company also"*.

**Root cause (read, then measured against prod).** `shared/so-branding-label.ts`
made the sofa label depend on the LINE's branding text for Houzs, and
manufactured a `2990 Mattress` label for any blank mattress under 2990:

| bucket | old rule | what it produced |
| --- | --- | --- |
| SOFA / Houzs | `brand \|\| noun` | `Sofa` whenever the SKU carried no branding |
| SOFA / 2990 | literal `2990 Sofa` | disagreed with the brand master, which spells it `2990s Sofa` |
| MATTRESS / either | `HOUSE_BRAND` regex folding `2990`/`2990's`/`2990s` into `2990 Mattress`; blank -> `2990 Mattress` under 2990 | a blank mattress was claimed for a house brand |

The sofa half was already ruled on: `docs/modules/sales-order.md` records the
2026-08-08 rule and `fix-hc-sofa-branding.mjs` (#1723) repaired the DATA for it.
The repair did not reach everything and the RULE never encoded it, so the display
stayed dependent on rows that are still blank today. Measured against prod
(`claude_ro`, `scm.mfg_products`, company 1):

- SOFA: 713 SKUs `ZANOTTI`, **11 blank** — the entire `5526-*` family, all
  ACTIVE, 8 of them already on order lines. Every one of those rendered `Sofa`.
- MATTRESS: 78 of 707 blank, 5 of them live on orders.
- 2990 SOFA: 193 SKUs, every one `2990s Sofa`; the Brands screen agrees. The rule
  said `2990 Sofa`.

**Fix.** SOFA returns the COMPANY's house brand and does not read the line at
all — symmetric with the way 2990's side has behaved since 2026-05-28. MATTRESS
returns the SKU's branding for both companies, falling back to the category noun;
the `HOUSE_BRAND` regex and the `2990 Mattress` literal are deleted rather than
left dormant. Both callers that compute `first_item_branding` now resolve a
mattress line SKU-FIRST instead of borrowing the catalog only when the line is
blank — without that, the six live 2990 lines storing the loose spellings `2990`
/ `2990s` would have started rendering those strings the moment the normalisation
regex went away.

**Blast radius, computed by replaying the new rule over prod rows.** 2990: 67
orders `2990 Sofa` -> `2990s Sofa`, and 4 orders `2990 Mattress` -> `2990s
Mattress` (their SKU says so). Houzs: **zero** orders change today — all 2,726
carry an AutoCount header `branding`, which still wins; the new rule governs
ERP-native Houzs orders, of which there are none yet.

**Not fixed here.** `SalesOrderDetailV2.tsx` never joined the shared rule — it
reads `branding || first_item_branding || "—"` — so the detail page can still
print a different string than the list for the same order.

**Ref.** 2026-08-18, branch `fix/branding-sofa-mattress`.
