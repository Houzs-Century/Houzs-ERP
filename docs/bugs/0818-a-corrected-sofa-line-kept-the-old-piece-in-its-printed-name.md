## A corrected sofa line kept the old piece in its printed name, so the PDF showed two different sofas on one row [high]

**Symptom.** The owner, 2026-09-11, after a day of compartment corrections:
「为什么我们改了全部 SO PO 等等 exportPDF 出来不一样？你是走后门 而不是更改 SKU
那种？…正常来说我的 sku 是什么就显示什么啊？」

He was right, and the print code says why. Every document print puts the CODE and
the NAME side by side:

- `frontend/src/vendor/scm/lib/sales-order-pdf.ts:572,585` — `description ?? item_code`, beside `item_code`
- `frontend/src/vendor/scm/lib/grn-pdf.ts:133,137` — `description ?? material_name`, beside `item_code`
- `frontend/src/vendor/scm/lib/purchase-order-pdf.ts:197` — derives the module from `item_code`

So a line holding `8030-L(RHF)` while its text still reads `SOFA SOFFIO 1A(RHF)`
prints a lounger and an arm on the same row. That document is `HC-PO-2609-053` —
the lounger correction purchasing asked for as urgent that morning, landed on the
code and not on the name.

**Root cause (traced).** Two writers, one gap. `apply-sofa-compartment-corrections.mjs`
updates `item_code` and the line's OWN label column; `rename-sofa-line-in-place.mjs`
updates `item_code` only, by design (it exists to move nothing else). Neither
reaches a SIBLING text column — and which column a row PRINTS is not fixed: a
purchase or receipt line prints `description` when it has one and `material_name`
when it does not. A correction that wrote `description` on a row whose
`description` is NULL therefore changed nothing anybody sees.

**Measured on production 2026-09-11**, sofa lines whose printed name states a
DIFFERENT piece from its code: purchase **6**, goods-received **11**, sales
**0**, delivery **0**.

**The first measurement was WRONG and nearly shipped as "clean".** The matcher
used `\b` after the piece token, and `2A(LHF)` ends in `)` — no word boundary
follows, so it matched nothing and the first run reported 0 real mismatches out of
17. That is the CLAUDE.md trap "a checker that cannot match reports a clean run",
and it is why `repair-sofa-line-name-to-code.mjs` [gone] self-tests its matcher against
four real names and three supplier product names before it reports anything.

**Fix.** `repair-sofa-line-name-to-code.mjs` [gone] (+ workflow) rewrites ONLY the piece
token, in the column the row actually prints, and only where the name states a
different piece. A name that states NO piece is the supplier's own product name —
"AMN SOFA - SF9058", "HOK SOFA - 5536", "DSL SOFA - 8030" — and on a purchase
document that is what belongs there: 373 purchase lines and 47 receipt lines read
that way by design and are untouched. The old text is in the WHERE of every
UPDATE, so a row somebody edited between plan and write is skipped rather than
overwritten from a stale reading.

**The lesson worth keeping:** correcting `item_code` is not correcting the
document. What a person sees is `description ?? material_name` next to the code,
and a repair that moves one without the other leaves the paperwork saying two
things at once. Any future tool that changes a sofa's code must write the name in
the same transaction.

**Ref.** fix/sofa-line-name, 2026-09-11.

**SUPERSEDED 2026-09-11, same day.** This fix moved the printed NAME and left a
THIRD column stale: `supplier_sku`, the code the factory builds from. Both the
script and its workflow are replaced by
`backend/scripts/repair-sofa-line-shown-vs-code.mjs`, which sweeps all 14
printed line tables and EVERY column on them that can state a piece. See
docs/bugs/0822-the-purchase-order-told-the-factory-to-build-the-other-end-p.md.
