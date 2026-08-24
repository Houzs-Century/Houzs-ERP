## A follower sofa line touched once could never be corrected from line 1 again [high]

<!-- area: Sofa, fabric, variants -->

**白话.** 一张单里第二、第三行沙发本来会跟着第一行走（同一套沙发同一个布、同一个
Seat Size）。但只要有人手动改过第二行的某一格，那一格就**永远锁死**——之后第一行
再改，第二行也不会跟。老板要的是：**第一行最后改的那次一定算数**。现在照他的规矩
改了。同时，本来这条规则在系统里有四份手抄本、三种不同行为（其中送货单那一份根本
没有跟随功能），现在合并成一份大家共用的。

**Symptom.** Owner 2026-08-21, on a Sales Order with two sofa compartments
added in one multi-add: he set the fabric and the seat size on line 1 and
expected line 2 to follow. His ruling when the trade-off was put to him: **the
master's LATEST change always wins**, even over a follower somebody had already
typed by hand.

**Root cause (traced).** `overriddenKeys` — a client-only set recording which
variant keys a line was manually edited for — was a permanent VETO on the
cascade: `if (overridden.has(k)) continue`
(`SalesOrderNew.tsx`, `ConsignmentOrderNew.tsx`, `MobileNewSO.tsx`). Once a key
was in that set it never left it except on a fresh SKU pick, so line 1 could
never correct line 2 again. Proved with a replica of `main`'s effect run over
the sequence: master corrected to `25`, follower previously hand-set to `23`
→ follower stays `{"seatHeight":"23"}`.

The same rule existed as FOUR hand-written copies with THREE behaviours:
`SalesOrderNew` (cascade + a buildKey fabric guard), `ConsignmentOrderNew`
(cascade, no buildKey guard), `MobileNewSO` (cascade, sofa/bedframe only,
skips `remark`, and triggered off a JSON string of the inherit map rather than
the lines), and `DeliveryOrderNewV2` — which seeds at pick time and has **no
cascade at all**, so a follower line there never follows anything.

**Fix.** The rule is now one module,
`frontend/src/vendor/scm/lib/so-variant-cascade.ts`, imported by
`SalesOrderNew.tsx`, `MobileNewSO.tsx` and `SoLineCard.tsx`. Three outcomes per
key, in order: the master MOVED it since the last run → force it onto the
follower (the owner's ruling); else the follower's own value is blank → fill it
(the inherit); else leave it, so an edit made after the master's last change
stands until the master moves again. That "since the last run" is a snapshot the
form holds in a ref — without it the only two available behaviours are both
wrong (a master that re-asserts on every render makes a follower uneditable, or
a cascade that never overwrites and the ruling never fires).

`overriddenKeys` is KEPT and still earns its place: it guards the per-sofa
fabric-colour sync in `updateLine` / the mobile FabricPicker, which is a
different rule (one physical sofa, not one category). It no longer gates the
master cascade.

The two surface differences are now REQUIRED arguments rather than hidden in
two copies: desktop passes `null` (every category cascades), mobile passes
`{sofa, bedframe}` (the only panels it renders).

`frontend/src/vendor/scm/lib/so-variant-cascade.test.ts` — 21 cases, including
the owner's multi-add sequence, the sticky-follower correction, and the
follower-edit-after-master case that must NOT be stomped on the next tick.

**Not fixed here, and named so it is not lost:** `DeliveryOrderNewV2.tsx` still
has no cascade, and `ConsignmentOrderNew.tsx` still carries its own copy. Both
are out of this PR's blast radius; whether a Delivery Order line SHOULD follow
its first line at all is a judgement for the owner, not a defect to silently
close.

**Ref.** fix/one-dropdown-positioner, 2026-08-21.
