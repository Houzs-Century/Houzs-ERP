## The phone could not create a purchase order, goods receipt or purchase invoice [medium]

**Symptom.** On a phone, the "+" on Purchase Orders and Goods Receipts could only
CONVERT from another document (a PO from a Sales Order, a GRN from a PO). A buyer
who needed a plain PO, or a storekeeper receiving goods that no PO covered, had to
find a PC. Purchase Invoices had no "+" at all. Owner ruling 2026-09-12:
「电脑版本有的，手机版本都要有」 — and the convert wizard is not how he wants to create.

**Root cause (traced).** A missing surface, not a broken rule. On `origin/main`
before this change:

```
$ git show origin/main:frontend/src/mobile/MobileApp.tsx | grep -n -A 6 "^const MODULE_TO_CONVERT"
222:const MODULE_TO_CONVERT: Record<string, ConvertTarget> = {
223-  "delivery-orders-mfg": "do",
224-  "sales-invoices": "si",
225-  "grns": "grn",
226-  "mfg-purchase-orders": "po",
227-};
$ git grep -n "useCreatePurchaseOrder\|useCreateGrn\b\|useCreatePurchaseInvoice\|canOperatePurchaseInvoices" origin/main -- frontend/src/mobile frontend/src/auth
(no output, exit 1)
```

The only "+" these lists had was the convert wizard, no mobile file called any of
the three direct-create hooks the desktop pages use, and the Purchase Invoices
config carried no `form` either, so `MobileApp` gave it no `onNew`.

**Fix.** `frontend/src/mobile/MobilePurchaseDocNew.tsx` (screen) plus
`frontend/src/mobile/mobile-purchase-doc.ts` (request bodies, pre-checks, the
module mapping and the gate). The list "+" now opens a DIRECT create; the convert
wizard stays one tap away on that screen for PO and GRN. It holds no rule of its
own:

- the create/post calls are the SAME vendored hooks the desktop pages call;
- the PO variant gate is `vendor/shared/so-variant-rule.missingVariantAxes`, the
  function desktop's `missingRequiredVariants` wraps, with the item code passed so
  the DIVAN ONLY exemption holds (a test asserts phone and desktop return the same
  answer for the same lines);
- the "+" gate is `canOperatePurchaseOrders` / `canOperateGoodsReceipts` and a NEW
  `canOperatePurchaseInvoices` — the third arm of the same private
  `canOperateScmProcurement` rule, on the `scm.procurement.pi` area the backend
  already guards `/purchase-invoices/*` with.

**Proved to discriminate, not merely to pass.** Each rule was broken on purpose
and the named test went RED:

| broken on purpose | test that failed |
|---|---|
| PO variant gate skipped | refuses to CONFIRM a bedframe PO missing its options — and sends nothing |
| picker SELLING price seeded onto the line | never carries the catalog SELLING price onto a purchase line the buyer did not price |
| PI post call removed | PI: creates the manual invoice then POSTS it — without the post no liability is booked |
| phone list refresh removed | GRN: creates the manual receipt with an idempotency key, posts it, refreshes the phone lists |
| item code dropped from the variant rule | keeps the DIVAN ONLY exemption, which needs the item code |
| PI helper reading `scm.procurement.po` | reads scm.procurement.pi, and PO / GRN edit rights do not lend it |

**A defect the tests could not see, caught by using the screen.** Rendered at 375px
with the real CSS (a local Vite harness whose `fetch` answered from fixtures and
refused everything else — the dev `API_URL` is the production Worker), a receipt
typed as "12.50" SAVED AT RM 0. Two causes were stated and tested in turn: the
typing never reached the box (refuted — after typing, the box read "12.50" with
focus), and the save reading lines before the blur-commit (refuted — tapping
save while focused sent 1250). The real mechanism, reproduced directly: the price
box started at "0.00", and the shared `MoneyInput` refuses a keystroke giving 3
decimals, so "0.00" + "1" is dropped — every keystroke that lands before its
select-on-focus `setTimeout` is lost, silently. Appending "12.50" to "0.00" left
"0.00"; the selection (0..4) only appeared a tick later. The line's price now
starts BLANK, which gives a keystroke nothing to collide with on any browser; the
same instant gesture then sent 1250 and posted the receipt. Pinned by "takes the
buyer's price when they type straight into the new line's box", proved RED with a
"0.00" start (`expected '0.00' to be ''`).

That refusal lives in the shared `MoneyInput`, so a desktop line editor that
starts at "0.00" behaves the same; whether a real WebKit phone honours the delayed
`select()` is UNKNOWN (no WebKit run here). Not changed in this entry.

**Not fixed here, stated.** No product-option editor on the phone (a sofa or
bedframe PO line saves as a draft and is completed on desktop), no supplier price
auto-fill, MYR only, no per-line delivery date / warehouse override / discount /
rack, no PI from a GRN on the phone.

**Ref.** feat/mobile-direct-create-purchasing, 2026-09-13.
