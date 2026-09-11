## The rest of the by-code catalogue reads still broke on an inch-mark code [medium]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**白话.** 我们有 3 个产品编号把「几寸」写成了引号 `"`（例如
`DUNLOPILLO GENERASI 5" MATT (SS)`）。系统很多地方都会「一次问一批产品」，而问的
方式碰到那个引号，就会**从引号那里把整串问题剪断 —— 那个编号、以及排在它後面的
所有编号，问了等於没问，而且不会报错，只会安静地回一个空答案。** 0780、0815 已经
把出问题的几处（MRP、供应商、销货单改单）修好了，但**同样写法的其他约 60 处还没
一起修** —— 库存、采购单、送货、盘点、报表、换购券这些页面里，只要那一批刚好带到
这 3 个编号之一，就可能少读到货、少算到量。这次把它们全部换成会「转义」的安全写法：
没有引号的编号，送出去的字串跟以前一模一样（所以本来正常的完全不动），只有真的带
引号 / 反斜杠时才走转义。顺手把这些读取里「读失败当成没有资料、悄悄吞掉」的 33 处
也改成会出声（写进 log），这样以後再断一次不会再没人知道。

**这次不改任何行为**（对乾净的编号是逐字节相同），是把一类地雷一次拆干净，而不是
等它在下一个页面再炸一次。

**Symptom.** Nobody reported a new failure — this is the sweep 0780 and 0815
both said out loud they were leaving for later ("67 `.in()` reads in
`backend/src` still filter on an item-code column and are exposed to the same two
product codes"; "Other unmigrated by-code `.in()` reads remain … a broader sweep
… tracked separately"). Left alone, the same defect fires the day one of the
three inch-mark codes lands in any of those batches: a short read that answers
200 and tells no one.

**Root cause (traced).** The same `@supabase/postgrest-js` 2.108.2 `.in()` defect
as docs/bugs/0780 and docs/bugs/0815: it quotes the reserved chars `[,()]` but
never ESCAPES, so a value carrying `"` (inch mark) or `\` closes its quoted value
early and the first `)` after it closes the whole `in.(…)` list. Every value
after it in the batch silently reads as absent, the request still answering 200.
On a READ the missing rows read as "not found"; on an UPDATE/DELETE the WHERE
matches fewer rows than intended. Three `mfg_products.code` values carry a `"`
today (verified against production project `anogrigyjbduyzclzjgn`, 2026-09-11:
`select code from scm.mfg_products where code like '%"%'` → 3 rows).

0780 introduced the one-home serialiser (`pgrestInList` / `parsePgrestInList`)
and fixed the MRP + supplier-binding reads; 0815 fixed the two SO-amendment
reads. Both used a hand-written `some(has " or \) ? .filter(…) : .in()` ternary
at the call site. Every OTHER by-code read/write kept the raw `.in()`.

**Fix.** One shared applicator, `pgrestIn(builder, column, values)`, added next to
the serialiser in `backend/src/scm/lib/pgrest-in-list.ts`. It escapes via
`pgrestInList` only when a value in the batch carries `"` or `\`, and otherwise
calls `.in()` unchanged — so for a clean list the emitted query string is
BYTE-IDENTICAL to today's. That is the property that let it drop in at 64 call
sites across 35 files (19 in `scm/lib`, 16 in `scm/routes`) with no behaviour
change and NO test-fake churn: a fake that only implements `.in` keeps working,
because a clean list never reaches `.filter`. The escape path is reached only by
a value the raw `.in()` would have silently dropped, so adopting it can only ADD
codes back to a short read — never remove one.

Shape chosen deliberately (the same reason 0815 gives): switching every site to
an unconditional `.filter('col','in', …)` would force a `.filter` verb onto
dozens of hand-rolled test fakes that implement only `.in`. Escape-when-needed
touches none of them.

Many of those sites also did `const { data } = await q` — a read whose failure
was discarded. Where the file had room, each now binds `error` and logs it (the
degrade-to-empty behaviour is kept; it just stops being silent — the swallow is
why 0780 stayed invisible for so long), lowering the swallowed-read ratchet
baseline by 24 (`backend/scripts/data/swallowed-read-baseline.json`, 866 → 842).

Five files are already over the file-size ceiling
(`scripts/file-size-ceilings.json`): `grns.ts`, `consignment-orders.ts`,
`delivery-planning.ts`, `mfg-purchase-orders.ts`, `mfg-sales-orders.ts`. There
the escaping `pgrestIn` wrap (the actual fix) still lands — folding the by-code
`.in()` into the call keeps those files net non-positive — but the extra
error-binding lines would grow a capped file, so their PRE-EXISTING swallow is
left exactly as it was (not worsened; the ratchet baseline for them is
unchanged). Binding those five is a follow-up that belongs with a split of those
files, not with a bug fix that must not enlarge them.

The `pwp_codes` sites (voucher-code writes, `so-cancel-vouchers.ts`,
`pwp-codes.ts`, and the TBC-swap blocks in `mfg-sales-orders.ts`) are included
for uniformity even though a minted voucher code carries no `"`: `pgrestIn` is a
proven no-op on those lists, so it is defence-in-depth at zero cost, and it means
the next reader never has to ask which by-code `.in()` is the safe one.

**Proved RED on the unfixed tree.** With `skuCategoryMap` reverted to
`.in('code', codes)`, `backend/src/scm/lib/sku-category.test.ts` ("the escaped
read resolves both categories") fails `expected [ null, null ] to deeply equal [
'mattress', 'sofa' ]` — the inch-mark code AND the code batched after it both
drop. Restored, it passes. The regression fakes model the wire faithfully
(postgrest-js quote-without-escape → `parsePgrestInList`), so a revert to a raw
`.in('code', …)` trips them. A second site is pinned in
`service-line-guard.test.ts` ("a SERVICE line whose code carries an inch mark is
still caught"), and `pgrest-in-list.test.ts` pins `pgrestIn` itself
byte-identical to `.in()` for a clean list against the REAL client.

**NOT swept, on purpose.** Columns other than `code` / `item_code` were left
alone — the enumeration was scoped to those two. `size-variant-description.ts`
also reads by `model_id` and `base_model`; if a model code ever carries a `"`,
the same helper applies there, tracked separately rather than widened here.

**Ref.** claude/scm-in-code-sweep, 2026-09-11.
