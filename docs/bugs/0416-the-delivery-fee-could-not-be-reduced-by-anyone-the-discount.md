## The delivery fee could not be reduced by anyone — the discount had a server road and no door [medium]

<!-- area: Sales orders + pricing -->

**白话.** 运费降不下来，因为画面上根本没有输入折扣的地方。之前修好的是后端那一半：折扣
存得住，重算也不会再把它抹掉。可是销售单画面上的「折扣」只是一个显示，数值大于零才看得
见，没有输入框；那颗「$」改价按钮改的是单价，不是折扣。所以能写进折扣的只有 POS 的礼券
拆分，柜台人员一条路都没有。现在改成：在运费那一行，原本打单价的同一格改成打「要收多少」
—— 打 125，系统就记 125 的折扣，单据上还是单价 250、折扣 125、合计 125。想收更多不能用
折扣（那会变成负数、账面上没有一行说明这笔钱），要另外加一行额外运费。

**Symptom.** An operator trying to charge RM125 instead of RM250 has no field to
do it in. Typing over the unit price snaps back (the fee is derived), and the
`$ Override price` button writes `unit_price_sen`, which the next rebuild
re-derives. The reduction that the server supports — a line discount — could not
be entered from the SO screen at all.

**Root cause (traced).** `SoLineCard.tsx` carried `discountSen` as a type, a
default of `0`, a term in the line total and a read-only "− Discount" row that
renders only when the value is ALREADY above zero. Its editable inputs are
description, remark, qty, unit price, delivery date, variants and photos. There
is no discount input, and `SalesOrderDetail.tsx` renders the Disc column as
text. Both line payloads already send `discountSen`, so the whole path existed
except the one place a human touches it.

This is the half that #2490 (discount survives the rebuild) and 0310 (the line
keeps its id) left open. Each was necessary; neither was sufficient, and read
together they made the road look finished.

**Fix.** On a `SVC-DELIVERY*` line the amount cell shows the line NET and writes
the difference as a discount — the same cell the operator was already typing in.
The arithmetic lives in `frontend/src/vendor/scm/lib/delivery-fee-amount.ts` so
a test EXECUTES it rather than reading the JSX.

Three deliberate properties, each pinned:
- **Target semantics, not discount semantics.** Typing 125 on a 250 fee means
  "charge 125", so the discount is 125. Wanting 200 books 50. The owner's own
  case is a coincidence — half of 250 is also 125 — so a second case (250 → 200)
  is what actually distinguishes the two readings.
- **A higher figure books NO discount.** A negative discount would raise the fee
  with no line naming the money: the header back door the owner ruled out on
  2026-08-07. Charging more is what `SVC-DELIVERY-ADD` is for.
- **A blank or unreadable box writes nothing.** `Number('')` is 0, which would
  read as charge-nothing and discount the whole line on the way to retyping it,
  and a blur at that moment would save the waiver. A deliberate waiver is still
  typed as `0`. The first draft of the helper rounded NaN to 0 for symmetry and
  a test caught it giving the fee away.

Non-fee lines are byte-identical: the cell is still the unit price, on the same
`canEditPrice` gate, so no new pricing power is handed to anyone.

**It was never the mirror, and that matters for what to check next time.** An
earlier draft of this entry blamed the `2990-*` revert on the SO mirror
replaying its copy over the edit. #2518 withdrew that claim with a measurement,
and it was wrong: 2990's own `sync_outbox` shows the last successful delivery at
**2026-08-19T08:42:39Z** with an empty queue, while both `SVC-DELIVERY` deletes
on 2990-SO-2608-033 (2026-08-20 01:41 and 02:40, from mig 0302's forensic log)
postdate it and carry `application_name = PostgREST 14.5` — the Houzs fee
rebuild, not the mirror, which reaches Postgres through postgres.js and appears
nowhere in that log.

So all three faults were on this side, and this entry is the last of them:
`discount_sen: 0` written over an accepted discount (#2490), the rebuild
replacing rows so they changed id (#2514 / mig 0310), and the discount having no
input at all (here). The mirror's DELETE-then-INSERT is still real and still
worth the import-once fix (#2515) — it is the only known mechanism that orphans
a WHOLE document's DO lines at once — but it explains the ten repaired delivery
links, not a reverted fee. An empty outbox is a state, not a guarantee: any
2990-side row change re-arms it.

Eight cases in `delivery-fee-amount.test.ts`, including the bound the server
enforces (`0 <= discount <= qty x unit`) over a spread of typed figures.

**Ref.** feat/delivery-fee-editable-amount, 2026-08-20. Completes #2490 (the
discount survives) and #2514 (the line keeps its identity).
