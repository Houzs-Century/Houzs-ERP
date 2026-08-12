# Security & Dev-Velocity — Status and Roadmap (2026-07-23)

The single place that says: what was done today, what was deliberately NOT done and
why, and what's next with WHO owns each. Written for a non-technical owner first,
with the technical detail linked. Companion to `SECURITY-AUDIT-2026-07-23.md`,
`THREAT-MODEL.md`, `ACCOUNT-SECURITY-SETUP.md`, and `AI-DEV-VELOCITY.md`.

## The honest one-paragraph summary

A full security audit ran and its fixes shipped: 9 security fixes plus 3 dev-speed/
docs changes, all merged to `main` on 2026-07-23. The known code holes are closed
and defensive protections are live and automatic — nobody has to "use" them. The
database can now be restored to the second (PITR, enabled by the owner). What is
NOT done is everything that only the owner's accounts can change (MFA, R2 file
versioning, branch protection), plus a few things that should not be done without a
safety net (splitting the giant files, a persistent access-audit that needs a live
DB migration). Security is ongoing, not a finish line. This is much safer than the
morning of 2026-07-23 — not "perfect".

## What shipped today (12 PRs, all merged)

Security (audit findings): security headers (#1075), stored-XSS via attachments +
photos (#1076, #1080), cross-company/cross-user access on service cases (#1079),
destructive-script guards + `db:reset` lock (#1081), constant-time secret compare +
SHA-pinned deploy actions (#1084), report-only CSP (#1087), multi-company fail-open
diagnostic (#1089), CORS allow-list (#1090). Dev-speed + docs: route-locator index
(#1106), the velocity plan (#1104), threat model + account-setup guide (#1093).

These are automatic. No one operates them; they protect the system in the
background, and daily ERP use is unchanged.

## Deliberately NOT done (with the reason — not oversights)

- **Splitting the giant files** (`Projects.tsx` 12.8k lines, `mfg-sales-orders.ts`
  10.8k). Real surgery on the live order engine; unsafe to do blind. The
  route-locator (#1106) already captured most of the navigation win. Do it only
  once a staging safety net exists — see Next Steps #2/#4.
- **Persistent access-audit** ("who downloaded which payment slip"). Change-auditing
  already exists (`entity_audit_log`) and request-level access logging exists
  (`requestLog`). A persistent, queryable read-audit needs a new DB migration that
  auto-applies to production — not something to run unsupervised on a database that
  has been wiped before. Design it with the owner.
- **CSP enforce**, **multi-company fail-closed flip**, **seat-height cost strip**
  (`mfg-products`). Each is a follow-up that needs an observation window, a live
  count, or an owner ruling — documented in `BUG-HISTORY.md` and the audit.

## Next steps — ranked, with OWNER

| # | Step | Who | Cost | Note |
|---|---|---|---|---|
| 0 | **MFA on Supabase (then GitHub, Cloudflare)** | Owner | free | Highest value. Stops stolen-password logins. Phone, ~3 min. Supabase first. |
| 0 | **R2 object versioning** on `houzs-erp` bucket | Owner (the Cloudflare acct holding the bucket) | ~free | Files have zero recovery today. |
| 0 | **Branch protection on `main`** | Owner (GitHub org admin) | free | Puts a gate before prod deploys. |
| 1 | **Professional penetration test** | Hire a firm | paid | The gold standard for a system with customer + payment data. An AI scan does not replace it. |
| 2 | **Revive the staging safety net** | **Owner first** (token), then AI | small | Staging exists and is STALE — see below. The owner must replace the Staging `CLOUDFLARE_API_TOKEN` before any of this is workable. Then: split its R2 bucket off prod (audit M4) and start testing there before prod. Unlocks safe splitting. |
| 3 | **Persistent access-audit** (sensitive downloads/exports) | AI + owner (migration review) | medium | Design first; needs a prod migration, so do it supervised. |
| 4 | **Split the giant files** | AI, once #2 exists | medium | Do it behind the staging net, one file per PR, tested before prod. |
| 5 | **Restore drill** — actually restore a PITR snapshot into staging | Owner | small | An untested backup is a guess. Prove it works once. |
| 6 | **Install `gbrain`** semantic index in the real working repo | Owner + AI | small | The full RAG index on top of the route-locator. See AI-DEV-VELOCITY.md. |

## The one structural thing that unlocks the rest

Most of the remaining optimisation (splitting files, bigger refactors, the audit
log) is currently unsafe to do because there is **no gate and no test bench**
between a change and the live business. **Half of that closed on 2026-07-31**:
`main` now carries the `main-protection` ruleset, so a PR whose CI ran against a
stale `main` can no longer merge (verify with
`gh api repos/hello-houzs/Houzs-ERP/rules/branches/main`; the classic
`/branches/main/protection` endpoint still answers 404 and will mislead you).
What is still missing is the other half — every merge still auto-deploys straight
to production with no staging bench in between. Step 2 is now the whole of this
foundation, and it is what to build before the rest.

### The staging bench is not merely unfinished — it is stale, and it looks fine (2026-08-12)

Correcting what this document implied above. "Staging exists" was read for weeks
as "staging is available"; it is not.

| | |
|---|---|
| Is it running? | Yes. Worker and Pages both answer 200, all bindings intact |
| When was it last built from `main`? | **2026-07-29 16:20 UTC** |
| How far behind is that? | **775 commits, 59 production migrations** as of 2026-08-12 |
| Why did it stop? | The Staging `CLOUDFLARE_API_TOKEN` **worked for four weeks and then died on 2026-07-30** — revoked or expired on Cloudflare's side, while the GitHub secret sat untouched (`updated_at` is still 2026-07-01). Every run since has failed. On 2026-07-31 the `main` trigger was removed, correctly, so the permanent red would stop training people to ignore red. An earlier note claimed the token had never worked; the run history refutes that — see `docs/staging-bench-rot-coe.md` |
| Why did nobody notice? | The nightly **Staging E2E** kept passing — honestly, about a two-week-old build. Staging carried no `GIT_SHA` stamp, so `/health` answered `sha:null` and the staleness was invisible from outside |

Re-dispatched from `main` on 2026-08-12 (run 31566944717) to test whether the
token had since been fixed. Everything up to the deploy passed — the audits,
typecheck, the full backend suite, and the migration step, which applied **50
pending migrations to the staging database, 0 failed**. Both deploy steps then
failed. **The token is still bad**, and staging is now running a current schema
under 2026-07-29 code until it can be deployed.

**The single blocking action, and only the owner can take it: mint a NEW
Cloudflare API token.** The run log gives `Invalid access token [code: 9109]`
alongside the `10000` — `9109` means the credential is not a valid token at all,
so *editing the existing token's permissions will not fix it*. Create a fresh
one, scoped like the working Production token (Account → Cloudflare Pages:Edit,
Workers Scripts:Edit), and set it in the GitHub **Staging** environment secrets
— directly in GitHub, never pasted into a chat. Then `workflow_dispatch` proves
it, and only then does `main` go back into the `deploy-staging.yml` trigger list.

Until that happens, treat every item below as blocked, not merely unstarted:
splitting the giant files (#4), the PITR restore drill (#5), and the deferred
FIFO ledger fix in `docs/inventory-ledger-divergence-coe.md`, which is
explicitly staging-first. The full write-up is `docs/staging-bench-rot-coe.md`.

## What "done" means here

Today's work is done and shipped. The list above is not a backlog of failures — it
is the honest map of a security posture that is now good and can keep improving.
Nobody's system is ever "finished"; the goal is to always know where the open doors
are and who is closing the next one.
