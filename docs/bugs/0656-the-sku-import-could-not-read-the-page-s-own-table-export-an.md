## The SKU import could not read the page's own table export, and refused a price-only edit [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner exported the SKU page, edited prices, imported the file
back, and got:

> No rows had a code. Every row needs a code, name, and category.

The file was fine. Parsed with the importer's own SheetJS runtime it yields
**164 rows**; its header row is
`Product Code, Description, Model, 24, 26, 28, 30, 32, 35, 37, Flat, Barcode, Unit (m³), Status`.

And he recognised it: 「**这个问题好像之前也是有**」. He was right, which is half of
why this entry is worth its length.

**TWO defects, and the second is the one that actually blocked him.**

### 1. The page has two exports and the import can only read one

* **Export SKUs** (top right) writes `code, name, category, size_label,
  price_tier, price_24…, base_price, price1` — the round-trip file.
* **The grid's own export** writes what is ON SCREEN: `Product Code`,
  `Description`, one column per sofa SIZE. Its filename is `sku-master-…`.

The Import dialog says only *"Pick a CSV or Excel file exported from this page"*,
which is true of both. The importer keyed on the raw lower-cased header text with
no alias and no space/underscore tolerance, so every row was dropped.

**This exact class was fixed on 2026-09-02 — for the OTHER importer.**
`docs/bugs/0605` gave the fabric import tolerant header matching, in its own
words *"so a hand-made 'Fabric Code' column maps like the exported
'fabric_code'"*, and that entry even notes it borrowed the SheetJS runtime **from
this importer**. The rule reached one of the two and never came back for the
other — the fixed-on-one-surface-only class CLAUDE.md names.

### 2. Name and category were required to UPDATE, not just to create

`POST /mfg-products/batch-import` refused any row without a name and a valid
category — **even when the code already existed**. So the commonest real file, a
price-only edit, could never import, and it failed as
`missing code/name or invalid category`, which reads like a broken file rather
than a rule.

That contradicted the data-loss-safe upsert written twenty lines above it: every
OTHER column is written only when the cell is filled, precisely so an edited
export cannot wipe what it does not carry. Name and category were the two
exceptions.

The owner states the contract in one sentence (2026-09-07):

> 「如果没有 Code 在系统里面的 import，就是等于开 Code。然后如果我有 Code 在系统
> 里面，它 match 得到，就是代表我要更改东西」

**Fix.**

* **Backend** — a code the system does not hold is a CREATE and still needs name
  and a valid category; a code it holds is an EDIT and needs neither. Both are
  written only when present, like every other column. The existence read moved
  above the guard, where it now decides create-vs-edit, and the write branch
  reuses it — no second query.
* **Frontend** — `normalizeImportHeader` gives this importer the tolerance the
  fabric one has had since 0605 (case, and space vs underscore).
* **Frontend** — the table export is RECOGNISED, not aliased. **Aliasing it would
  have been the dangerous fix**: the grid writes the price for whichever tier is
  on screen and carries NO tier column, so an imported price would have no tier,
  and a price filed under the wrong tier is worse than one not filed. The
  importer already refuses a priced row whose tier it cannot read; this makes the
  refusal say which button to press instead of naming the symptom.
* **Frontend** — when a file is not recognised at all, the message now lists the
  columns it actually found.

**Verified.**

* `frontend/src/pages/scm-v2/Products.import.test.ts` — 6 tests, including the
  owner's real header row verbatim and an assertion that the normaliser is
  IDENTITY on every header the round-trip export writes (loosening a match must
  not break the file that already worked). Proved red the only way it can be:
  `git show origin/main:…/Products.tsx | grep -c 'normalizeImportHeader\|looksLikeGridExport'`
  answers **0** — neither symbol exists there, so the suite cannot even import.
* The owner's actual file, run through the new path: headers normalise to
  `product_code, description, model, 24, …` and it is **detected as the table
  export**, so he now gets the sentence naming the right button.
* `npm --prefix backend run typecheck` and `npm --prefix frontend run typecheck`
  both clean.

**UNTESTED in the browser** — the backend create-vs-edit change has not been
exercised against a live import; the evidence above is the typecheck, the unit
tests and the parse of the real file.

**The lesson.** Two importers, one rule, and the rule was applied to whichever
one was on fire that week. The guard against a third repeat is not this entry —
it is `Products.import.test.ts`, which fails if the tolerance is ever removed.

**Ref.** fix/sku-import-tolerant-headers, 2026-09-07. Follows
`docs/bugs/0605-fabric-import-rejected-excel-files-and-hid-the-real-failure.md`.
