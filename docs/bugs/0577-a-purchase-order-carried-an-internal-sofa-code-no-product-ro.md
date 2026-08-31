## A purchase order carried an internal sofa code no product row has, so it could not match its own sales order [high]

<!-- area: Cutover + migrated data -->

**白话.** 同一张沙发，销售单写的件号是 `8030-*`，采购单写的却是 `5540-1S` —— 两个
号码指同一张沙发，但系统里根本没有 `5540-1S` 这个产品，所以采购单接不回它自己的销
售单，画面上产品那一栏也是空的。老板 2026-08-31 亲口确认这四款「对相同的」，并定下
规矩：**内部件号 SO 和 PO 必须一样，不同的只是供应商 SKU 那一栏**（供应商那栏就该写
`HOK-5540 SOFA`，那是给工厂看的）。已经进了系统的单子共 31 行（采购单 15、收货单
14、采购发票 2）；销售单、送货单、销售发票一行都没有。

**Symptom.** The owner opened HC-SO-013389 and its purchase order did not link
back to it. The PO line's internal item code read `5540-1S`; the sales order,
the compartment SKUs and the catalog all spell that sofa `8030-*`. The product
panel on the PO line was blank, because nothing in `scm.mfg_products` carries
`5540-1S`.

**Root cause (traced).** Two files disagreed about what the ERP calls four HOK
sofa models, and only one of them was right.

`backend/scripts/lib/parse-sofa.mjs:15` is the ERP's own statement of the
identity, and every sofa path applies it:

```
SOFA_MODEL_ALIAS = { "5530": "9028", "5536": "9058", "5537": "8030", "5540": "8030" }
```

`backend/scripts/data/autocount-erp-mapping-1561.csv` did not. Four rows mapped
the book code onto the alias KEY — `HOK-5540 SOFA,5540-1S` and three more — and
those ERP codes have never existed in `scm.mfg_products` for company 1.

That mismatch then reached the database by two SILENT routes, both in the
importers, neither of which could fail:

1. **The placeholder fallback.** `import-ac-so-linked-pos.mjs:278` and
   `import-ac-outstanding-po.mjs:235` both read
   `codeSet.has(ph.toUpperCase()) ? ph : l.erp` — when the aliased placeholder
   is missing from the catalog they write the RAW MAPPED CODE instead of
   refusing.
2. **The category read, which is the deeper one.**
   `import-ac-so-linked-pos.mjs:215` takes the line's group from the CATALOG:
   `prodCat.get(norm(l.erp)) ?? "others"`. A mapped code the catalog does not
   know is therefore not a sofa, so the whole sofa branch — alias, decode,
   compartment SKUs — is skipped and the line lands whole under the unknown
   code, having never been offered to the decoder at all.

Nothing refused either one because **`item_code` is plain text with no foreign
key to `scm.mfg_products`**. An orphan code is indistinguishable from a good one
until a screen tries to join on it.

Measured on production (company 1) by a read-only census dispatched on
2026-08-31, workflow run 33350184987: purchase orders 15 lines, GRNs 14 lines,
purchase invoices 2 lines — 31 in total on those four codes. Sales orders,
delivery orders and sales invoices: ZERO, which is consistent with the sales
side never using the CSV's ERP column for a sofa placeholder. That census is
reproducible from this PR: `repair-orphan-sofa-codes.mjs` in plan mode counts
the same three arms and prints the rows.

**Fix.** Three parts, all in this PR.

- The four mapping rows now point at the aliased, real codes:
  `HOK-5530 SOFA -> 9028-1S`, `5536 -> 9058-1S`, `5537 -> 8030-1S`,
  `5540 -> 8030-1S`. `backend/tests/catalogCodeGuard.test.mjs` fails if any
  mapping row ever names an alias KEY again — proved RED against the unfixed
  CSV, which reported all four rows before the edit.
- A write-time guard, `backend/scripts/lib/catalog-code-guard.mjs`, that both
  importers now call after planning and before writing: any line whose
  `item_code` is blank or absent from the catalog is listed with its document
  and the run exits 2. It refuses instead of falling back.
- `backend/scripts/repair-orphan-sofa-codes.mjs` +
  `.github/workflows/repair-orphan-sofa-codes.yml` repoint the rows already in
  production, `item_code` ONLY, on `purchase_order_items` / `grn_items` /
  `purchase_invoice_items`. `supplier_sku` is untouched by design — it holds the
  book's own `HOK-5540 SOFA`, the column that is supposed to differ — and the
  verification re-reads `supplier_sku`, `qty`, `received_qty`,
  `unit_price_sen` and `line_total_sen` per row on a fresh connection and fails
  if any of them moved. A code the alias cannot resolve to a real catalog row is
  REFUSED and printed, never guessed at.

**Prior art, and why it did not cover this.**
`docs/bugs/0567-seventeen-mapping-rows-carried-30-char-truncated-codes-four.md`
is the same mapping file writing a code nobody minted, caught a different way:
`import-ac-stock-balance.mjs` refuses an ERP code whose parentheses do not
balance, because a truncated 30-char AutoCount code has that shape. That test
is SYNTACTIC and lives in one importer. `5540-1S` is a perfectly well-formed
code; the only thing wrong with it is that no product has it, which is a
question only the catalog can answer — so the guard added here asks the
catalog, and both PO importers ask it.

**What this does NOT fix.** The repair had not been dispatched when this entry
was written, so the row counts above are the diagnostic's, not the repair's.
Nothing prevents the next mapping file from carrying the same class of error at
generation time — the guard catches it at write time, which is the point at
which it would do damage, but `gen-autocount-item-map.mjs` still has no
alias-awareness of its own.

**Ref.** fix/orphan-sofa-codes, 2026-08-31.
