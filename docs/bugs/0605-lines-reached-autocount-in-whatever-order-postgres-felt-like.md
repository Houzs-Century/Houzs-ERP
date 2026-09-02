## Lines reached AutoCount in whatever order Postgres felt like [high]

<!-- area: AutoCount sync + write-back -->

**Owner's rule, 2026-09-02.** 「我是要 autocount 的全部 line 都跟 ERP 一样」, and
the specific one this entry exists for:

> 「convert 了的 PO 一定要 remain 在同样的 line，就是例如第四个 item 就是第 4 个
> item，不可以高或低」 · 「这个要查完全套系统」

A purchase order's fourth item stays the fourth item. It may not drift up or
down.

**Root cause (traced).** Every read that builds an AutoCount payload for a
SALES ORDER or a PURCHASE ORDER ran with **no `ORDER BY`**:

```
sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', poId)
```

Postgres makes no promise about the order of rows from such a query, and it does
change in practice — an `UPDATE` can move a row's physical position, so the same
document can serialize its lines one way today and another way after an edit.

The DOWNSTREAM documents (DO / GR / SI / PI) already ordered `created_at, id`
in two places. **The two document types the owner raises by hand did not** —
four reads, none of them ordered.

**Two paths turn that into a real defect, neither theoretical:**

* a CREATE sends `AddDetail` in payload order, and that order becomes the
  book's line order;
* a NEW line on an existing document learns its DtlKey **positionally** — *"the
  Nth unknown key belongs to the Nth declared line"*
  (`scm/lib/autocount-line-keys.ts`). That reasoning is only sound if the
  payload order is deterministic. It was not, so a new line could be stamped
  with another line's key.

**Fix.** `scm/lib/ac-line-order.ts` owns the order — `created_at` first (the
order a person entered the lines), `id` second so the sort is TOTAL: a bulk
insert gives several rows the same timestamp, and `created_at` alone leaves
those free to swap. All seven payload reads go through it, including the two
that previously spelled it out by hand.

**It reorders nothing in the account book.** An edit still matches by DtlKey, so
AutoCount's existing lines stay exactly where they are. This makes OUR side
deterministic, which is what a create and a new-line keying depend on.

**The guard found a read I had missed.** `backend/tests/acLineOrderWiring.test.ts`
scans both modules for every line read and fails on one that is not wrapped —
and it failed on `readConvertSourceKeys` (`autocount-convert-lines.ts:567`),
which I had not touched. That read returns the DtlKeys handed to a transfer, and
`details` pairs a quantity with each **positionally**, so an unordered read there
mispairs quantities. It is fixed in the same change.

**The guard itself was wrong twice before it worked, and both are worth
recording** because both produced a PASS against source it was written to
reject:

1. its matcher was built with `new RegExp` and the escaping collapsed, so it
   matched **nothing** — the file asserted over an empty population and went
   green. Plain string scanning replaces it, and every needle is now asserted to
   be FOUND before anything is asserted about it.
2. its context window reached only BACKWARDS from the match, so `.select(` —
   which sits AFTER — was never in it, every site was skipped as out-of-scope,
   and it went green again.

That is the CLAUDE.md rule *"a checker that cannot match reports a clean run"*
happening twice inside the checker written to enforce a different rule.

**Verified.** 8 tests. **PROVED RED on the unfixed source: 4 of 8 fail**
(`git stash` the two modules, keep the test file, run). Backend typecheck exit 0.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
