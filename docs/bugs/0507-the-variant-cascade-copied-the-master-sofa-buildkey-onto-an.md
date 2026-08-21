## The variant cascade copied the master sofa buildKey onto an unrelated line [high]

<!-- area: Sofa, fabric, variants -->

**白话.** 一套沙发拆成几行的时候，每一行身上有一个「同一套」的记号（buildKey）。
问题是：如果第一行是这种拆开的沙发，而第二行是人手另外加的一张普通沙发，系统会
把第一行的记号**一起抄过去**——第二行就凭空变成了第一套沙发的一件。后果不是画面
好不好看：送货/开单那边算「买满一套送礼品」会把它算进去，PDF 打印也会把它并进
同一组里印。现在这个记号列为「永远不跟随」。

**Symptom.** Found while extracting the master-follower variant cascade
(entry 0506). Not owner-reported — no document has been audited for it.

**Root cause (traced).** The cascade looped `Object.keys(masterVariants)` and
copied every key that was not blank and not vetoed. `buildKey` is in that blob,
and the only guard around it (`differentSofa`) required BOTH lines to already
carry a non-empty `buildKey` — so it did nothing in exactly the case that
matters, a master WITH one and a follower with none. Run against `main`'s
effect: master `{buildKey:'B-1', seatHeight:'21'}`, follower `{}` → follower
becomes `{"buildKey":"B-1","seatHeight":"21"}`. Both desktop and mobile did it.

`buildKey` is IDENTITY, not a variant: it is written by the SO create path per
physical build and nothing on the frontend mints one
(`vendor/shared/so-line-display.ts:11`). A forged one makes the follower count
as a module of the master's sofa for the free-gift trigger
(`backend/src/scm/shared/free-gift.ts:274`) and print inside its module row on
the SO PDF (`vendor/scm/lib/sales-order-pdf.ts:485`).

**Fix.** `NEVER_INHERITED_KEYS = ['remark', 'buildKey']` in
`frontend/src/vendor/scm/lib/so-variant-cascade.ts`, applied by both the live
cascade and the pick-time seed (`seedFollowerVariants`), so the two paths can no
longer disagree. `remark` joins it because it is per-line by nature — a sofa's
compartments share a remark through the buildKey-scoped sync in the form, never
category-wide across two unrelated sofas (owner via Loo 2026-06-09). Mobile
already skipped `remark`; desktop did not, so this also closes that divergence.
Pinned by three cases in `so-variant-cascade.test.ts`.

**Not established:** whether any SO in production carries a forged `buildKey`
from this. It is a client-side blob written straight into `variants` on save, so
it would be visible in the data — that query has not been run and this entry
does not claim a count.

**Ref.** fix/one-dropdown-positioner, 2026-08-21.
