## The salesperson picker hid the person using it, so the SO said '(me)' and named a sitting employee '(former staff)' [high]

<!-- area: Sales orders + pricing -->

**白话.** 开单画面上的 Salesperson 下拉，只放「销售部门」的人 —— 这条规矩本身是老板
2026-07-22 定的，没错，要留。问题出在：画面还要靠这份名单去认「现在开单的是谁」和
「这张单原本是谁开的」。名单里没有的人，两件事都认不出来：

1. 老板自己开单，名字栏跳出来的是「XXX (me)」—— 那不是一个真的员工，是画面自己造
   出来的假选项。老板的话：「『我』不应该存在，永远要是一个真人。」
2. 收款那行的 Collected By 变空白（画面上是「—」）。
3. 最重的一个：单子上已经存着的那个 salesperson，只要那个人不在销售部门，画面就写
   「(former staff)」——「离职员工」。老板几分钟前自己开的 HC-SO-2608-003 就是这样。
   人还在公司坐着，单子上却写他离职了。

一个根，三个症状。修法是：名单不管怎么筛，**永远**要包含「现在操作的这个人」和「这
张单上已经有的那个人」。筛选规矩一个字没动 —— 其他销售人员看到的名单跟以前一模一样。

**Symptom.** Owner, 2026-08-21, on `HC-SO-2608-003` — an order he had raised
himself minutes earlier — the Salesperson field read `(former staff)`. On a new
order the same field read `<his name> (me)`, and the Payments row's "Collected
By" cell defaulted to blank.

**Root cause (traced).** `GET /staff/pickable?onlySales=1`
(`backend/src/scm/routes/staff.ts`) narrows the roster with
`services/pmsAccess.isSalesUser` — position matching `/^sales/i` OR a department
name containing "sales". That narrowing is correct and is the owner's own
2026-07-22 instruction ("exclude office / admin / owner / test accounts"). The
defect is that three places then resolved a *person* against that narrowed list:

- `SalesOrderNew.tsx` `resolveSelfStaff(staffList, …)` — no match, so the page
  synthesized a UI-only `__self__` option labelled `<name> (me)` and stripped it
  again at submit time;
- the same file's `defaultCollectedBy={selfStaffMatch?.id ?? ''}` — blank for
  the same reason, so `PaymentsTable`'s Collected-By select fell to `—`;
- seven pickers (`SalesOrderDetail`, `SalesInvoiceNew`, `DeliveryReturnNew`,
  `ConsignmentNote/Order/Return New+Detail`) resolved the document's STORED
  `salesperson_id` against it and labelled the miss `(former staff)`.

Proved rather than reasoned: `services/positionAccessSnapshot.ts` is generated
from the live system (`https://erp.houzscentury.com`) and lists the 17 live
positions; running `isSalesUser` over them excludes `Super Admin`,
`HR Manager`, `Finance Manager`, `Operation Manager`, `Operation Executive`,
`Procurement/Purchasing`, `Logistic Admin`, `Storekeeper`, `Driver`, `Helper`,
`Service Admin`, `Storekeeper Supervisor` and `Calendar Viewer` — every one of
them a person the pickers could not name.
`backend/scripts/check-salesperson-picker-roster.mjs` +
`.github/workflows/salesperson-picker-roster-check.yml` report the same split
against production on demand (read-only, counts and position names only).

**Fix.** THE ALWAYS-HOLDS RULE, server-side, so there is one answer for every
consumer: `GET /staff/pickable` now unions the narrowed roster with (a) the
CALLER's own active staff row, always, and (b) every id passed in
`?include=<uuid>,…` — the ids a screen already has to name. Both defeat
`onlySales` only; neither resurrects a deactivated row, so `(former staff)`
keeps meaning gone. `alwaysPickableStaffIds` / `unionAlwaysPickable` /
`parseIncludeIds` live in `scm/lib/staffCompanyScope.ts` beside the company
rule; `scopeStaffRowsToActiveCompany` now reports `failClosed` so the union is
skipped when the company gate blanks the list. The `__self__` sentinel and its
submit-time special case are DELETED from both surfaces
(`pages/scm-v2/SalesOrderNew.tsx` and `mobile/MobileNewSO.tsx`), and the eight
pickers that must name a stored salesperson pass it through `include`.
`backend/tests/staffPickableAlwaysHolds.test.ts` pins the caller-is-always-in
invariant with the real `isSalesUser`, pins that nobody else is let back in, and
structurally pins that every exit from the handler goes through the union —
proved RED against `origin/main`'s route (2 failed), GREEN here.

**Ref.** fix/salesperson-roster-always-holds-you, 2026-08-21.
