## Zero-grant multi-company user was handed EVERY company — fail-open tenant default flipped to fail-closed [medium]

<!-- area: Auth, permissions, sessions -->

**白话.** 多公司启用后，如果有一个用户在权限表 (`user_companies`) 里一间公司都没有
被授权，系统本来是「保险起见给他看全部公司」—— 反而是最不安全的做法：一个没被授权
任何公司的人，看到了两间公司的全部资料。现在改成「没授权就什么都看不到」(fail-closed)。
今天是安全的：查过生产资料，**0 个零授权用户**，没有人会因此被锁在外面；这只是为将来
补上的安全默认值。

**Symptom.** In `backend/src/middleware/companyContext.ts`, when multi-company is
active (`companies.length > 1`), a resolved user with ZERO `user_companies` grant
rows had `allowedCompanyIds` default to EVERY active company (`companies.map(co =>
co.id)`). The narrowing to the user's grants ran only inside `if (granted.length >
0)`, so a zero-grant user fell through with the full company list — the least-safe
outcome for the least-privileged account. The SCM client is service-role (RLS
bypassed), so that app-layer list IS the tenant boundary.

**Root cause (traced).** The Phase-0e default was fail-OPEN by construction: `let
allowed = companies.map(...)` then narrow only when `granted.length > 0`. The
branch for a *confirmed-empty* grant read was never written, so "user has no
grants" and "grant table absent / DB blip" collapsed into the same all-companies
fallback. Under RLS (`docs/TENANT-ISOLATION-ROOT-FIX.md`), `app.company_id` must be
a single value; a user granted "all" has none — so the fail-open default also
blocked the root fix.

**Fix.** Add the missing `else`: a resolved multi-company user whose grant read
succeeds and returns ZERO rows now gets `allowed = []` — the RESTRICTED-TO-NOTHING
sentinel the scoping helpers already honour (`isRestrictedToNoCompany`, the `1=0` /
empty-`.in` MATCH_NOTHING paths in `backend/src/scm/lib/companyScope.ts`), so a
zero-grant user sees no company rather than all. Every other branch is preserved
exactly: a grant-read error / absent table still throws to the `catch` and keeps
the ALL-companies default (a transient blip must not lock everyone out), an
unresolvable uid skips the block, single-company / pre-activation never narrows,
and the cold-start branch (companies master unreadable) is untouched. Owner
decision, `docs/TENANT-ISOLATION-ROOT-FIX.md` §6.1. **Safe today because a live
audit found 0 users with zero grants** — nobody is locked out; this is a safety
default for the future. Pinned by `backend/tests/companyContextZeroGrantFailClosed.test.ts`
(zero-grant → `[]`; one grant → that company; single-company unchanged;
cold-start unchanged) and the updated last-known-good case in
`backend/tests/companyScopeFailClosed.test.ts`.

**Ref:** #<PR>. `fix/zero-grant-fail-closed` 2026-08-20.
