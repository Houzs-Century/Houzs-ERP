# Staging refresh published the production database as a public download — COE (Correction of Error)

**Date:** 2026-11-09 (found 17:39Z; evidence re-run 17:45Z).
**Trigger:** found by the money-in-logs sweep, not by staff. While checking what this
PUBLIC repository's Actions runs expose, the coordinator saw that every run of
*Staging Refresh Data (prod -> staging, masked)* left an artifact called `prod-data`
of about 235 MB.
**Status:** the leak path is closed in this PR, and a CI check now refuses any
workflow that uploads a dump, backup or export without encrypting it. The 28
copies already uploaded (5 `prod-data` + 23 backups) were DELETED on the owner's
instruction on 2026-11-10 (see section 5).

## 1. What happened, in plain words

To give staging real-looking data, the refresh copies production into staging and
then hides customer phone numbers and emails **on staging**. The copy travelled
from one step to the next as a workflow "artifact" (a file attached to the run).
Because this repository is public, anyone can see that file exists, and anyone with
a free GitHub account can download it. The file was the copy **before** the hiding
step: real customer names, phones, emails, addresses, every price and amount, and
staff password hashes (scrambled passwords; hard to reverse, not impossible).

- 15 runs since the workflow was added on 2026-09-11 (#3701). **Every one** of them
  uploaded the file (the dump job succeeded in all 15). PROVEN:
  `gh run list --workflow=staging-refresh-data.yml` + each run's `/jobs`.
- 10 of those copies have expired (the file lived 1 day). **5 are still downloadable**
  at the time of writing, each about 247 MB, expiring 2026-11-10 between 02:05Z and
  06:29Z. PROVEN: `gh api "repos/Houzs-Century/Houzs-ERP/actions/artifacts?name=prod-data"`.

| artifact id | run | created | expires |
| --- | --- | --- | --- |
| 13644656767 | 42548672762 | 2026-11-09 02:05Z | 2026-11-10 02:05Z |
| 13644938874 | 42550241459 | 2026-11-09 02:22Z | 2026-11-10 02:22Z |
| 13646490036 | 42552280666 | 2026-11-09 02:44Z | 2026-11-10 02:44Z |
| 13652593869 | 42570685989 | 2026-11-09 06:05Z | 2026-11-10 06:05Z |
| 13653638204 | 42572940359 | 2026-11-09 06:29Z | 2026-11-10 06:29Z |

- Whether anyone outside the company downloaded any of the 15: **UNKNOWN.** GitHub
  does not give a repository owner a download log for artifacts.

The same sweep found **23 more** readable backups from other one-off workflows, kept
for 90 days, still downloadable (rows deleted or changed by those jobs — purchase
orders, goods receipts, stock balances, the HC go-live wipe). PROVEN by the same
artifacts listing, filtered by name:

| artifact id | name | bytes | created | expires |
| --- | --- | --- | --- | --- |
| 10599008969 | migrated-grns-before-prod | 125011 | 2026-09-20 | 2026-12-19 |
| 10598536012 | migrated-grns-before-prod | 125009 | 2026-09-20 | 2026-12-19 |
| 10598405314 | migrated-grns-before-prod | 125010 | 2026-09-20 | 2026-12-19 |
| 10085753733 | reseed-pre-balance-plan-34303397518 | 16557 | 2026-09-09 | 2026-12-08 |
| 10085203078 | migrated-grns-before-prod | 121061 | 2026-09-09 | 2026-12-08 |
| 10085155929 | migrated-grns-before-prod | 121061 | 2026-09-09 | 2026-12-08 |
| 10037162953 | migrated-grns-before-prod | 74055 | 2026-09-08 | 2026-12-07 |
| 10036435173 | migrated-grns-before-prod | 74053 | 2026-09-08 | 2026-12-07 |
| 10033966507 | migrated-grns-before-prod | 73858 | 2026-09-07 | 2026-12-06 |
| 10027297658 | migrated-grns-before-prod | 73773 | 2026-09-07 | 2026-12-06 |
| 10027196812 | migrated-grns-before-prod | 73773 | 2026-09-07 | 2026-12-06 |
| 10025764081 | reseed-pre-balance-apply-34140557010 | 13823 | 2026-09-07 | 2026-12-06 |
| 10025654740 | reseed-pre-balance-plan-34140365685 | 13822 | 2026-09-07 | 2026-12-06 |
| 10024837403 | so-po-dedication-dump-apply | 5404 | 2026-09-07 | 2026-12-06 |
| 10024730756 | so-po-dedication-dump-plan | 5399 | 2026-09-07 | 2026-12-06 |
| 10019736439 | po-dump-HC-PO-009944 | 2583 | 2026-09-07 | 2026-12-06 |
| 10019691086 | po-dump-HC-PO-009944 | 2583 | 2026-09-07 | 2026-12-06 |
| 9743591041 | hc-test-docs-backup-33350967337-1 | 2621 | 2026-08-31 | 2026-11-29 |
| 9742900225 | hc-test-docs-backup-33348811613-1 | 10231 | 2026-08-31 | 2026-11-29 |
| 9674943136 | golive-hc-backup-33143464728-1 | 27840 | 2026-08-28 | 2026-11-26 |
| 9518101106 | golive-hc-backup-32721634086-1 | 32769 | 2026-08-24 | 2026-11-22 |
| 9437388812 | golive-hc-backup | 11546 | 2026-08-21 | 2026-11-19 |
| 9402572761 | golive-hc-backup | 489434 | 2026-08-20 | 2026-11-18 |

## 2. Root cause (traced with the files and the GitHub API, not guessed)

1. **The repository is public.** `gh api repos/Houzs-Century/Houzs-ERP` →
   `"visibility":"public"`. For a public repository, artifacts are listed to anyone
   and downloadable by any signed-in GitHub user. This is GitHub's design.
2. **The workflow uploaded the unmasked dump.** On `main` before this PR,
   `.github/workflows/staging-refresh-data.yml` line 90 wrote `prod-data.sql` with
   `pg_dump`, line 93 gzipped it, and lines 114–120 uploaded `prod-data.sql.gz` with
   `actions/upload-artifact@v4`, `retention-days: 1`. The masking ("Mask customer
   phone / email", line 315) and credential scrub (line 368) ran later, in the
   restore job, on the staging database — never on the file.
3. **Why it was built that way.** The file header said the two jobs kept the two
   database passwords apart ("Neither job holds both secrets"). That was not true:
   `gh secret list` shows `DATABASE_URL` is a **repository** secret, so the restore
   job (Staging environment) could always read it too. The split bought no
   isolation and cost a public copy of production.
4. **The deeper habit.** Several workflows moved sensitive output from the log into
   an artifact *because logs are public* (`merge-truncated-ac-codes.yml` header: costs
   "stay in the artifact because this repository's logs are public"). An artifact of
   a public repository is as public as its log. Nothing checked for it.

## 3. Fixes shipped (this PR)

| change | effect |
| --- | --- |
| `staging-refresh-data.yml`: one job instead of two; the dump is taken and loaded on the same runner, no artifact; a final `if: always()` step deletes the files | the unmasked copy never leaves the runner. Same secrets are visible as before (`DATABASE_URL` was already readable from Staging); only the dump / switches-capture steps name it, both read-only |
| `.github/actions/seal-artifact` (new): `mode: check` validates the requester's RSA public key before any database is touched; `mode: seal` tars, encrypts (AES-256 + RSA-OAEP, the scheme `local-dev-snapshot.yml` already used) and deletes the plaintext | only the person who dispatched the run can open the file |
| `golive-wipe-hc`, `delete-hc-test-docs`, `dump-and-delete-po`, `reshape-migrated-grns`, `revert-so-po-dedications`, `reseed-stock-from-ac-snapshot`, `merge-truncated-ac-codes`, `export-century-so-lines`, `align-export-company`: new required input `recipient_pubkey`, key checked first, rows sealed, only `sealed/` uploaded | 13 upload steps no longer publish rows. Backups keep 7 days (they are the only copy of deleted rows, and they are ciphertext); read-only exports keep 1 day |
| `local-dev-snapshot.yml`: `restore-errors.log` now encrypted under the same key; `extensions.txt` / `row-counts.txt` no longer uploaded (already in the log and summary) | pg_restore errors can quote a value from the unmasked dump |
| `dump-scm-schema.yml`: visible `# dump-artifact-ok:` marker with its reason | schema only, no rows, meant to be committed to the repo |
| `scripts/check-workflow-dump-artifacts.mjs` + its test, run in the required `backend-typecheck` job | CI fails if any workflow uploads an artifact whose name or path looks like a dump / backup / export (`.sql`, `.dump`, `.csv`, `backup`, `dump`, `export`, `snapshot`) without an encryption step earlier in the same job, or uploads plaintext beside the ciphertext. 11 built-in probes; it refuses to report if one fails or if it finds no upload step at all |

Proof the check catches the original: run against `main`'s versions it reports
`staging-refresh-data` (1), `golive-wipe-hc` (1), `delete-hc-test-docs` (1),
`dump-and-delete-po` (2), `reshape-migrated-grns` (2), `revert-so-po-dedications` (2),
`local-dev-snapshot` (1); against this branch it reports 0 over 316 workflows /
45 upload steps. PROVEN, `node scripts/check-workflow-dump-artifacts.mjs` and
`scanWorkflow()` over `git show origin/main:<file>`.

## 4. What was ruled out

- **"Merging the two jobs gives one job both passwords."** Refuted: it already had
  them. `DATABASE_URL` is repository-level (`gh secret list`); the Staging
  environment holds only `STAGING_DATABASE_URL` + Cloudflare secrets, Production only
  Cloudflare secrets + `VITE_API_URL` (`gh secret list --env ...`). Neither
  environment has protection rules or reviewers (`gh api .../environments/<name>`),
  so no approval gate was lost by dropping `environment: Production`.
- **"Encrypt with a shared secret instead."** Rejected: no secret both jobs could
  read exists, adding one needs the owner, and the refresh would stop until then.
  One job needs nothing new.
- **"The 1-day retention made it safe."** It shortened each window; it did not close
  it. Fifteen windows of up to a day each.
- **The probe/report artifacts** (`probe-*.txt`, plan `.json` files, about 2,350
  live artifacts in all) were NOT treated as dumps by this PR: they are summaries,
  not table copies. Some may still print money; that is the money-in-logs sweep's
  scope, not this check's (Deferred).

## 5. Deferred — owner decisions

1. **DONE 2026-11-10 (owner: "马上删掉").** The 5 `prod-data` artifacts were deleted
   with `DELETE /repos/Houzs-Century/Houzs-ERP/actions/artifacts/{id}`; each id then
   answered 404, and `GET .../actions/artifacts?name=prod-data` returned 0.
2. **DONE 2026-11-10 (owner: "一起删掉").** The 23 backup artifacts were deleted the
   same way after matching each by name (10 `migrated-grns-before-prod`, 4
   `golive-hc-backup*`, 3 `reseed-pre-balance-*`, 2 `so-po-dedication-dump-*`, 2
   `po-dump-HC-PO-*`, 2 `hc-test-docs-backup-*`); all 23 then answered 404.
   STILL PRESENT and not ruled on: about 30 smaller tool-output artifacts (repair
   plans, AutoCount party-code census, supplier binding proposals, sofa worklists)
   that LIKELY carry business rows but no password hashes.
3. **Staff password resets.** Password hashes were in every copy. A reset for staff
   (at least admins and anyone with finance access) closes the risk that a hash is
   cracked. Owner.
4. **Delete the ~695 old run logs that print money** — the list is held by the
   coordinator of the money-in-logs sweep (695 rows: run id, workflow, line, script).
   Owner.
5. **Make the repository private.** This incident, the money-in-logs sweep and the
   rule that forbids Supabase keys in Actions all exist only because the repository
   is public. Private ends the whole class. Private repositories pay for Actions
   minutes; what that costs on this account's plan is UNKNOWN. Owner: 2026-11-10,
   "先不要" (not now); the repository stays public.
6. **Verify the refresh end to end.** It was not dispatched for real after the
   change, because a run replaces all of staging's data (see the PR). Coordinator.

## 6. Lessons

- **An artifact of a public repository is public.** Moving something "out of the log
  into an artifact" hides nothing. Encrypt to the requester's key, or do not upload.
- **Mask before the data leaves the machine, not after it lands.** The masking was
  real, but it ran on the destination; the copy in transit was the unmasked one.
- **A safety claim in a header is a claim, not a fact.** "Neither job holds both
  secrets" was believed for two months; one `gh secret list` refuted it.
- **The rule lives in a check now**, not in prose: `scripts/check-workflow-dump-artifacts.mjs`.
