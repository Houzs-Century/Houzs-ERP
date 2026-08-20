## Who is online, and what page they are on, was visible across companies [medium]

**Symptom.** `GET /api/presence` listed every active user in the group — name,
email, role — plus `last_path`, the page each one is currently looking at. A HOUZS
user could see 2990's staff and which document they had open.

**Root cause (traced, not guessed).** The query had no company term at all:
`WHERE last_seen_at >= ? AND status = 'active'`, nothing more. `users` is a shared
`public` table, so the absence was invisible unless you asked what bounded it.

**The part that would have defeated a naive fix.** The response is CACHED, and the
key was the literal string `"scope=all"` — ONE entry shared by every caller. Adding
a predicate to the query alone would still have served the other company's list out
of cache to whoever asked second. The key now carries the granted set, sorted so
`{1,2}` and `{2,1}` are one entry rather than two.

**Owner decision 2026-08-19:** *"同样是根据公司可以看得到的那一个东西去做"* — the
same rule as impersonation, i.e. the caller's `allowedCompanyIds`, not their active
company.

**Fix.** An `EXISTS` over `user_companies` against the caller's granted set, and the
cache key carries that set. Integers interpolated from the SESSION, never from the
request. An empty grant set matches nobody, which is correct — a caller granted no
company has no colleagues to see. `undefined` (company context unreadable) degrades
to the old behaviour rather than emptying the page.

**Deliberately NOT changed:** `GET /users` still lists the whole group, annotated
with each person's `company_ids`. That reads as intentional — it is the screen that
ASSIGNS those grants, and its write path is already constrained to what the actor
holds. Presence is different in kind: it is not "who works here", it is "what is
this person looking at right now".

**Ref.** `fix/impersonate-presence-rbac-scoped`, 2026-08-19. Found during the
cross-company isolation audit.
