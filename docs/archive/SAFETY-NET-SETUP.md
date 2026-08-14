> **ARCHIVED 2026-08-13.** Both halves exist: the staging bench (`[env.staging]` in `backend/wrangler.toml`) and the `main-protection` ruleset (**2026-07-31**). Superseded by `docs/STAGING-RELEASES.md` and `CLAUDE.md`. Kept for history; do not follow it as a current instruction.

# Safety-net setup — the staging bench + branch protection

This is the "rehearsal stage" that lets changes be tested somewhere safe before
they reach the live business. Once it exists, the big optimisations that are
currently too risky to do blind (splitting the giant files, consolidating
duplicated code, merging the audit tables) become safe: each change goes to
staging first, is verified, and only then reaches production.

## For the owner (non-technical) — what this is and why

Right now every code change auto-deploys to the live system within minutes, with
no gate and no place to try it first. That is why some improvements have been held
back: a mistake would hit real customers immediately. This document sets up two
things that together form the safety net:

1. **Branch protection** — a gate so nothing reaches production without passing
   its automatic checks first.
2. **A separate staging file store** — so testing on the staging copy can never
   touch real customer documents.

**Important:** both require **admin/owner access** that the day-to-day account
(`weisiang329-eng`) does NOT have (`permissions.admin = false`). They must be done
by whoever owns the **`hello-houzs` GitHub organisation** and the **Cloudflare
account that holds the `houzs-erp` bucket** — likely the same person who manages
the infrastructure. Forward this file to them; each part is a few minutes.

---

## Part 1 — Branch protection (GitHub org owner/admin)

Puts a required-checks gate in front of `main`, so a broken or unreviewed change
can't auto-deploy to production. ~5 minutes.

1. GitHub → the `hello-houzs/Houzs-ERP` repo → **Settings** → **Branches**.
2. **Add branch ruleset** (or "Add rule") for the branch **`main`**.
3. Enable **Require status checks to pass before merging**, and turn on
   **Require branches to be up to date before merging**.
4. In the status-checks search box, add exactly these two contexts:
   - `backend-typecheck`
   - `frontend`
5. **Do NOT** enable "Require pull request approvals" — it would block the
   automated merges this project relies on.
6. **Do NOT** enable "Include administrators" — keep an emergency escape hatch.
7. Save.

(These exact settings are also recorded in `CLAUDE.md`. Avoid `backend-tests (N)`
as a required context — its name carries a shard index that changes.)

## Part 2 — Separate staging R2 bucket (Cloudflare account owner)

Today staging's file store points at the **production** bucket `houzs-erp`, so a
staging test can overwrite or delete real customer PODs / payment slips / photos —
and that bucket has no versioning, so the loss is permanent. Give staging its own
bucket. ~10 minutes.

1. Cloudflare dashboard (the account that holds `houzs-erp`) → **R2** →
   **Create bucket** → name it **`houzs-erp-staging`**.
2. In the repo, `backend/wrangler.toml`, under `[env.staging]`, change every
   staging R2 binding's `bucket_name` from `"houzs-erp"` to `"houzs-erp-staging"`
   (there are four `[[env.staging.r2_buckets]]` blocks; only the staging ones —
   leave the production bindings untouched). This is a one-line-each edit; an AI
   session can prepare the PR, but it must only be merged AFTER the bucket exists,
   or staging deploys fail with "bucket not found".
3. While in Cloudflare R2, also enable **Object versioning** on the **production**
   `houzs-erp` bucket — that closes the "files have zero recovery" gap
   (`THREAT-MODEL.md`), independent of staging.

---

## What this unlocks (why it's worth the few minutes)

With the bench in place, the deferred work in `FRAGMENTATION-MAP.md` and
`SECURITY-DX-ROADMAP.md` becomes safe to do:

- Split the giant files (`Projects.tsx`, `mfg-sales-orders.ts`) — verify on staging,
  then production.
- Consolidate the ~20 money-format copies, the state lists, the currency lists.
- Merge the three audit tables (needs a DB migration — do it on staging first,
  with a backup).

Until then, only the low-risk, fully-verifiable changes should ship — which is
exactly the line held so far.

## Quick status (as of 2026-07-31)

- Branch protection on `main`: **DONE 2026-07-31.** The owner created the
  `main-protection` **ruleset**: `deletion`, `non_fast_forward`, and
  `required_status_checks` with contexts `backend-typecheck` + `frontend` and
  `strict_required_status_checks_policy: true` (*Require branches to be up to
  date before merging*), Repository admin on the bypass list.
  **Verify with `gh api repos/hello-houzs/Houzs-ERP/rules/branches/main`, NOT
  with `/branches/main/protection`** — that endpoint reports only CLASSIC
  protection, so it still answers 404 and reads as "unprotected" when it is not.
  Part 1 below is kept for the record of what was asked for and why.
- Staging R2: **shares the production bucket** `houzs-erp` (all four staging
  bindings). Needs the split above.
- Production R2 versioning: **off** — enable it (Part 2, step 3).
