## 17 permission keys were granted to roles and thrown away without a word [medium]

<!-- area: Auth, permissions, sessions -->

**白话.** 系统里「职位/角色」这一块，每个角色存了一串「他可以做什么」的权限代号。
程式启动每个人的登入资料时，会拿这串代号去比对程式里的清单 —— **对不上的就直接丢掉，
不出错、不写 log、画面上也看不到任何东西**。目前有 22 个代号是这种情况：5 个是故意
关起来的（AutoCount 的旧唯读页面），另外 17 个是以前的车队/行程/客户入口模组留下来的
死代号，那些模组早就拆掉了。

这次查了那 17 个的每一个，确认**全部都没有任何地方在用**，所以**一个都不加进清单**——
加进去等于在后台多出一个可以勾、但勾了没作用的选项。

真正危险的是反过来的情况，而且已经发生过：`service_cases.approve` 这个代号在程式里
**真的有在挡人**，却没写进清单，结果「维修费用审批」变成只有老板和 IT 能按，后台怎么
调都调不出来，而且完全没有征兆。这次补的就是那个「没有征兆」：现在(1)后台
「Team > Roles」每个角色会直接写出「有 N 个代号这个版本不认得，所以不起作用」，
(2)API 多回传一个栏位，(3)只要有人新增一个没归类的代号，CI 就会红。

**Symptom.** None — and that is the defect. A permission key present in a stored
role row but absent from the code catalogue is discarded at session hydration
with no log, no error and no UI signal. The role reads as clean.

**Root cause (traced in source, not guessed).** `parsePermissions`
(`backend/src/services/permissions.ts`) filters every stored key through
`isValidPermission`, which answers only from `PERMISSIONS[]`. Two more places
depend on that same Set and fail just as quietly: `POST /api/roles` and
`PATCH /api/roles/:id` `.filter(isValidPermission)` the incoming array, and
`GET /api/roles/permissions` is what renders the admin checkbox grid — so an
undeclared key cannot be granted, cannot be stored, and is dropped if already
present, three times without a sound.

**The 17, classified individually — all RETIRED, none declared.** Each was
grepped as the literal across `backend/src` and `frontend/src`:
`grep -rF '"<key>"' backend/src frontend/src --include=*.ts --include=*.tsx`
returns **zero hits for all seventeen**. Every occurrence in the repo is inside a
role-seed `INSERT` in the dead D1 tree (`db/schema.sql`,
`db/migrations/009_roles_fleet.sql`, `db/migrations/014_qms_roles.sql`) or one
comment at `routes/inbox.ts:253`. No `requirePermission`, no
`requireAnyPermission`, no `can()`, no `.includes()` check, and no frontend use.
The modules are gone: `src/index.ts` mounts no `/api/trips`, no `/api/planner`
and no top-level `/api/reports`; `public.trips` was dropped by mig 0055; and
`/api/portal` + `/api/supplier-portal` authorise by CAPABILITY TOKEN
(`middleware/supplierTrack.ts`), never by a session permission. The live Fleet
keys are `fleet.read` / `fleet.write` on `scm/routes/fleet-maintenance.ts` — a
different, later module — while `routes/fleet.ts` has one gate and it is
`users.read`.

**So nothing was added to the catalogue**, and that is the point: declaring a
key that gates nothing puts a tickable checkbox in Team > Roles that grants
nothing. Two of the 17 would have been worse than useless —
`sales_orders.write` and `delivery_orders.write` have `.read` twins that are
ungrantable ON PURPOSE (`routes/udf.ts:26-32`), so declaring the writes would
have created a grantable write key above a deliberately shut read.

**Fix — the drop is now VISIBLE in three places**, because the silence had three
places to hide.
1. **Build.** `backend/tests/permissionCatalogueDrift.test.ts` re-derives the
   dropped set from every role grant in the tree and fails when a key is in
   neither `PERMISSIONS[]` nor the new `UNDECLARED_ROLE_KEYS` ledger. It is in
   the LIGHT project, so it runs inside `test:light` under `backend-typecheck` —
   a REQUIRED context — and blocks the merge rather than only the deploy.
2. **API.** `droppedPermissions()` is the exact complement of
   `parsePermissions()`; `GET /api/roles` returns it as `unknown_permissions`.
   This is the layer that catches a key living only in the production DB, which
   the build gate structurally cannot see.
3. **UI.** `frontend/src/pages/Roles.tsx` prints it under the permission count.

`UNDECLARED_ROLE_KEYS` records all 22 with a `status` (`legacy-closed` for the
five real-but-deliberately-shut udf gates, `retired` for the 17) and a `why`. It
is a LEDGER, not an allow-list — nothing reads it to decide access, and the test
fails on an entry that has since been declared, so it can only shrink.

**Also fixed: a stale pointer that invited the opposite bug.**
`permissions.ts`'s header said to keep the file in sync with "the frontend
permission registry". No such registry exists and none may exist —
`frontend/src/auth/capabilities.ts` records the owner's 2026-07-19 ruling that
the client holds booleans the server already decided, never a second copy of a
backend rule. The header now says that.

**New module guide.** `docs/modules/roles-permissions.md` — the flat permission
system had none, and `team-members.md` explicitly scopes Roles out. That gap is
part of how this survived.

**Guard proved RED before being trusted.** Adding one ungated key
(`brand.new.ungated.key`) to the Dispatcher grant in `db/schema.sql` fails
`permissionCatalogueDrift.test.ts` with that key named in the diff — the exact
recurrence scenario.

**NOT done, and it is a judgement call for the owner.** The 17 dead keys are
still sitting in the production `roles.permissions` rows. Stripping them needs a
migration that WRITES production data, and the benefit is cosmetic — they are
already inert. The risk is not: a naive "delete everything not in the catalogue"
would also delete the five `legacy-closed` keys, and `routes/udf.ts`'s header
depends on those surviving as the record of why those tables are shut. Left
alone deliberately, and now documented rather than silent.

**Ref.** `fix/permission-catalogue-silent-drop`, 2026-08-20.
