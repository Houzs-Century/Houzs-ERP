## Three positional writers paired on the code alone, and one of them writes into a licensed account book [high]

Sites **11, 12 and 13** of the bug class
[`0672`](0672-bug-class-key-without-identity-a-link-written-on-the-key-alo.md) —
*key-without-identity*. All three decide a line-to-line pairing, all three
already refuse a great deal, and none of them asked the one question that
matters: **are these two rows the same product?**

---

### Site 12 — `persistNewLineKeys` let a BLANK item code pass as agreement

`src/scm/lib/autocount-line-keys.ts`. It stores the DtlKey AutoCount assigned to
a freshly-added line by zipping ascending new keys against the lines the payload
declared as new.

Its sibling `persistLineKeys`, **ninety lines above it in the same file**,
defends the identical zip three ways: ItemCode, a prefix-tolerant `Desc2`
comparison, and an outright refusal when a code repeats with no `Desc2` to
separate the two. `persistNewLineKeys` had only the first — and it was written

```ts
if (got && want && got !== want) { ... }
```

so a **blank on either side skipped the comparison entirely** and the key was
stored anyway. A blank is not agreement; it is the absence of anything to agree
about. This is 0672's own first structural observation — *the rule is written
correctly four or five times over and applied at N-1 of its N call sites* —
appearing a third time, inside a single file.

It is the expensive one. `composeEdit` addresses a book row by
`doc.EditDetail(dtlKey)` and deliberately **strips `ItemCode` off a keyed
line**, so nothing in flight can ever reveal a wrong key: the correctness of
`linked_ac_dtlkey` IS the correctness of every future edit of that document, in
a live licensed account book. Refusing leaves the rows keyless, which the next
edit refuses loudly — recoverable. Storing a wrong one is not.

**Fixed:** all three defences, plus `newDesc2` carried on `NewLineKeyTarget` so
the second one has something to compare (two lines of one sofa model in
different fabrics is the ordinary case, and ItemCode alone cannot separate them).

### Site 11 — the relink bucket was the SKU, so a sofa exchange could swap the colours

`src/scm/lib/so-line-relink.ts` carries the downstream `so_item_id` links across
a delete-and-reinsert (the TBC sofa exchange). `SoLineIdentity` was
`{ id, itemCode, lineNo }`, and `orderedIds` bucketed on `itemCode` alone, so
**two lines of the same model in different fabrics fell into one bucket and were
paired by ORDINAL.** If the replacement set lists them in the other order, the
purchase order dedicated to the BLUE two-seater is re-pointed at the GREY one.
The SKU matches, the foreign key is valid, nothing dangles — and a PO line is
HARD-BOUND (`isHardBoundLine`), so the floor is told the wrong sofa is covered.

**Fixed:** the bucket is now `(code, variantSig)`. `soLineVariantSig` reads
`colourId ?? colourLabel ?? colourCode` — the same precedence
`probe-link-identity.mjs` uses, and for the reason `0674` records: comparing
`colourCode` alone found **0 comparable pairs on every edge**, an EMPTY answer
that printed identically to a clean one. A line whose `(code, variant)` pair has
no counterpart lands in `dropped`, which this module already reports out loud —
**a missing link is recoverable; a wrong one is not.**

### Site 13 — the AutoCount transfer was decided on the key and never on the product

`src/scm/shared/po-transfer-shape.ts` refuses a great deal: consolidated lines,
stock lines, keyless lines, a repeated key, more than one source document. Every
one of those is about **cardinality or presence**. None asked whether the
purchase-order line and the sales-order line it names are the same product.

A transfer executes as `doc.DocTransfer(dtlKeys)` and the key is the only
handle, so a PO line for a TRION naming a REGAL sales line would have
transferred the REGAL's book line into a purchase order for TRIONs, silently, in
a licensed book.

**Fixed:** identity is now one of the refusals, and it falls back to `create` —
the shape that already exists and already means "this cannot be expressed as a
transfer". That file's own header states the rule the whole module is built on:
*every case that is not certainly 1:1 is asserted to fall back.* Identity is
part of 1:1, and the fallback costs a link and writes nothing wrong. A blank on
either side falls back too. `readPoTransferFacts` adds `item_code` to the two
selects it was already taking, so this costs no extra round trip.

---

### Proved RED first

```
tests/acNewLineKeyIdentity.test.ts        5 failed | 1 passed  (site 12)
src/scm/lib/so-line-relink.test.ts        5 failed | 15 passed (site 11)
src/scm/shared/po-transfer-shape.test.ts  2 failed | 17 passed (site 13)
```

After: **45 passed (45)** across the three files. Backend typecheck clean.

### UNTESTED as a remedy

All three are **refusals and re-bucketings that change what a FUTURE run
writes**. None of them repairs an existing row, and none was executed against
production. The corrected instrument
(`probe-link-identity.mjs`, run 34172468269, 2026-09-08 08:13 local) reports
**0 item-code disagreements on `purchase_order_items.so_item_id`** as of that
time, so there is no known live damage from sites 11 or 13 to repair; site 12's
damage would be a wrong `linked_ac_dtlkey`, and the same run proves every shared
DtlKey in production is sofa decomposition rather than a collision (310 of 310
SO keys and 106 of 106 PO keys agree on model AND sit on one document). That is
evidence of no CURRENT damage, not evidence the guards work in production.

**Nothing here moves stock or readiness.** Sites 11 and 13 are pure decision
functions; site 12 only ever writes `linked_ac_dtlkey`, and the change makes it
write LESS.

### Noticed in passing, NOT mine, NOT fixed

`backend/tests/doStockLeavesOnConfirm.test.ts` — *"the OUT is gated on the
SHARED shipped set, not a hand-typed list"* — **fails on `origin/main`**
(measured at `971cb2df1`). Its slice anchor `let movementErrors: stri` now
matches **three** places in `delivery-orders-mfg.ts` and `indexOf` takes the
first, which no longer contains the branch. That file is untouched by this
change. Reported rather than repaired: it belongs to whoever is working in that
route.

**Ref.** fix/link-identity-14b, 2026-09-08. Class: `0672` sites 11, 12, 13.
