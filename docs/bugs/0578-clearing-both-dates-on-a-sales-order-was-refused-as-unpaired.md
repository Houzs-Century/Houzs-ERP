## Clearing both dates on a Sales Order was refused as unpaired, and clearing only one was applied [high]

**Symptom.** Owner, 2026-08-31, on HC-SO-013393: 「为什么我 saved 它会显示 fail?
我这个是已经 proceed 了的单，然后我要 remove 掉我的 processing date 跟 delivery
date，不能的吗?」 The edit page answered *"Processing Date and Delivery Date must
be set together (or both left empty)"* — for a save that left both of them
empty, which is exactly what that sentence permits.

**Root cause (traced).** The header PATCH decided "does this request name the
date key?" with `typeof raw === 'string'`
(`backend/src/scm/routes/mfg-sales-orders.ts`, the date block), but the desktop
edit page sends a CLEARED date as JSON `null` — `payloadFor` in
`frontend/src/pages/scm-v2/SalesOrderDetail.tsx` builds `processingDate:
f.processingDate || null` — and `typeof null` is `'object'`. A clear therefore
fell through to the "key absent, keep the stored value" branch, so every rule
downstream judged the row this save was REPLACING instead of the row it was
about to leave behind.

Two opposite failures came out of that one line, which is why both are pinned:

* **the legal save was refused.** Clearing both: the Processing Date read as
  unchanged (the stored date), while the cascade — which uses `norm()`, and so
  *does* see `null` as a clear — cleared the Delivery Date. The pair rule was
  then handed one date present and one absent, and refused.
* **the illegal save was allowed.** Clearing only the Delivery Date: it read as
  unchanged too, so the pair rule saw two dates and passed — and the write went
  on to send `p_delivery_date: null` to the CAS anyway, leaving the order
  holding a Processing Date with no Delivery Date. That is the precise state the
  rule exists to prevent.

The same two lines, with the same `typeof` test, are in the consignment-order
header PATCH (`backend/src/scm/routes/consignment-orders.ts`), and
`ConsignmentOrderDetail.tsx` sends `|| null` as well.

Observed, not reasoned: both shapes were reproduced against the real handler
through the existing fake-Supabase harness in
`backend/tests/mfgSalesOrderHeaderCas.test.ts` before anything was changed —
clearing both returned **400**, clearing only the delivery date returned **200**
and applied.

**Fix.** One helper, `effectiveDateAfterPatch(raw, stored)` in
`backend/src/scm/lib/date-coerce.ts`, next to the `dateOrNull` it reuses:
`undefined` means the key is absent, anything else is the caller's value under
the same coercion the WRITE uses, so what the rules judge is what gets stored.
Both header PATCHes call it, and both cascade calls now test `deliv !==
undefined`.

The write-back half the owner also asked for (「你确保我 remove 了之后，它也是会
send 回去 AutoCount 的」) needed no change and is now pinned rather than assumed:
`touchedFields` is `Object.keys(updates)`, so a cleared pair reaches
`clearedAcKeys` and leaves as `PDate: ""` plus `SalesExemptionExpiryDate: null`
— asserted in `backend/src/scm/lib/autocount-outbox.test.ts`.

**Ref.** fix/so-date-pair-null-clear, 2026-08-31.
