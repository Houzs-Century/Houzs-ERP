## The bedframe cascade wrote a removed drawer back onto beds 2 and 3 [high]

**Symptom.** Salesperson Cheah Huan, on HC-SO-012312 (three bedframes on one
order): 「第一个床架 放的资料，第二 第三 自动 duplicate，变成自己要一个一个 remove
改」 and 「刚刚我改了 两次 about 第二三不需要 drawer，结果还是有，remove 三次才没
有」. She removed the drawer from beds 2 and 3, it came back, and she had to
remove it once per attempt.

**Root cause (traced).** `so-variant-cascade.ts` makes the FIRST line of a
category the master and every later line a follower, and `followerVariants`
resolves each key in this order:

1. the master MOVED this key since the last snapshot → **FORCE it onto the
   follower, overwriting a hand-typed value**;
2. the follower's own value is blank → fill it;
3. otherwise leave it.

Rule 1 is the owner's 2026-08-21 ruling (「第一个沙发再改就拉回去」) and it is
correct — for a SOFA, which is one physical thing assembled from several lines.
It was also applied to bedframes: mobile declared `["sofa","bedframe"]` and
desktop passed `null`, meaning EVERY category. So each time she touched bed 1
the drawer was forced back onto beds 2 and 3, and `NEVER_INHERITED_KEYS` is only
`['remark','buildKey']` — specials such as the drawer travel like any other key.

The SEED did the same thing one step earlier: `seedableMasterVariants` +
`seedFollowerVariants` pre-fill a NEW line from the category master, which is
the 「第二 第三 自动 duplicate」 half.

**Fix.** Owner ruling 2026-09-09, asked directly: 「主行改一次，全部跟着改 …
这个只限于 sofa item」. `CASCADE_CATEGORIES = new Set(['sofa'])` in the shared
module, imported by BOTH Sales Order surfaces — mobile's local
`["sofa","bedframe"]` and desktop's `null` are gone, so one rule now has one
answer instead of two.

`seedableMasterVariants` gained a REQUIRED `categories` parameter rather than
reading the constant itself. That is the `optional-param-noop` rule
(`docs/bugs/0098-*`) paying for itself immediately: the compiler enumerated
**four** call sites, two of which nobody had mentioned — `ConsignmentOrderNew`
and `DeliveryOrderNewV2`. Both are passed an explicit `null` (UNCHANGED): the
owner's ruling was given about Sales Orders, and narrowing a document he was not
asked about would be extending his ruling for him.

Pinned by `so-variant-cascade.test.ts` → `describe("the sofa-only ruling")`,
**PROVEN RED**: widening the constant back to `['sofa','bedframe']` fails three
of its tests (the constant itself, the bedframe master not forcing followers,
and the seed not pre-filling a bedframe line).

**Not covered.** Whether the RM250 that appeared on the same order when the beds
were split is related. Specials travel with the cascade and specials can be
priced, so this fix plausibly removes a SOURCE of surprise charges — but it does
not explain that one, whose third line carries FEWER specials than the two FOC
lines above it. Being chased separately with a read-only probe.

**Ref.** `fix/mobile-proceed-date-derive`, 2026-09-09.
