## One screen still called it Seat Heights and the refusal message called it Seat Height [low]

<!-- area: Sofa, fabric, variants -->

**白话.** 整个系统那一格叫「Seat Size」，只有开 Sales Order 那张单的行卡还写着
「Seat Heights」——而且是全公司唯一一个加了 s 的。另外，后台拒单的时候弹出来的
说明，把 seat_size 翻译成「Seat Height」，方向刚好反了：老板照着讯息去找
「Seat Height」那一格，画面上根本没有这个名字。两处都改成 Seat Size。

**Symptom.** The Sales Order line card labelled the sofa seat axis `Seat
Heights`, while every other screen in the system labels it `Seat Size`. The
server's refusal explanation then named it `Seat Height` — a third spelling,
and one that matches no control anywhere.

**Root cause (traced).** The rename to "Seat Size" landed in the shared rule
(`frontend/src/vendor/shared/so-variant-rule.ts:61` and its backend twin
`backend/src/scm/shared/so-variant-rule.ts`, both declaring
`label: 'Seat Size'`) and reached PurchaseOrderNew, GrnNew,
GoodsReceivedDetail, StockAdjustmentNew, PurchaseInvoiceNew, PurchaseReturnNew,
PoLineCard and PcVariantEditor. `SoLineCard.tsx` was missed — the label is a
hand-typed `label="Seat Heights"` prop, not read from the shared rule, so
nothing tied it to the rename. `frontend/src/vendor/scm/lib/refusal-detail.ts`
carried its own second hand-written map, `seat_size: 'Seat Height'`, which had
the mapping backwards.

**Fix.** `SoLineCard.tsx` renders `label="Seat Size"`; `refusal-detail.ts` maps
`seat_size: 'Seat Size'`, and its header table (which cited the old label and a
stale line number) is corrected with it. Two string edits — there is no test,
because the checkable half is exactly what the two hand-written copies defeat:
neither reads the shared rule. The durable fix is for both to take their label
from `so-variant-rule`, which is left as the noted follow-up rather than done
here.

**Ref.** fix/one-dropdown-positioner, 2026-08-21.
