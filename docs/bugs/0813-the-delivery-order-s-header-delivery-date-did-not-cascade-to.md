## The delivery order's header delivery date did not cascade to its lines, and the date was invisible on the document [high]

**Symptom.** Owner 2026-09-11, with two screenshots of one delivery order:

> "dalam ERP for issuing DO, the delivery date dah ada, but at the item tak ada
> delivery date. this one can do it auto fill the delivery date once we select
> the date? or kena manually fill?"
> 「然后item delivery 如果我上面customer delivery date 更改下面不能自动跟吗」
> 「然后确定 我们DO item delivery date有看到？我看到是有的 可是外面没有」

Two separate faults, one screen:

1. The DO form's header read **Customer delivery date 24/09/2026** while all
   **ten** of its lines read **19/09/2026**. Changing the header moved nothing,
   so the operator had to retype the date on every line.
2. The DO DETAIL page showed four columns — Item, Type, Qty to deliver, Photos.
   No delivery date at all. So the date was editable in the form and invisible
   on the document, which is what "我看到是有的 可是外面没有" describes.

**Root cause (traced).**

1. **The cascade was written on the SALES ORDER and never on the DELIVERY
   ORDER.** `SalesOrderNew.tsx` has had a `useEffect` since PR-E that pushes the
   header date onto every non-overridden line. `DeliveryOrderNewV2.tsx` has no
   such effect — and its own payload builder carried the comment *"`lineDelivery
   DateOverridden` carries the operator intent so a header-change cascade skips
   lines they typed by hand"* since docs/bugs/0807-do-line-delivery-date-silently-dropped-by-payload-key-mismat.md,
   describing a cascade that did not exist on that page. Both screens use the
   same `SoLineCard`, which is exactly why the difference was invisible until
   somebody changed a header and watched the lines not move.
2. **The column was never added, not missing data.** The detail GET has selected
   `line_delivery_date, line_delivery_date_overridden` on its ITEM columns since
   the column existed (`delivery-orders-mfg.ts` line ~351). `DeliveryOrderDetailV2`
   simply had no entry for it in `lineColumns`, and no field for it on its
   `DoItem` type.

**Fix.**

- The rule moved OUT of the page and into
  `frontend/src/vendor/scm/lib/line-delivery-date-cascade.ts`:
  `cascadeLineDeliveryDate(lines, headerDate)` returns a new array, or `null`
  when nothing moved (both callers run it inside `setLines(prev => ...)`, and a
  fresh array every render would remount line cards holding staged photo
  uploads). A line with `line_delivery_date_overridden` is never moved.
- Both forms now call it — the delivery order for the first time, the sales order
  in place of its inline copy. **A rule hand-copied per form is how the two
  disagreed in the first place**, so the second copy is gone rather than matched.
- `DeliveryOrderDetailV2` gains a **Delivery date** column, muted when the date
  follows the header and full-strength when an operator set it on that line —
  the same distinction the form's date field already draws with its
  "Auto-inherited" styling.
- 10 cases pinned in `line-delivery-date-cascade.test.ts`, including the two a
  hand-written copy gets wrong: the override is respected, and clearing the
  header clears its followers.

**Not changed, and why.** `src/mobile/MobileNewSO.tsx` keeps its own line shape
(`l.ddate`) with NO override flag, so it cannot take this cascade safely — a
cascade with nothing to except would overwrite a date the operator typed. It is
a separate gap on a surface the owner did not report; recorded here rather than
half-fixed. The mobile SO->DO convert needs nothing: `/from-sos` has written the
header's date onto every line since 0807-do-line-delivery-date.

**Ref.** `fix/do-line-date-cascade-and-column`, 2026-09-11.
