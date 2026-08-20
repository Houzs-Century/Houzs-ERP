## A sales rep could not edit a case on desktop and got a screen of 403 buttons on the phone [high]

<!-- area: Service cases (ASSR) -->

**白话.** 老板 2026-07-23 定的规矩：**sales agent 不应该有 edit case 功能**。电脑版
从那天起就照做了 —— sales 点进服务单，会被转到一个只能看、能留言的画面。

**手机版从来没有做这半边。** 手机上 sales 点进服务单，看到的是**跟 office 同事一模
一样的完整编辑画面** —— 换阶段、Advance、Close、Archive、改数量全都在。

先讲清楚有没有出事：**没有人偷改到东西。** 我们直接去正式资料库数过（不是用猜的）：
现在有 32 位 sales，全部挂在同一个角色「Sales Person」，这个角色**没有**改服务单的
权限。所以那些按钮**每一个按下去都是被拒绝**。不是资料被乱改，是**按了没反应、只跳
错误**——同事以为是系统坏了。

更亏的是另一半：sales 本来就**可以**做的两件事 —— 留言给 office、催 office
（Nudge）—— 手机上**根本没有地方做**，因为手机没有那个「My Cases」画面。所以他们
既不能改，也不能做那件本来就该他们做的事。

现在手机跟电脑一样了：sales 点进去看到只读画面 + 留言 / 催单，其他人照旧。

**Symptom.** On a phone, a non-director Sales rep opening a service case got the
full editable `MobileServiceCase` detail — stage select, Advance, Close,
Archive, item-quantity edits, attachment visibility. Every one of those controls
answered 403. Separately, the rep had no mobile route to the sales-comment /
sales-nudge thread at all.

**Root cause.** The owner's rule had exactly ONE enforcement point and it was
desktop-only. `SalesRepCaseDetailRoute` (`frontend/src/App.tsx`) redirects
`isSalesNonDirector` off `/assr/:id` onto the read-only `/my-cases/:id`, pinned
by `frontend/src/auth/permissionDivergence.test.ts`. Mobile had no equivalent:
`isSalesNonDirector` had ONE mobile call site in the entire tree
(`MobilePMS.tsx`) and it has nothing to do with service cases. The Service tab
gates on `allowed("/assr")` — whose own comment records that Sales staff pass —
and then mounted the editable detail. The only sales-aware suppression inside
that screen was the supplier card.

The BACKEND never enforced the ruling either: every write route is
`requirePermission("service_cases.write")`, a flat matrix key that knows nothing
about the Sales cohort. `canAccessServiceCases` (the company-grant gate) is
applied to the read and create endpoints only, deliberately, so it never widens
mutation access.

**Which of the two possible failures was live — READ, not assumed.** "Either
they hold the key and this is unauthorised editing, or they do not and the
buttons all 403" is two different bugs with two different urgencies, and the
answer lives only in production. Read by the existing dispatchable census,
extended with a §5 (`backend/scripts/census-service-case-visibility.mjs`,
workflow `census-service-case-visibility.yml`, **run 32395787958**):

```
active non-director Sales staff (frontend isSalesNonDirector) = 32
reps holding service_cases.write  = 0
reps holding service_cases.manage = 0
```

All 32 are on one role, `Sales Person`, carrying `service_cases.read` alone. So
this was **NOT an authorisation hole** — no rep could ever have edited a case
from the phone. The ruling was in fact being enforced, by the permission matrix
simply never granting the key, and what shipped was a screen of dead controls.
**No permission is changed by this fix, and none should be** — a grant is the
owner's call, and the current grant already implements his ruling.

**Fix.** `frontend/src/mobile/MobileMyCaseDetail.tsx` — the mobile half of
`/my-cases/:id`: read-only case, items, reported issue, and the
customer/sales/nudge conversation, plus the two writes a rep has always been
entitled to (`POST /:id/sales-comment`, `POST /:id/sales-nudge`, both gated on
`requireServiceCaseAccess()`, the read-level gate). `MobileServiceCase` routes a
rep there instead of to `CaseDetail`, using the IMPORTED `isSalesNonDirector` —
no second copy of "who is a rep".

**The LIST and the create sheet stay**, exactly as on desktop where only the
detail route redirects. A rep may raise a case; taking that away is not what the
owner asked for and the standing rule is to loosen rather than restrict.

**Guards proved RED before being trusted.** `permissionDivergence.test.ts` was
EXTENDED rather than paralleled — the desktop half of this rule already lives
there — and two of its new assertions fail on the unfixed tree: `mobile does not
import isSalesNonDirector — the desktop rule has no mobile half` and the
`import { … isSalesNonDirector … } from "../auth/salesAccess"` match.
`MobileMyCaseDetail.test.tsx` renders the screen: the canonical stage word, the
conversation with auto-emitted ops events excluded, the comment post, the
rate-limited nudge RENDERING its 429, and no write control present.

**Two traps recorded, both hit while writing the guards.** A tree-wide ban on
`department_name` reported this screen as re-deriving the Sales cohort — the hit
was the PIC picker filtering to the Operation department. And the render test
advanced time by hand (`Promise.resolve()` ticks, then `setTimeout(0)`), which
left the screen on "Loading…" often enough to fail its FIRST test while the rest
passed; `findBy*` / `waitFor` poll instead. A timing assumption that is usually
right reads as a broken component.

**Ref.** `fix/mobile-sales-rep-case-rights`, 2026-08-21.
