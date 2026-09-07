## A migrated purchase order was labelled ringgit because the importer wrote a constant [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-PO-009335` — RM 34,334.90, SUBMITTED — reads `MYR` in the ERP.
AutoCount holds it in **CNY**, at rate 0.619380. Every figure on the document is
a yuan figure wearing a ringgit label.

This is the third entry on the same confusion and the only one that fixes the
cause. `0665` is the repair that read the exchange rate as a 38.06% discount and
took **RM 13,068.55** off that live document (reverted, #3070). `0666` is the
read-only checker that was making the same comparison. Both left the label
itself alone and said so: *"repairing that is an owner decision with GRN / PI /
PV consequences, so it is listed and not scripted."* The owner decided on
2026-09-07: **改成 CNY**.

**Root cause (traced, not guessed).** Four writers put the literal string `'MYR'`
into the currency column of a migrated document, regardless of what the book
says:

| writer | line |
|---|---|
| `import-ac-outstanding-po.mjs` | `:403` — `..., ${o.locWh}, 'MYR',` |
| `import-ac-outstanding-so.mjs` | `:442` — `V("CONFIRMED"), "1", V("MYR"),` |
| `import-ac-so-linked-pos.mjs` | `:390` — `${p.items[0]?.wh ?? null}, 'MYR',` |
| `create-migrated-documents.mjs` | `:141` — the migrated GRN header |

Underneath that: the migration cuts those writers read
(`ac-outstanding-so.json.gz`, `ac-outstanding-po.json.gz`,
`ac-so-linked-pos.json.gz`) carried **no currency column at all**, so a constant
was the only thing available to write. The full header cut
(`ac-doc-headers.json.gz`) does carry `CurrencyCode` — which is how the size of
this was measurable without a trip to the book.

**The size, measured rather than estimated.**

| | |
|---|---|
| book header cut | `data/ac-doc-headers.json.gz`, exported 2026-09-07 17:36+08 |
| book purchase orders | 9,408 — **MYR 9,386, CNY 22** |
| book sales orders | 13,365 — **MYR 13,365** (no foreign sales order exists) |
| of the 22 CNY, inside the migrated scope | **1** — `HC-PO-009335` |
| ERP currency values, company 1 (prod, 2026-09-07 23:06+08) | PO 574 MYR · SO 2,882 MYR · DO 171 MYR · GRN 320 MYR · PI 32 MYR |
| GRNs / purchase invoices raised against that PO | **0 / 0** |

**Fix.**

- `backend/scripts/lib/ac-currency.mjs` — ONE home for "what currency is this
  AutoCount document in". Four writers now import it instead of stating the rule
  a fifth time. It copies `CurrencyCode` verbatim (trim + upper) and falls back
  to MYR **only** when the cut carries no such column, which reproduces exactly
  today's behaviour instead of inventing a new one; `sawCurrencyColumn` lets a
  writer SAY which of the two happened.
- `export-ac-reimport.py` — `h.CurrencyCode` added to the SO lane and both PO
  lanes. **This needs a re-cut**: the committed cuts predate the column, and
  until then every import defaults to MYR and now says so in its own log.
- Migration `20260907T2330_currency_code_cny.sql` — `CNY` added to
  `scm.currency_code`. `CNY` and the pre-existing `RMB` are the same currency
  under two names; the book states CNY and a migration copies rather than
  translates, so both codes are valid and neither is rewritten into the other.
  **No `scm.currencies` row is seeded**: `rate_to_myr` is `NOT NULL DEFAULT 1`,
  and a seeded 1 would let `assertForeignRatePostable` wave through a yuan
  receipt costed as ringgit — the exact R2 mis-cost that guard exists to refuse.
  With no master row the guard blocks until a real rate is entered.
- `VALID_CURRENCIES` += `CNY`, and the three purchase-side dropdowns (PO, GRN,
  PI). Without the API entry, editing the repaired PO answers
  `invalid_currency` (400); without the dropdown entry the select renders BLANK
  over a stored CNY and the next save silently rewrites it.
- `backend/scripts/repair-migrated-currency.mjs` +
  `.github/workflows/repair-migrated-currency.yml` — the data repair, plan by
  default, CONFIRM-gated, verified on a fresh connection by re-reading the VALUE
  (`pg_typeof` + the string), `RE-RUN: inert`.

**What changing the label does downstream — asked before it was applied, not
after.** The purchase order carries no exchange rate at all: `scm.purchase_orders`
has **no `exchange_rate` column**, verified against production. Conversion to
ringgit happens on the GRN, the purchase invoice and the payment voucher, each
carrying its own `currency` + `exchange_rate` (`src/scm/lib/fx.ts`). So nothing
already stored is re-read differently. What DOES change is the future:
`resolveGrnFx` (`routes/grns.ts:233-255`) copies the purchase order's currency
onto a new GRN, and `assertForeignRatePostable` then refuses that receipt until
a CNY rate exists. **That refusal is the intended outcome** — it is what stops
34,334.90 yuan being capitalised as 34,334.90 ringgit. With 0 GRNs and 0 PIs
against this PO today, the repair moves nothing and only gates what comes next.

**Noted, not changed: the RMB master rate is 1.000000.** `scm.currencies` seeds
every foreign currency at 1 (migration 0082), and `isPositiveFiniteRate(1)` is
true — so the fx guard would NOT block an RMB receipt, and one would post 1:1.
Nothing in production holds RMB today, so this is a latent hazard rather than a
live one, and setting a real rate is the owner's call in the Maintenance page.

**Proved.** `backend/tests/purchaseDocVocab.test.ts` gained a check that every
member of `VALID_CURRENCIES` is named by some migration — planted RED with a
bogus `XTS` (*"XTS is accepted by the API but no migration ever names it"*),
green with it removed. The book counts above were read out of the committed
snapshot; the production counts, the column types and the zero downstream
documents came from `check-currency-and-do-warehouse.mjs`
(run 34136475176, 2026-09-07 23:06+08).

**Ref.** fix/migrated-po-currency-cny, 2026-09-07. Cause of
`docs/bugs/0665-*` and `docs/bugs/0666-*`; instrumentation in
`docs/bugs/0668-*`.
