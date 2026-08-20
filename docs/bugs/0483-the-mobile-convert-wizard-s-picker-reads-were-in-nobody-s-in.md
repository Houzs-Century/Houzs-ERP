## The mobile convert wizard's picker reads were in nobody's invalidation set [medium]

<!-- area: Frontend + mobile -->

**白话.** 同事在手机上开「转单」画面（例如把销售单转成交货单），画面会列出还没转过的
项目让他挑。问题是：**只要这个画面开着，它就不会再去问伺服器一次。** 如果这段时间别人
在电脑上、或另一个手机画面上，把同一张单的同一批货先转走了，手机这边还是照旧把那批货
列出来给他挑。他挑了、按下去，伺服器才回一句「超过可转数量」—— 白做一趟；更糟的情况是
那批货只被转走一部分，那就会用一个**错的数量**转过去。

**Symptom.** A mounted `MobileConvertWizard` kept offering convertible lines that
another surface had already consumed. Submitting them returns `over_remaining`;
where the remaining pool had only partly shrunk, a wrong quantity converts.

**Root cause (traced in source).** `MobileConvertWizard` re-implements all four
of its convertible-line reads inline, under three PRIVATE query-key roots it
invented and nothing else knows:

- `["convert-source", <sourceKind>]`
- `["convert-lines", <target>, <sourceId>]`
- `["convert-grn-lines", <poIds>]`

None appeared in `frontend/src/mobile/sharedInvalidate.ts`, so no convert —
desktop, another mobile flow, or the wizard's own create a moment earlier —
marked them stale. `grep -c "convert-lines" frontend/src/mobile/sharedInvalidate.ts`
returned `0`.

The file DOCUMENTS this hazard class in its own opening comment ("several mobile
screens still mutate via raw authedFetch + private `["mobile-*"]` query keys, so
a DESKTOP tab reads a stale … convert …") and then did not cover the wizard's
own keys. The class was named and the instance was missed.

**Fix.** The three roots are listed once in `sharedInvalidate.ts` as
`CONVERT_PICKER_ROOTS` and bumped by `invalidateConvertShared`, which every
convert already calls. Deliberately NOT a fourth private key at the call site —
inventing the key locally is what produced the first three. Prefix-match covers
every target / source-id / poIds variant.

**What this does NOT fix, said plainly.** It covers converts within one browser,
plus other TABS through the BroadcastChannel in `lib/cross-tab-sync.ts`. A
convert on a physically different DEVICE still cannot reach the phone — there is
no server push. The server's `over_remaining` refusal remains the real guard, and
always was; this removes the wasted trip and the partly-shrunk-pool case that a
stale local cache could turn into a wrong quantity.

**Guard proved RED first.** `frontend/src/mobile/convertWizardInvalidation.test.tsx`
fails **2 of 2** on the unfixed tree — `expected false to be true` for the three
roots' staleness, and `expected 1 to be greater than 1` for the mounted-wizard
refetch, which drives the reported failure end to end rather than asserting the
helper's contents.

**Ref.** `fix/mobile-convert-shared-invalidation`, 2026-08-21.
