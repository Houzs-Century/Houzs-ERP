## Service-token compared with `===`, and invite/reset emails interpolated names raw [medium]

<!-- area: Auth, permissions, sessions -->

**白话.** 两处安全加固，没有已观察到的事故，是查代码时发现的。(1) 后台服务口令
（DASHBOARD_API_KEY / CONNECT_SERVICE_TOKEN，权限是全星号 `*`）以前用普通的 `===`
比对，比对快慢会泄漏猜对了几个字符。(2) 邀请信 / 重置密码信里，把对方自己填的名字、
角色名直接塞进 HTML —— 有人把名字设成一段网页代码，收信人打开信就会被执行。现在
口令走定时安全比对，邮件里所有用户可控字段都做转义。

**Symptom.** None observed; found by reading the code. Two hardening gaps.

**Root cause (traced).**
1. `backend/src/middleware/auth.ts` and `backend/src/routes/auth.ts` (`GET
   /me`) authenticated the service tier with `token === c.env.DASHBOARD_API_KEY`
   / `=== c.env.CONNECT_SERVICE_TOKEN`. `===` on strings short-circuits at the
   first differing byte, so its timing leaks how many leading characters matched
   — a side channel on the full-`*` service credentials. The repo already had
   the constant-time `timingSafeEqualStr` (`backend/src/services/auth.ts`), used
   in `assrFormIntake.ts` and `scm/lib/mirror-map.ts`, but not here.
2. `backend/src/services/email.ts` — `inviteEmailHtml` interpolated
   `${p.inviterName}`, `${p.roleName}`, `${p.link}` and `resetEmailHtml`
   interpolated `${p.name}`, `${p.requestedBy}` raw into the HTML body. A user
   who sets their own display name to markup gets it rendered in the recipient's
   email (HTML injection). The same file's `escapeHtml` already wraps every
   field in the document-email path; the two account emails were the gap.

**Fix.** (1) Both service-token comparisons now use `timingSafeEqualStr(token,
key)`, keeping the existing `&&` empty/undefined-key guard so an unset key never
authenticates. (2) Every user-controlled field in the invite and reset templates
is wrapped in `escapeHtml`; the server-built link href is escaped too, matching
`documentEmailHtml`'s existing `href="${escapeHtml(...)}"` pattern. No surface
change (no new route/permission/status), so no module-guide update.

**Also in this PR — doc drift, not a code bug.** Migration 0307
(`0307_item_code_unify.sql`, 2026-08-19) renamed 18 scm columns
`material_code`/`product_code` → `item_code`, but six hand-written module guides
still showed the old names, so an engineer copying a query or index DDL from them
would hit a non-existent column. Updated the current-column references in
`docs/modules/{purchase-order,grn,delivery-order,purchase-consignment-order,document-conversion,document-traceability}.md`
to `item_code` (source of truth: `docs/generated/GLOSSARY.md`). Historical /
migration-narrative mentions and `stock-take.md` (owned by another open PR) were
left untouched.

**Ref.** fix/small-security-doc-cleanup, 2026-08-19. Found by inspection; no
observed exploit.
