## Taking over another company's account was one permission check away [high]

**Symptom.** An admin holding `users.manage` could `POST /api/users/:id/impersonate`
against a user of the OTHER company. Impersonation issues that user's session, so
from that moment the actor IS them — the other company's books, fully open. The
same by-id-only shape sat on `POST /:id/reset-password` and
`POST /:id/totp/disable`.

**Root cause (traced, not guessed).** All three resolved the target with
`.where(eq(users.id, id))` and nothing else. `users.manage` is a flat permission
string with no company dimension, so holding it anywhere held it everywhere.

**The asymmetry that made it a defect rather than a design.** `PUT /:id/companies`
in the SAME file already constrains the write to `allowedCompanyIds`, with the
comment *"A grantor can only ever pass on what they hold"*. Taking over an account
HANDS the actor that account's reach, which is the same act by another route, and
it was ungated.

**Owner decision 2026-08-19, and it is RBAC, not the switcher.** *"我们的 team 那
边是有得选这一个人是负责什么公司的… 如果他只是在同一间公司，肯定就是限制；如果他是
两间公司…他是没有限制。以 RBAC 这样子去做限制的"* — so the predicate is the ACTOR's
granted set, never the ACTIVE company. Gating on the switcher would break a
two-company admin doing something they are already entitled to do.

**Fix.** `targetWithinActorCompanies(c, targetUserId)` — the target's companies
must be a SUBSET of the actor's. Holding {1} and taking over someone in {1,2}
would be a promotion, so it refuses with 403 `not_in_your_companies`.

Two edges are deliberate. `allowedCompanyIds` returning `undefined` means the
company context could not be READ (pre-migration, cold start) and falls through —
refusing there would lock every admin out of a routine action. A target with NO
grants REFUSES, because `companyContext` currently hands such a user every active
company, which makes taking them over the widest reach available rather than the
safest.

**Also found:** `/:id/impersonate` is registered TWICE (the second is dead — Hono
keeps the first, and the file's own comment at that line says so). The gate went
on the live one; the dead registration is left for a separate cleanup rather than
removed in a security fix.

**Ref.** `fix/impersonate-presence-rbac-scoped`, 2026-08-19. Found during the
cross-company isolation audit.
