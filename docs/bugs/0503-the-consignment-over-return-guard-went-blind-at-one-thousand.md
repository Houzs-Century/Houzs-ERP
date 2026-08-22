## The consignment over-return guard went blind at one thousand returns [high]

<!-- area: Delivery, DO, returns -->

**白话.** 寄卖退回的超退检查要先取「全部未取消的退回单」来算已退数，但那条读是
一把全捞：PostgREST 每次响应最多回 1000 行，超出的部分**无声截断**——而且不分公
司，对方公司的退回单也占这 1000 行的预算。排在截断线之后的退回单被当成「已取消」，
它退过的数量从账里消失，同一张寄卖单行就能**再整单退一次**、再入一次库（数据库
的唯一索引拦不住：第二张退回单是不同的 source_doc_id）。两个 picker 同病：已退完
/已发完的行被重新端出来。截断不报错，所以守卫的 fail-closed 错误分支从来看不见
它——只有分页能治。

**Symptom.** 2026-08-21 full-flow source audit, item A6 — found by grepping
bare `.neq('status','CANCELLED')` reads against `lib/paginate-all.ts`'s own
rule; the sibling read two queries up in the same picker has used `paginateAll`
all along, which is what made the three bare ones stand out.

**Root cause (traced).** Three reads in the consignment sales trio fetched
"live documents" un-paged and company-blind: `checkCrOverRemaining`'s
live-returns read (the write-time guard), `/returnable-note-lines`' twin, and
`/deliverable-order-lines`' live-notes read. The guard's error arm fails
closed — but a truncated page IS a success, so it never fired.

**Fix.** `consignment-returns.ts` / `consignment-notes.ts`: the three reads go
through `paginateAll` (stable `order('id')` inside the factory) and
`scopeToCompany`, with errors bound — the pickers 500 `load_failed`, the guard
keeps answering `OVER_REMAINING_UNPROVEN`. The guard's return-items read is
`chunkIn`'d for the same reason, and the guard now takes the request context
(its three callers pass it). `backend/tests/crOverReturnTruncation.test.ts`
pins paging + scoping + binding per site, the context plumbing, and the
fail-closed arms; RED on the unfixed tree (the anchors do not exist there),
GREEN here. Swallowed-reads baseline tightened (two reads gained bound errors).

**Ref.** fix/cr-over-return-truncation, 2026-08-21.
