## The book says 45 customers had already paid and the ERP still showed them owing [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Staff kept taking payments in AutoCount after the 2026-08-28
cutover — the owner deliberately left A-R / A-P and 收付款 operable there — and
none of it reached the ERP. `docs/bugs/0678` proved the MECHANISM and shipped
the two tools; it did not run either of them, so nobody knew the size.
**Measured on production 2026-09-08 08:06 (UTC+8), run
[34172204783](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34172204783):
45 of 2,882 migrated company-1 sales orders, RM 171,400.00, that the ERP would
have chased a customer for after the book says the money was collected.**

| bucket | before | after | ringgit before |
|---|---|---|---|
| (a) book says SETTLED, ERP says owing | **45** of 2,882 | **1** | RM 171,400.00 |
| (b) ERP says settled, book says owing | 0 | 0 | RM 0.00 |
| (c) both owing, different amounts | 5 | 5 | net RM 6,287.00 |
| (d) stored `paid_sen + balance_sen <> local_total_sen` | 8 | 6 | — |
| they agree | 2,832 (98.3%) | 2,876 (99.8%) | — |

Denominator throughout: the 2,882 migrated company-1 sales orders. All 2,882 are
stated by the book and stated in MYR; none is cancelled on either side; a PERSON
owned payment rows on **0** of the 45.

**Root cause (traced).** Not re-argued here — `docs/bugs/0678` has it. In one
line: `sync-ac-delta.mjs`'s payment lane builds its book side from
`data/ac-outstanding-so.json.gz`, whose population is the **DELIVERY**-outstanding
one, and a customer usually pays the balance ON delivery — so the order leaves
the extract at exactly the moment there is a payment to carry. The census
measured that on the affected bucket itself: **34 of the 45 had already left the
extract**, so that lane could never have seen them.

**The owner's ruling, 2026-09-08 00:40 (UTC+8).** 一律跟账本 — the book wins on
collections. Plan first, show the per-order list, then write.

**Fix — applied to production, not proposed.**

| step | run | result |
|---|---|---|
| census (read-only) | [34172204783](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34172204783) | the table above |
| plan, `settle-collected` | [34172302157](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34172302157) | 44 orders, RM 168,852.00 |
| plan again, 20 min later | [34173338473](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34173338473) | identical — 44, RM 168,852.00 |
| **apply**, `settle-collected` | [34173408223](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34173408223) | `APPLIED - 44 order(s) settled from the book, 0 skipped`; fresh-connection read-back: *every written order holds the book's figure and its payment rows sum to it* |
| label the fabricated dates | [34173735895](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34173735895) | `APPLIED - 2795 payment row(s) labelled, 0 skipped`; `provably-fabricated dates still unlabelled: 0` |
| census again | [34175101883](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34175101883) | bucket (a) 45 → **1** |

`settle-collected` was the only ruling that could work, and the reason is worth
keeping: `balance-only` moves the header's stored `balance_sen`, and **the screen
does not read it**. The SO list, the delivery board and the ASSR intake all show
`balance_sen_live = local_total_sen - SUM(payments)` from
`scm.mfg_sales_orders_with_payment_totals`. A correction that must reach staff
has to move the payments ledger.

**No double count, checked rather than assumed.** `soPaidSen`
(`scm/shared/so-outstanding.ts`) adds the header `deposit_sen` only when the
ledger carries no `is_deposit` row. The cutover's own row is written
`is_deposit = true` (`import-ac-outstanding-so.mjs:476`, the 7th `PCOLS`
position), and every one of the 44 had one, so `depositInLedger` was already
true and stays true; the appended row is `is_deposit = false` and changes
nothing about that branch. `paid_sen` is not an input to it at all — the file
says so in its own header: *deprecated, no writer maintains it.*

**What was deliberately NOT written, and is the owner's call.**

- `HC-SO-012571` (Lily Yong, RM 2,548) — the last member of bucket (a). Refused
  because the ERP holds the order at RM 3,538 and the book at RM 3,450. **If the
  two sides disagree what the order is WORTH they cannot agree what is left of
  it**, so it is a price question first.
- Five more refused on the same rule: `HC-SO-000021` (ERP 10,852 / book 9,876),
  `HC-SO-003945` (3,200 / 3,350), `HC-SO-008319` (6,100 / 6,250),
  `HC-SO-010789` (7,500 / 7,650), `HC-SO-013160` (600 / 300).
- Bucket (c), 5 orders, net RM 6,287.00 — both sides say owing, by different
  amounts. `settle-collected` never invents a PARTIAL payment, because the book
  records no partial payment to copy.
- Bucket (d), 6 orders whose stored pair no longer adds up. Cosmetic on the
  screen (`balance_sen` is not what staff see) and untouched.

**Nothing else moved, and that was measured, not reasoned.** The re-run census
returns bucket (c) as the same five orders at the same five amounts, and bucket
(d) fell 8 → 6 by exactly the two members that were also in (a)
(`HC-SO-002309`, `HC-SO-009773`), whose stored pair now adds up because the
settle wrote it. Stock cannot have moved: `scm.mfg_sales_orders` carries no
trigger in `migrations-pg`, the write touched only `balance_sen` / `paid_sen`
plus an INSERT into `scm.mfg_sales_order_payments`, and no allocation, MRP or
inventory module reads either column.

**THE GAP RE-OPENS. It is not closed and this entry must not be read as
closing it.** Every payment taken in AutoCount from the snapshot cut onward is
invisible again. The census names the reason on its own output: the balance
snapshot was **14.5 hours old** when it ran, so its own figures are a floor.
`sync-ac-delta.yml` is `workflow_dispatch` ONLY — no `schedule` — so the one lane
that could carry a payment back needs a human to re-cut the snapshot on the
office host, commit it, and dispatch with a confirm phrase; and its book side is
still the delivery-outstanding extract that 34 of these 45 had already left.
What would actually close it, in order of durability: (1) go-live, so payments
are taken in the ERP and there is nothing to carry; (2) give the payment lane a
BALANCE-shaped population (`UDF_BALANCE`-or-recently-modified) instead of a
delivery-shaped one — that is a change to `export-ac-reimport.py` on the office
host; (3) failing both, re-run this census-then-repair pair on a cadence, which
is a chore, not a fix.

**Ref.** `fix/so-payment-book-applied`, 2026-09-08.
