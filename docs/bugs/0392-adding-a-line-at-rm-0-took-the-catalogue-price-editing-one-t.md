## Adding a line at RM 0 took the catalogue price; editing one to RM 0 did not [medium]

<!-- area: Sales orders + pricing -->

**白话.** 同一个 RM 0，改现有的那一行可以，新增一行就不行 —— 新增的那行会被自动
填回目录价，而且不报错。原因是 8 月 18 号让「打出来的 0」生效的那个开关只接到了
「改行」这条路上，「加行」那条没接。销售看到的就是：同一个金额，点这里可以，点那里
不行。现在两条路一致了。

**Symptom.** In the ERP SO editor, setting an EXISTING line to RM 0 saves as 0.
Adding a NEW line at RM 0 on the same order silently comes back at the catalogue
price. Same amount, same screen, same person — accepted on one click, replaced on
another, with no error either way.

**Root cause (traced).** `'operator-zero'` — the mode that lets a TYPED zero
survive the honest-pricing recompute — was wired to `PATCH /:docNo/items/:itemId`
only. `POST /:docNo/items` passed plain `!(await isPosTabletCaller(c))`, and
plain `true` reads `manualUnitSelling > 0`, so a 0 falls to the catalogue fill.
The editor did not send `zeroPriceIntended` on the ADD payload either, so even a
willing backend had nothing to read.

Found while tracing where a 0 survives and where it does not, after "saving RM 0
is inconsistent" was reported from the showroom. The four trust decisions that
answer that question are `amendTrust` + `addLineTrust` (so-revision.ts) and the
two `erpLineTrust` call sites (mfg-sales-orders.ts).

**Fix.** Both DIRECT line writes now ask ONE helper, `erpLineTrust`
(mfg-pricing-recompute.ts): `'operator-zero'` off the POS, only at a price of 0,
and only on `zeroPriceIntended === true`. The editor sends that claim through one
`zeroPriceClaim` helper on both the PATCH and a staged ADD. Two copies of a money
rule is how the two paths drifted apart in the first place, so there is now one.

Net effect on `mfg-sales-orders.ts` is NEGATIVE — the duplicated rationale
collapses into the helper — which is also how it lands under the file-size
ratchet.

**Deliberately unchanged: an approved AMENDMENT's ADD line.** That path carries
no `zeroPriceIntended`; it has only `new_unit_price_sen`, which cannot
distinguish a typed 0 from an unfilled field. So it still reads 0 as "not
provided" and takes the catalogue figure — `addLineTrust` in so-revision.ts and
the test beside it pin that. **The difference is the CLAIM, not the operation.**

`operatorZeroPriceWiring.test.ts` was rewritten around the helper: the mode is
selected in exactly one place, the helper demands the strict claim, and both line
writes pass through it carrying the POS flag. `soTotalFloorRemoved.test.ts` had
its `!posTablet` assertion FOLLOWED to the helper rather than deleted — a
refactor that moves an expression must move its pin, or the invariant quietly
stops being checked.

**Ref.** fix/add-line-operator-zero, 2026-08-19. Completes #2425 + #2470.
