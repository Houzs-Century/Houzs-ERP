# Tenant isolation — the root fix

Owner decision 2026-08-19: *"我们能的话 肯定是治根吧？"* — treat the root, not the
symptoms. This document is the plan, and the reasoning that has to survive the
session that wrote it.

---

## 1. What the root cause actually is

**The tenant boundary exists only as a predicate that a human must remember to
write, once per SQL statement, across ~1000 route handlers.**

That is not a bug list. It is the architecture. Everything else follows from it:

- On 2026-08-19 two separate PRs (#2392 and #2439) independently fixed the *same*
  GL-view leak, and two more independently fixed the same delivery-crew write.
  Duplicated effort is the symptom of a rule that lives in people's heads.
- `scripts/check-company-scope.mjs` reported **zero** while fifteen leaks existed,
  because a checker over regexes cannot see every shape. When it was taught to
  read raw `c.env.DB.prepare` writes, the count went zero → 47.
- `backend/scripts/probe-natural-key-reads.mjs` reports ~279 route READ statements
  keyed on a human-meaningful key, ~200 of them with no company term. That number
  is an upper bound on exposure, not a defect count — but it is the size of the
  surface a human is expected to never once forget.

Fixing them one at a time cannot converge: the population grows with every new
handler, and the gate that is supposed to catch regressions is itself a regex.

---

## 2. What makes the root fix POSSIBLE here (checked 2026-08-19, not assumed)

Three facts, each verified against the tree rather than recalled:

1. **There is one database, not two.** `wrangler.toml` has no `d1_databases`
   binding — the comment says *"There is no env.DB binding in prod anymore"* —
   and `src/index.ts:214` swaps `env.DB` for a Postgres-backed shim over
   Hyperdrive on every request. So the PostgREST path (`sb`) and the raw-SQL path
   (`env.DB`) both land on the same Supabase Postgres. **One policy set can cover
   both.**

2. **RLS is already enabled and completely inert.** Mig 0061 turned RLS on for
   119 `scm` tables and wrote no real policies (only 14 `USING (true)` no-ops in
   the consignment modules). The scaffolding exists; nothing is standing on it.

3. **The reason it is inert is the connection identity, and that is fixable.**
   `src/db/supabase.ts:getSupabaseService` builds the client with
   `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS by design. The Hyperdrive path
   connects as the table owner, and **an owner bypasses RLS unless the table
   carries `FORCE ROW LEVEL SECURITY`.**

`FORCE ROW LEVEL SECURITY` is the hinge. It makes even the owner subject to
policy, which means **both** connection paths can be brought under RLS without
re-plumbing authentication or minting per-request JWTs.

---

## 3. How large ERPs solve this class

| | approach | who |
| --- | --- | --- |
| **A** | **Database-enforced row security.** Tenant lives in a session variable; policies live in the database. Forgetting a predicate becomes impossible rather than merely discouraged. | Supabase's own model; most modern multi-tenant SaaS |
| **B** | **Mandatory ORM layer.** No code touches a raw client; every query goes through a layer that injects the rule. | **Odoo** — `ir.rule` record rules are applied by the ORM, never by the developer |
| **C** | **Schema or database per tenant.** | SAP, classic NetSuite. Strongest, heaviest, and wrong for a two-company group that shares masters |

We are choosing **A**, because the database is already one, RLS is already
enabled, and `FORCE` removes the only blocker. **B** stays available as a
belt-and-braces layer and is what the existing `scopeToCompany` helpers already
approximate.

---

## 4. The plan, staged so that no stage can take production down

Each phase is independently shippable and independently revertible. **No phase
changes what any query returns until Phase 3**, and Phase 3 is per-table.

### Phase 0 — plumbing only. Zero behaviour change.

Set the caller's company on the connection, per request, on both paths:

- Hyperdrive/`postgres`: `SET LOCAL app.company_id = $1` at the head of each
  transaction, from `companyContext`'s resolved company.
- PostgREST: the same value as a request header the policies can read.

With no policies referencing `app.company_id`, this is inert. Ship it, watch it,
confirm the setting is present on live requests before going further.

**Exit criterion:** a read-only check (the `tenant-isolation-check` workflow
shape) shows `current_setting('app.company_id', true)` populated on real traffic.

### Phase 1 — write the policies, do NOT force them. Zero behaviour change.

For every `scm` table carrying `company_id`, one mechanically identical policy:

```sql
CREATE POLICY tenant_isolation ON scm.<table>
  USING (company_id = current_setting('app.company_id', true)::bigint);
```

Deliberately-shared tables get an explicit `USING (true)` policy **with a comment
naming the owner decision that made them shared** — the mig 0089 TEXT-PK masters,
and the TMS/fleet tables per the owner's 2026-07-14 ruling. Shared becomes a
decision recorded in one place instead of an absence scattered across handlers.

Because nothing is `FORCE`d yet and both paths bypass, **these policies do not
execute.** They are inert text until Phase 3.

**Exit criterion:** a real-Postgres test (the existing `backend-postgres` CI job)
that creates two companies, applies the policies, and proves each one filters —
run against a role that RLS *does* apply to, so the test is not vacuous.

### Phase 2 — prove it on ONE low-traffic table.

`ALTER TABLE scm.<table> FORCE ROW LEVEL SECURITY;` on a single table nobody
depends on for a critical path. Watch. Roll back with `NO FORCE` in one statement
if anything reads empty.

**This is the phase that finds the surprises**, and it must be given real time.

### Phase 3 — roll forward, table group by table group.

Ordered least-critical first; money and stock last. Each group is one migration,
each has a one-statement rollback, and each is verified against live reads before
the next.

### Phase 4 — the app-layer predicate becomes belt-and-braces.

`scopeToCompany` and friends stay — defence in depth, and they produce better
error messages than an empty result set. But they stop being *the* boundary, and
`check-company-scope.mjs` demotes from a security control to a lint.

---

## 5. What this does NOT solve, stated plainly

- **`FORCE` applies to the table owner too, including migrations and repair
  scripts.** Every `backend/scripts/*` that writes will need to set
  `app.company_id` or run as a role with `BYPASSRLS`. That is a real inventory of
  work and it is easy to discover late, at 2am, when a repair script silently
  writes zero rows.
- **A policy cannot express "this document is yours".** Cross-document rules
  (a DO's SO must be in the same company) stay in application code.
- **Capability tokens are outside this entirely.** `routes/supplierPortal.ts`
  scopes by a bearer token that resolves to one case — a *stronger* boundary than
  a company predicate, and RLS must not be allowed to break it.
- **It is not free.** This is the largest change in the system's history. Weeks,
  not days, and Phase 2 deserves to be slow.

---

## 6. Open owner decisions that block or shape this

| | question | why it matters here |
| --- | --- | --- |
| 1 | **Zero-grant users**: `companyContext.ts` hands a user with no `user_companies` row EVERY company, deliberately. Flip to fail-closed? | Under RLS, `app.company_id` must be a single value. A user granted "all" has no single value to set. Run the `Tenant isolation check (read-only)` workflow — it prints the count and the verdict. |
| 2 | ~~Cross-company impersonation~~ — **DECIDED 2026-08-19.** | **Do it through RBAC, using the grants the Team screen already edits.** The owner's words: *"我们的 team 那边是有得选这一个人是负责什么公司的… 如果他只是在同一间公司，肯定就是限制；如果他是两间公司…他是没有限制。以 RBAC 这样子去做限制的"*. So the predicate is `allowedCompanyIds` (the ACTOR's granted set), not the active company: an actor granted one company may only impersonate inside it; an actor granted both may impersonate across both, because switching organisation is a thing they are already entitled to do. That is the identical rule `PUT /users/:id/companies` already enforces — *a grantor can only ever pass on what they hold*. Applies to `POST /:id/impersonate`, `POST /:id/reset-password` and `POST /:id/totp/disable`. |
| 3 | ~~Presence~~ — **DECIDED 2026-08-19.** | Same rule: *"同样是根据公司可以看得到的那一个东西去做"* — scope `/api/presence` to `allowedCompanyIds`, not to the active company. **The cache key must carry that set**; today it is the literal string `scope=all`, one entry shared by every caller, so scoping the query alone would still serve one company's list to the other. |
| 4 | **Shared tables**: which tables are genuinely group-wide? | Phase 1 needs this list explicitly. Current sources: `docs/MULTICOMPANY-SCALING.md`, mig 0089, and the TMS ruling. |

---

## 7. Where the evidence for all of this lives

- `BUG-HISTORY.md`, 2026-08-18/19 — the GL views, the six SO child reads, the
  invoice-line write, and the round-2 sweep.
- `backend/scripts/probe-natural-key-reads.mjs` — the size of the unguarded read
  surface, with its own header explaining why the number is an upper bound.
- `backend/scripts/check-tenant-isolation.mjs` + `.github/workflows/tenant-isolation-check.yml`
  — the four production questions the repository cannot answer, including the
  zero-grant count that decides §6.1.
- `docs/MULTICOMPANY-SCALING.md` — which tables are shared, and the correction
  that the chart of accounts is per-company.
