## The delivery-fee rebuild replaced its lines, so a shipped fee lost its DO link [medium]

<!-- area: Delivery, DO, returns -->

**白话.** 运费那一行是系统算出来的。以前每次重算，系统会把整组运费行删掉，再插入新的一
组，新行的 id 是新的。可是送货单上也可能有一行运费，它用 `so_item_id` 指着销售单的那一
行；外键是 ON DELETE SET NULL，所以那一删，送货单就不记得自己送的是哪一行了。销售单上
看起来运费行还在 —— 其实是新的一行，只是代号一样，所以之前查「行还在不在」的人都看不出
问题，只有 `created_at` 会露馅。现在重算改成原地更新，id 不变，链接也就留住了。

**Symptom.** Silent. A `delivery_order_items` row whose `so_item_id` is NULL
while its DO header still names the Sales Order. `so_item_id` is the key MRP's
delivered-netting and the CONFIRMED → DELIVERED flip resolve on, so a shipment
that loses it is invisible to both. The symptom itself is covered twice over
(#2225 closed the write-side hole, #2355 gave both engines a second reading off
the DO header), which is exactly what makes the remaining mechanism hard to
see.

**Root cause (traced in source).** Three facts that only bite in combination:

1. A Delivery Order **can carry a delivery-fee line**. `routes/delivery-orders-mfg.ts`
   records a live one: Nico's DO for 2990-SO-2606-034 was blocked on
   `SVC-DISPOSE-SOFA` and `SVC-DELIVERY-CROSS` being "short" at BALAKONG
   (2026-08-03). Service lines are skipped for STOCK, not excluded from a DO.
2. `scm.rebuild_mfg_so_delivery_lines` (0214, re-created by 0305) re-derived the
   fee by `DELETE … WHERE item_code IN ('SVC-DELIVERY','SVC-DELIVERY-CROSS','SVC-DELIVERY-ADD')`
   followed by an INSERT. New rows, new ids.
3. `delivery_order_items.so_item_id` is **ON DELETE SET NULL** (0235).

So a fee change on an SO blanked the link of a DO that had shipped that fee —
and left an SO that still displayed a delivery line, because a replacement row
was inserted wearing the same `item_code`. Anyone checking "is the SO line still
there?" sees yes.

**What this does NOT claim.** It does not explain the 26 orphans of 2026-08-17.
0302's header sets the FK theory aside because the SO lines "are all still
THERE, carrying their original `created_at`", and its own example
(2990-SO-2607-012, seven lines all stamped the second the order was created) is
evidence that order was never rebuilt. Delete-and-reinsert reproduces the
*appearance* 0302 describes but not that `created_at`. So this closes a
mechanism that is real, reachable from the UI, and independently checkable —
`scm.mfg_so_item_deletions` (0302) has been recording since 2026-08-18.

> **ANSWERED 2026-08-20, and NOT by this entry — see #2515.** The orphans were
> the 2990 SO mirror: `so-mirror.ts` DELETE-then-INSERTed the WHOLE item set on
> every sync, so one replay blanked every DO link on the order at once. That
> fits what this mechanism cannot: whole documents orphaned together, `2990-*`
> only, sofas and pillows among them. A fee rebuild can only ever reach fee
> lines.
>
> ⚠️ **This entry's own investigative advice was wrong, and is corrected here
> rather than deleted.** It said to look for rows in `scm.mfg_so_item_deletions`
> with an `SVC-DELIVERY%` item_code, and pointed at a fee line younger than its
> product lines as the fingerprint. Under the real mechanism that filter HIDES
> the signal — the mirror deletes lines of every item code, so the query to run
> is the unfiltered one, per `doc_no`. The migration file cannot be edited to
> say so (it is applied, and `pg-migrate` checksums it), so the correction lives
> here. The narrow mechanism this entry describes was still real and is still
> closed; it simply was not the one that bit.

**Fix.** 0310 replaces the function body with match → update → delete → insert.
Incoming rows are numbered per `item_code` by their position in `p_rows`; live
`SVC-DELIVERY*` lines are numbered per `item_code` by id; equal `(item_code,
seq)` updates that row in place, so the id and any DO link pointing at it
survive. A component with no counterpart is still deleted and still drops its
link — correct, the line it named is gone. Cancelled fee lines never match, so
they are purged and replaced live, as before. An empty `p_rows` still clears the
set.

The per-`item_code` sequence is load-bearing: `buildDeliveryFeeServiceLines`
emits `SVC-DELIVERY-CROSS` twice on a follow-up order that also crosses
categories, so `item_code` alone cannot identify a row. Both orderings are
stable inside the transaction, and the DELETE removes only the tail of each
group, so the numbering the INSERT sees is the numbering the UPDATE matched on.

**The lock is untouched, deliberately.** 0214 records two live double-billings
(SO-2606-043 2026-06-28, SO-2607-010 2026-07-12) from rebuilds interleaving as
delete/delete/insert/insert under READ COMMITTED. The advisory xact lock is
still taken first, on the same key, before any read. A pg test races two real
connections and asserts one line survives.

**Why it matters beyond the orphan.** This is the precondition for letting an
operator reduce a delivery charge at all. #2490 made a line discount survive the
rebuild, but the discount has no input in the SO screen yet; adding one on top
of a replacing rebuild would have manufactured an orphan on each edit.

Seven cases in `tests-pg/deliveryRebuildKeepsIdentity.pg.test.ts`, including the
DO-link survival, the duplicate `SVC-DELIVERY-CROSS` pairing, the cancelled-line
replacement and the two-connection race.

**Ref.** fix/delivery-rebuild-keeps-line-identity, 2026-08-20. Follows #2490
(discount survives) and the 2026-08-07 "every ringgit is a LINE" ruling.
