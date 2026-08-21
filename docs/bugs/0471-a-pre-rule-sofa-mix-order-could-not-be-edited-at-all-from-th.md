## A pre-rule sofa-mix order could not be edited AT ALL from the phone [high]

<!-- area: Sales orders + pricing -->

**白话.** 后台只挡「这一次改动才制造出混单」（沙发不能跟床架／床褥同单），**旧单一律
放行**；电脑版 #2395 已经改成一样的问法。手机版还留着旧的「只要有混单就挡」，而且这个
检查摆在编辑分支的**上面** —— 于是销售在手机上打开一张旧的混单，连**改个电话号码**都
存不下去，弹出来的理由还是后台自己早就不管的那条规则。现在手机改成跟电脑、跟后台同一
个问法：只有**这次改动新造出**混单才挡。开新单的行为完全没变。

**Symptom.** On a Sales Order written before the sofa-exclusivity rule existed,
a rep on the phone cannot save ANY change — not a phone number, not an address,
not a delivery date. The message names a rule the server itself grandfathers.

**Root cause.** `MobileNewSO.save()` ran the FLAT `hasSofaMixConflict` over the
edited lines. That is the CREATE path's question ("does this set mix?"), and the
guard sits ABOVE the edit branch inside `save()`, so it fired on edits too. The
server asks a different one: its three line paths call `mainMixIntroduced` and
refuse only a change that INTRODUCES the mix. Desktop's `SalesOrderDetail` was
moved to the matching differential form in #2395; mobile was not, so the client
refused saves the server would have accepted.

**Fix.** `frontend/src/mobile/MobileNewSO.tsx` now calls the same shared
`sofaMixIntroduced(storedGroups, editedGroups)` desktop calls
(`vendor/shared/so-variant-rule.ts`), with `origItems` — the persisted lines —
as the "before" set. On a create `origItems` is empty, so `sofaMixIntroduced`
degrades to exactly the flat question and the create path is unchanged.

**Test.** `frontend/src/mobile/mobile-so-sofa-mix-edit.test.ts`. Source-text
contract over `save()`, the idiom `so-slip-optional-contract.test.ts` already
justifies for this 3,700-line screen: it pins WHICH predicate the guard runs and
that the "before" set is `origItems` (a differential guard fed the edited set
twice is the flat guard wearing a new name). Run RED first — it reported
`expected 'async function save(asDraft = false) …' to contain 'sofaMixIntroduced('`.

---
