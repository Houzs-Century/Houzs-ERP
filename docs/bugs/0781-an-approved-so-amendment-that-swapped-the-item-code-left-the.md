## An approved SO amendment that swapped the item code left the line NAME stale, so the amend editor showed the old product [medium]

<!-- area: Sales orders + pricing -->
<!-- status: open -->

**白话.** 改一张已锁定销售单要走「修订（amendment）」。批准后，如果这次修订是
换 item 编号（例如把 2A 左扶手换成 2A 右扶手），系统把**编号**换了、价格也换了，
读取页面看到的都是新的——但**忘了同步那一行的「产品名称」**。名称还停在旧的
（「SOFA VERANO 2A(LHF)」）。而「修订编辑页」是按名称显示每一行的，所以看起来像
整行都没改，其实底层编号、价格都是新的。左/右扶手是镜像沙发，名字印错会误导。
根治＝以后换编号时，像「新增行」一样从产品目录重新带出名称。历史已改的单另用一个
一次性脚本补正（默认只看不改）。

**Symptom.** Owner, 2026-09-10, on `HC-SO-012016`: raised an SO amendment,
approved it (revision 2 -> 3, swapping `9028-2A(LHF)` -> `9028-2A(RHF)` and
`9028-1A(RHF)` -> `9028-1A(LHF)`, one price 638000 -> 0), then reopened the amend
editor and the line items "还是原来的" — the OLD product names. The read view and
the follow-up PO showed the NEW codes, so the amendment had clearly applied; only
the amend editor looked unchanged.

**Root cause (traced, by reading the code).** `applySoAmendment`'s SPEC branch
(`backend/src/scm/lib/so-revision.ts`, the `mfg_sales_order_items` UPDATE) rewrote
`item_code`, qty, variants, price and costs but **never wrote `description` (the
product name) or `description2`**. The ADD branch in the same function DOES resolve
the name from the catalogue (`mfg_products.name`) and its comment records that the
ADD path was fixed for exactly this on 2026-08-11 — the SPEC path was left with the
same defect. So after a code-swap the line stores the NEW code with the OLD name.
The two surfaces diverge because they name a line by different fields
(`frontend/src/vendor/shared/line-identity.ts`): the order-line read view uses
`orderLineIdentity` (code-first — shows the updated code), while the amend editor's
`SoLineCard` picker uses `lineIdentity` (name-first — shows the stale description).
Not a cache: the amend editor showed the NEW price `0.00` beside the OLD name, so it
was reading the current row; only the name field was stale. No silent-revert risk —
the editor resubmits `newItemCode` from the stored (new) code, not from the name
(`SalesOrderDetail.tsx`).

**Fix.**
- **Forward (A, merged in this PR).** The SPEC branch now re-resolves `description`
  from `mfg_products.name` for the new code (company-scoped, fail-soft on an
  unknown code) and rebuilds `description2` from the applied variants — mirroring
  the ADD branch. Pinned by
  `backend/src/scm/lib/so-revision.amendmentPrice.test.ts` (new describe block):
  proved RED on the pre-fix tree (`expected "Nesting Table", received "Side
  Table"`), GREEN after; a QTY-only guard test confirms the write is scoped to
  SPEC.
- **Historical (B, built; DB run pending dispatch — UNTESTED against prod).**
  `backend/scripts/repair-so-amendment-line-names.mjs` (+ pure planner
  `scripts/lib/so-amendment-name-repair.mjs`, tested by
  `backend/tests/soAmendmentNameRepair.test.mjs`) resets `description` to the
  catalogue name for lines that went through an applied SPEC amendment and whose
  name is now stale — `description` only, never a price/qty/variant/status/date,
  and never blanked. Plan by default; `MODE=apply` + `CONFIRM="REPAIR SO
  AMENDMENT NAMES"`; fresh-connection shape verify. Dispatch via Actions ->
  **Repair SO amendment line names (plan by default)** (plan first, review, then
  apply). Passes `audit:release-discipline`.

**Ref.** claude/priceless-chaum-35a0dd, 2026-09-10. Forward fix ships on merge;
historical rows stay stale until B is dispatched.
