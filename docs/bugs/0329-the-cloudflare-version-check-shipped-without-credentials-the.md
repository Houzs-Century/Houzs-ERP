## The Cloudflare version check shipped without credentials — the secrets are environment-scoped, not repo-scoped [low]

**Symptom.** `Worker version check (read-only)` failed on its very first
dispatch (run `32095704847`):

```
env:
  CLOUDFLARE_API_TOKEN:
  CLOUDFLARE_ACCOUNT_ID:
##[error]check-worker-versions: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required. Nothing was checked.
```

**Root cause (traced).** There are **no `CLOUDFLARE_*` secrets at repo level** —
`gh api repos/hello-houzs/Houzs-ERP/actions/secrets` lists none. They live in the
`Production` GitHub ENVIRONMENT. `deploy.yml`'s backend job can read them only
because it declares `environment: Production` (`deploy.yml:134`); the new
workflow did not, so `${{ secrets.CLOUDFLARE_API_TOKEN }}` resolved to the empty
string.

**A missing environment scope is silent.** GitHub does not error on a secret the
job cannot see — it substitutes empty. Had the script treated "no credentials" as
"nothing to report", this would have been a permanently green check that never
called Cloudflare once, which is the `staging-bench-rot-coe.md` shape. It refuses
instead (`Nothing was checked`, exit 1), so the gap surfaced on the first run
rather than in three weeks.

**Fix.** `environment: Production` on the job. That environment carries no
protection rules today (no reviewers, no wait timer, no branch policy — `gh api
repos/.../environments/Production`), so it adds no approval step. Accepted
cosmetic cost: jobs naming an environment appear in that environment's deployment
list, so a read-only diagnostic now sits beside real releases. It deploys nothing
and keeps its own concurrency group, so it still cannot queue behind or displace
a release.

**This is the rule working, not failing.** CLAUDE.md: *a `workflow_dispatch`
workflow is not shipped until it has been dispatched once and reported success.*
#2120 was the entry that bought that rule, by shipping a workflow wired to
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — secrets that exist nowhere here.
Same class, caught in minutes this time because the check was dispatched
immediately instead of being assumed good.

**Ref.** `docs/deploy-secret-version-deadlock-coe.md`, 2026-08-18.
