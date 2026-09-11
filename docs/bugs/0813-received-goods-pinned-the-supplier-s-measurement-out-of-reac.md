## Received goods pinned the supplier's measurement out of reach, because nothing moved the stock with the line [medium]

**Symptom.** The owner, 2026-09-11: 「已经收货了的 也是要改的 跟 SO 一起改整个
transaction flow」. Both supplier fill tools refused exactly those lines — 40 sofa
leg heights and 8 bedframe measurements — and the only answer the repo had was
the handoff's "this needs a stock-aware tool, NOT built". So a document the
supplier's own record says is wrong stayed wrong, and it was the RECEIVED ones,
i.e. the ones purchasing is about to match goods against.

**Root cause (traced).** Not a bug in the fill tools — their refusal is correct.
A sofa's leg and a bedframe's divan / gap / leg compose the inventory identity
(`computeVariantKey`, `src/scm/shared/variant-key.ts`), so writing one onto a
line whose goods are in moves that line to a bucket its lot does not carry. That
is `docs/bugs/0722`, where three delivery orders shipped against nothing and
carried no COGS. The missing half was the OTHER side of the same move: nothing
re-keyed the lot, the movement and the consumption rows to follow the line.

Two measurements were needed before anything could be built, and the first one
was WRONG in a way worth recording. A read-only pass that counted the purchase
line and its sales line as "the change set" reported **36 of 65 lines as sharing
their bucket with another document** — and every one of them named its own
goods-received note. A GRN raised from that purchase line is not a stranger in
the bucket; it is the rest of the transaction, and it moves with it. Counting the
whole chain (purchase line → its GRNs → sales line → its DOs) turned 36 shared
into 2. The same mistake one step further along — two REGAL (A)-(Q) beds on
HC-PO-008506 reading each other as strangers — took it to 1.

**Fix.** `apply-supplier-variants-with-stock.mjs` (+ workflow) writes the
measurement to every document in the chain and re-keys that chain's rows in
`inventory_lots`, `inventory_movements` and `inventory_lot_consumptions` inside
ONE transaction per line, so no window exists where a line names a bucket that is
not there. Checked rather than assumed: `scm.inventory_balances` is a VIEW and
needs no move; `trg_inventory_movement_fifo` is `AFTER INSERT`, so an UPDATE
re-plans no consumption; the rack, stock-take and transfer tables carry zero rows
for these buckets and the tool refuses if that ever stops being true. A bucket
shared with a document outside the chain is REFUSED and named — moving it would
point the others at stock that is no longer there, which is 0722 in the other
direction.

Observed (plan, production, 2026-09-11): 48 lines with goods in whose measurement
disagrees; **47 writable over 28 purchase orders**, moving 31 lots, 41 movements
and 9 consumption rows; 1 refused — `HC-PO-009784 8030-L(LHF)`, whose bucket is
shared with `HC-SO-013229`, `HC-PO-009941` and `HC-GRN-2609-009`.

**Ref.** fix/stock-aware-variants, 2026-09-11. Follows `docs/bugs/0722`, `0807`,
`0811`, `0812`.
