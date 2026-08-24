## New Sales Order create popped ONE missing required field per click [medium]

<!-- area: Sales orders + pricing -->

**白话.** 开一张新 Sales Order 的时候,系统是**一个一个**地报缺的字段:填了客户名 → 点建单 → 「要填电话」→ 填了 → 「要选场地」→ 「要选销售员」→ 「要选交货 State」…… 得来回填五次才建得成。老板现场试的时候直接问:「**为什么要慢慢爆呢**」。现在改成**一次把所有缺的字段一起列出来**,一个弹窗看完。

**Symptom.** Desktop `SalesOrderNew` submit ran a chain of `if (!x) { notify(); return; }`, so it surfaced only the FIRST missing field and returned. On a fresh order the operator hit five sequential dialogs (customer name → phone → venue → salesperson → delivery State), each a fix-and-retry. Confirmed in live QA 2026-08-20 on the Houzs Century company; the same one-at-a-time shape exists on the PO create form.

**Root cause (traced).** First-error short-circuit by construction — each required-field guard was its own early-return, and the delivery-State guard lived in a separate shared lib (`so-form-validate.ts` `soStockLocationError`) not even adjacent to the others, so nothing ever reported the full set at once.

**Fix.** New pure `soRequiredFieldErrors()` + `soRequiredFieldsMessage()` in `so-form-validate.ts` collect EVERY always-required missing field (customer name, phone, ≥1 product line, and for a confirm: venue, salesperson, delivery State) and render them in one message. Desktop `SalesOrderNew` calls it first; the conditional/sequential guards (date sanity, scanned-SKU, sofa-mix, Processing-Date proceed gate, the "State has no warehouse" config case, payment sub-fields) still run after, since each only applies once an earlier choice is made. Behaviour-preserving on the required SET (same fields enforced; the backend stays the authoritative gate) — pinned by new tests in `so-form-validate.test.ts` (28 pass). Not a correctness bug: orders always saved correctly once all fields were filled.

**Scope.** Desktop SO create done here. Mobile `MobileNewSO` already batches its customer group (`missingCustomerMsg` collects name/phone/email together) so it never had the worst of this; extending the shared collector across mobile + the PO/DO/GR/PI create forms (they share the tech) is the tracked follow-up. Not claimed as "every surface" — this PR is the desktop SO create.

**Ref.** this PR, 2026-08-20.
