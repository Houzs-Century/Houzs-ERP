## A spec repair that asked only the purchase side for its stock bucket would strand the delivery OUT movement [high]

**Symptom.** None — caught by reading the write path before the tool was run,
on the same day it was written, and fixed before its first dispatch. The tool is
`apply-book-text-specials.mjs`, which changes `variants.specials` across the
whole document chain and therefore moves an inventory bucket, because `specials`
composes `computeVariantKey`.

**Root cause (traced to the line).** The tool collected the buckets it would
re-key from the PURCHASE and RECEIPT lines only, which is what the supplier
round (`apply-supplier-specials.mjs`) does — that tool is rooted at the purchase
order, so the purchase line is the only code it has.

A shipment's OUT movement is not bucketed on the purchase line. It is bucketed
on the DELIVERY line's own code and key:

```ts
// backend/src/scm/routes/delivery-orders-mfg.ts:927
(it: any) => `${lineWh.get(it.id) ?? ''}::${it.item_code}::${computeVariantKey(it.item_group ?? null, it.variants ?? null)}::…`
```

and those two item codes are routinely DIFFERENT strings, by design: a purchase
line names the SUPPLIER's model, ours names the product
(memory `po-item-code-is-the-suppliers-model`; `docs/bugs/0822` is the round that
established it). So on a delivered line with a supplier-model purchase code, the
tool would have re-keyed the IN side and left the OUT side sitting in the bucket
nothing carries any more — a phantom OUT with no lot behind it, which is
`docs/bugs/0722` in its most expensive direction and exactly what the
shared-bucket refusal exists to prevent.

**Why the supplier tool is not wrong.** It refuses any bucket shared outside its
chain and it re-keys from the purchase line it is rooted at; its verify re-read
0 lots left behind on every line it wrote. The gap opens only when the tool is
rooted at the SALES line, which this one is — deliberately, so orders with no
purchase order yet are still repaired.

**Fix.** Every line of the chain is asked for its bucket — the sales line, the
purchase lines, the receipt lines and the delivery lines — deduplicated on
`(item_code, old key)`, and the shared-bucket refusal runs over all of them. The
delivery query now selects `item_code` and `item_group` for that reason, with
the reason written beside it.

**The lesson worth keeping.** When a repair moves a KEY rather than a value, the
question is not "which line did I start from" but "which rows in the ledger are
addressed by that key". Those are written by several different routes, and each
route chooses the code from the document IT owns.

**Ref.** fix/book-text-specials-delivery-bucket, 2026-09-12. Related:
`docs/bugs/0722` (why the stock moves with the line), `docs/bugs/0843` (the tool
this belongs to), `docs/bugs/0822` (the purchase line names the supplier's model).

---

**SECOND HAZARD, same file, found the same way — ONE BUCKET, TWO ANSWERS.**

Two lines can share an item code AND an identical OLD variant key while their
texts ask for DIFFERENT options. It is not hypothetical: `HC-SO-010183` carries
two `CODY-(Q)` beds — same divan, same gap, same colour — one reading
`add on right side drawer` and the other `add on left side drawer`.

Their chains are separate (`so_item_id` is per line), so the shared-bucket test
sees both sets of ids as "members of the plan" and refuses neither. The first
write then re-keys **every lot in that bucket** to Left, and the second finds
nothing left to move — silently filing the right-hand bed's stock under the
left-hand key. The document lines would read correctly and the stock would be
wrong, which is the worst shape of all: no error, no count, nothing to notice.

Splitting a lot by quantity is a different operation from renaming a key, and
this tool does not do it. A bucket whose members ask for more than one new key,
and which actually holds stock, now refuses every chain that touches it and
names them. A bucket with NO stock rows is not refused — there is nothing to
split, and the document lines simply take their own keys.
