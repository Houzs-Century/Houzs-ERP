## A migrated delivery note lost the fabric colour its own sales order carries [medium]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Four delivery lines on PROCEEDED orders carried NO fabric colour
while the account book states one — the one column the reconcile's variant table
calls WORK. Run
[`34210768489`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34210768489),
2026-09-08 17:34 +08:

```
DO-004868 DtlKey 462399  VALKYRIE-(K)      book "NV-1WP"            ERP (blank)
DO-011566 DtlKey 927185  BREEVA (W)-(SP)   book "taroni 1 cream"    ERP (blank)
DO-011566 DtlKey 927187  FLAT-(Q)          book "taroni 1 cream x1" ERP (blank)
DO-011566 DtlKey 927189  FLAT-(Q)          book "taroni 10 sliver"  ERP (blank)
```

Two of the four book texts are FREE TEXT, not catalogue codes, which is why the
first question was whether they name a real fabric at all.

**They do, and the ERP already knew.** `probe-do-colour-pairing.mjs` run
[`34210225334`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34210225334)
read the ERP side over `secrets.DATABASE_URL` and resolved both sides through
the LIVE fabric library (951 rows, `active` included, so the matcher follows the
2026-08-11 renumbering rather than answering the DEAD row):

| delivery line | the book's text resolves to | its SALES-ORDER line already held |
|---|---|---|
| `DO-004868` `VALKYRIE-(K)` | `NV-1WP` -> `NV\|NV-01` | `HC-SO-006089` line 3, `NV-01` |
| `DO-011566` `BREEVA (W)-(SP)` | `taroni 1 cream` -> `TARONI\|TARONI-01` | `HC-SO-009031` line 5, `TARONI-01` |
| `DO-011566` `FLAT-(Q)` | `taroni 1 cream x1` -> `TARONI\|TARONI-01` | `HC-SO-009031` line 6, `TARONI-01` |
| `DO-011566` `FLAT-(Q)` | `taroni 10 sliver` -> `TARONI\|TARONI-10` | `HC-SO-009031` line 7, `TARONI-10` |

**So nothing about the goods was ever in question.** Both documents are
`DELIVERED` (2025-06-10 and 2026-09-08). The factory builds from the sales
order, the sales order was right, and the customer has the fabric the book
ordered. What was blank is the delivery note — the paper — and only there.

**Root cause: UNKNOWN, and deliberately not guessed.**
`lib/migrated-do-writer.mjs` states the rule the delivery line is supposed to
follow — `variants: t.variants ?? null`, copied from the sales-order line it
delivers — so a blank delivery line behind a filled order means the order line
was filled AFTER the delivery row was written, or the copy did not happen. The
obvious way to tell them apart is the timestamps, and **the probe went and
looked**: `scm.delivery_order_items.updated_at` and
`scm.mfg_sales_order_items.updated_at` are BOTH NULL on all four rows (apply run
[`34217713545`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217713545)
prints them per row), so this cut cannot date either write. The mechanism stays
UNKNOWN rather than being written up as the plausible one.

That is why the repair does not depend on knowing it: it restores the writer's
own rule from a source this ERP already holds, and proves the source against the
book independently.

**Fix.** `backend/scripts/repair-migrated-do-line-colour.mjs` +
`.github/workflows/repair-migrated-do-line-colour.yml`. It copies the SALES-ORDER
line's colour key and value onto the delivery line — 「migration copies, never
computes」 — and writes only when, for the whole `(document, item, quantity)`
bucket, the MULTISET of colours the book states equals the MULTISET the bucket's
sales-order lines carry. A bag is order-independent, so that guard cannot be
satisfied by an ordering and cannot be defeated by one, and it needs no pairing —
which matters, because two of the four sit on a bucket
`lib/ac-forced-line-pairing.mjs` REFUSED to key (`docs/bugs/0709`). It never
overwrites a colour, and the blank is in the UPDATE predicate as well as in the
plan, so losing a race with another lane is a no-op.

**Ran, both halves.** Plan
[`34217614240`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217614240):
`4 delivery line(s) carry NO colour while the book states one for their bucket:
4 can be copied from their own sales-order line, 0 REFUSED`. Apply
[`34217713545`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217713545)
with `CONFIRM="COPY DO COLOUR FROM SALES ORDER"` passed by the workflow:
`APPLIED: 4 row(s) written of 4 planned`, then on a FRESH connection `READ-BACK:
all 4 row(s) hold the planned colour` and

```
PROVEN: money, quantities, readiness, stock, the migrated-document movement leak
and the AutoCount outbox are IDENTICAL before and after.
```

— `do_items` 886 rows / qty 1330 / `unit_price_sen` 102,480,800 /
`line_total_sen` 108,400,350; `inventory_movements` 3,505 rows / 6,069 units;
migrated-document movement leak 0; `scm.autocount_outbox` 45 rows both sides,
which is 「写回autocount的你不需要理了」 measured rather than promised; SO line
readiness `PARTIAL 11, PENDING 13087, READY 1974` unchanged.

**Closed, on the reconcile.** Run
[`34217807499`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217807499),
18:53 +08 — DO colour, PROCEEDED: `agree 164 -> 168`, `ERP blank 4 -> 0`,
`differ 0`, `no-key 4`. **The delivery-order colour backlog is zero.** Every
other DO axis is unchanged from the run before it.

**Ref.** docs/do-colour-runs, 2026-09-08.
