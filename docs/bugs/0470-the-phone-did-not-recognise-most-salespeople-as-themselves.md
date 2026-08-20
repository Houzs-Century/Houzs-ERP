## The phone did not recognise most salespeople as themselves [high]

<!-- area: Sales orders + pricing -->

**白话.** 140 个 `scm.staff` 里只有 18 个填了 email，102 个有 `user_id`，而后台认人
用的就是 `user_id`。电脑版 #2049 已经改成**先比 `user_id`**。手机版还是先比 email
再比名字，所以**大部分销售员**在手机上都不被认成自己 —— 掉进 `__self__` 这个占位值，
然后在确认订单时被「Pick a salesperson before confirming this order」直接挡掉。旁边
那句注解还写着「by id / email / name」，可是程式根本没比过 id。现在两边共用同一段
`resolveSelfStaff`，注解也改成实话。

**Symptom.** A salesperson whose `scm.staff` row carries no email is not
detected as themselves on the phone. The Salesperson field falls back to the
UI-only `__self__` placeholder, and the confirm guard in `save()` can refuse the
order outright.

**Root cause.** `MobileNewSO`'s `selfStaffMatch` matched email, then name. The
string `userId` did not appear anywhere in the file, while its own comment
advertised an id match it never ran. `user_id` is the ONLY link that actually
exists on this data (102/140 rows, measured on production 2026-08-12 and quoted
in #2049) and is what the backend resolves the caller by (`resolveOwnerStaffId`
joins `staff.user_id`), so the frontend and the backend disagreed about whether
the caller had a staff row at all.

**Fix.** New SHARED `frontend/src/vendor/scm/lib/self-staff.ts` —
`resolveSelfStaff(staffList, me)`, ladder user_id → bridge staff id → email →
name, with a null caller id never matching a null `userId`. `MobileNewSO` and
desktop `SalesOrderNew` both call it. The desktop ladder was moved VERBATIM, so
that screen behaves exactly as before; the mobile one gains the `user_id` step.
The lying comment is gone.

**Test.** `frontend/src/vendor/scm/lib/self-staff.test.ts` — a real unit test of
the resolver (including the production case: IT Admin, `user_id` 4, email NULL,
which id/email/name all missed) plus a contract that both New-SO surfaces read
the module and no fourth copy is written. Run RED first: `Failed to resolve
import "./self-staff"`.

**Found while fixing it, NOT fixed here.** `SalesOrderDetail.tsx:551` keeps a
THIRD copy (id → email → name, no `user_id`). It only defaults the Add-Payment
"Collected By" picker, so its failure mode is a blank cell rather than a blocked
save, and switching it would CHANGE that screen's behaviour — it would start
matching people it does not match today. That is a decision, not a defect fix.

---
