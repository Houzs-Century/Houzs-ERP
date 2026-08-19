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

Found while mapping every path a 0 can take after "saving RM 0 is inconsistent"
was reported. The full map at the time: line PATCH honoured it; ADD did not; the
approved-amendment path did not (fixed separately, #2470); the POS tablet must
not and still does not.

**Fix.** The ADD route selects `'operator-zero'` on the SAME strict terms as the
PATCH — off the POS, only when the price is actually 0, and only on
`zeroPriceIntended === true`. The editor sends the claim on a staged ADD exactly
as it does on an edit. `isPosTabletCaller` is now resolved ONCE into
`addLinePosTablet` rather than awaited twice in one expression.

`operatorZeroPriceWiring.test.ts` grew with it: the "selected in exactly ONE
place" assertion becomes TWO, each with its own strictness assertion, plus a
shape-independent backstop that fails if any selection of the mode appears
without the claim near it. The count is deliberately kept exact — a third
occurrence should be a decision, not a diff nobody read.

**Deliberately unchanged: an approved AMENDMENT's ADD line.** That path carries
no `zeroPriceIntended` — it has only `new_unit_price_sen`, which cannot
distinguish a typed 0 from an unfilled field — so it still reads 0 as "not
provided" and takes the catalogue figure. See `addLineTrust` in so-revision.ts
and the test that pins it. The difference is the CLAIM, not the operation.

**Ref.** fix/add-line-operator-zero, 2026-08-19. Completes #2425 + #2470.

