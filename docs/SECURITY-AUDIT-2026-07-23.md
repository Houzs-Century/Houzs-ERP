# Houzs ERP — Security Audit (2026-07-23)

**Scope:** live repo `hello-houzs/Houzs-ERP@main` (HEAD e9ed8463, #1071), plus a
live authorized probe of `erp.houzscentury.com`. Read-only. Method: 6 parallel
attack-surface reviews + git-history secret sweep (2880 commits) + live recon.

**This is an AI-assisted scan, not a substitute for a professional penetration
test.** Use it to close low-hanging fruit before a paid audit, not instead of one.

---

## Overall posture

| Layer | Score | One-line |
|---|---|---|
| **Application code** | **8 / 10** | Genuinely well built. Injection/XSS/SSRF clean, auth well engineered, secrets clean. |
| **Operational / recovery** | **3 / 10** | No verified backups; deploy pipeline has no gate between a stolen credential and prod. |
| **Blended** | **~5.5 / 10** | Your code is not the problem. Your *recovery* and *deploy-gate* posture is. |

The headline: an attacker who scans your site and pokes your code will mostly
bounce off. An attacker who steals a laptop credential (your actual ransom
history) walks straight to prod and you cannot prove you can recover.

---

## The two questions the owner cared about

**"Can we restore the data if we still have it?"**
Partly. Verified in the Supabase dashboard 2026-07-23 (project `anogrigyjbduyzclzjgn`,
"HOUZS ERP SG", **Pro** plan):
- **DB daily backups: ON.** Seven restore points present (16–22 Jul), one per day.
  So a DB wipe can be rolled back to **last midnight** — up to ~24h of data (a full
  day of orders) lost. This is real recovery, not nothing.
- **PITR (point-in-time): OFF.** Available as an add-on ($100/mo 7-day, $200 14-day,
  $400 28-day). Without it there is no "restore to the second before the wipe".
- **R2 files (all PODs/slips/photos): NOT in any backup.** The Supabase backup page
  states outright that Storage objects are excluded, and R2 has no versioning — a
  script or ransomware that overwrites/deletes R2 objects is **unrecoverable**. This
  is now the biggest single recovery gap: DB has daily cover, files have zero.
- **Restore never rehearsed;** the 2026-06-17 prod wipe was recovered by a mechanism
  nobody recorded, so the procedure is unproven under pressure.
Fix: item C1 below.

**"Are credentials leaked in git history?"**
No. 2880 commits swept: zero real provider keys, zero service_role JWTs, zero
real DB passwords ever committed. Current tree clean, `.gitignore` correct,
frontend bundle carries no secrets. Credential hygiene is good.

---

## Scorecard by attack surface

| # | Surface | Result |
|---|---|---|
| 1 | Secrets (history + tree + bundle + live) | ✅ CLEAN |
| 2 | Injection / XSS / SSRF / command | ✅ CLEAN |
| 3 | Auth / session / password / 2FA / reset | ✅ STRONG (1 HIGH: token in localStorage + no CSP) |
| 4 | Access control / multi-company isolation | ⚠️ 1 HIGH + 1 MEDIUM (RLS bypassed → app-code is the only backstop) |
| 5 | Upload / attachment / webhook / mail | 🔴 2 HIGH stored-XSS + systemic missing headers |
| 6 | CI/CD / backups / supply chain | 🔴 1 CRITICAL (no backups) + 5 HIGH (no deploy gates) |

Live probe of `erp.houzscentury.com`: data endpoints all 401 unauth, login error
generic (no user enumeration), no stack traces, no secrets in bundle, real
origin hidden behind Cloudflare. `/.env` `/.git` etc. return 200 but it is the
SPA fallback serving `index.html` — the real files are **not** exposed (verified
by body content). API responses lack HSTS/CSP/X-Frame-Options.

---

## Fix list — in priority order

### C — CRITICAL (do before you trust the system with more data)

**C1. Recovery is half-covered.** DB has daily backups (verified on 2026-07-23);
files and precise recovery do not. For a company already ransomed and already
wiped once, close the gaps in this order:
1. **R2 versioning (do first, near-free).** Files have ZERO protection today. Enable
   object versioning on the `houzs-erp` bucket (Cloudflare) or a periodic offsite
   sync. This is the largest gap and costs almost nothing.
2. **Split the staging R2 bucket.** `wrangler.toml:315-330` points staging at the
   prod `houzs-erp` bucket — staging experiments can delete prod customer documents,
   permanently (no versioning). Create `houzs-erp-staging`.
3. **PITR ($100/mo, 7-day).** Upgrades DB recovery from ~24h RPO to ~seconds. Owner
   decision — worth it given ransom history, but daily backups already exist so this
   is "good → strong", not "zero → something".
4. **Nightly offsite `pg_dump` under separate credentials.** Supabase's own backups
   sit behind the Supabase account; a second copy under a different credential means
   an account takeover can't erase every copy. Pattern exists: `restore-owner-data.yml:68-98`.
5. **Write `docs/RESTORE-RUNBOOK.md` [planned] and rehearse one restore into staging** — the
   2026-06-17 recovery was never documented; an untested backup is a guess.

### H — HIGH (fix before deploy)

**H1. Deploy pipeline has no gate.** `main` has no branch protection (verified
404), Production environment has no required reviewers (verified empty). Push to
`main` = unreviewed SQL + Worker straight to prod; several Actions ("Rollback
2990", etc.) mass-`DELETE FROM prod` with one click, no backup step. → Owner
enables branch protection on `main` + required reviewers on Production; add
`environment: Production` to every prod-targeting job. ~15 min, converts 5 attack
paths into gated ones. (agent F4/F6)

**H2. Prod secrets are repo-level.** `DATABASE_URL` (prod DSN with DDL rights),
`CLOUDFLARE_API_TOKEN`, IMAP passwords are repo secrets — any branch push by a
stolen write-token exfiltrates them. → Move to the (now-gated) Production
environment; make a read-only DB role for diagnostic workflows. (agent F5)

**H3. Stored XSS via inbound email attachment — externally triggerable.**
`routes/mail-center.ts:1098-1107 / :216-233`. An outsider emails a `text/html`
or `image/svg+xml` attachment; it is stored with the sender's MIME type and
served **inline** with no `nosniff`; staff opening it runs attacker JS on the ERP
origin (token theft). This is exactly the "malicious attachment" vector. → Force
`Content-Disposition: attachment` + `nosniff`; allow-list inbound MIME; add
size/count caps. (agent HIGH-1)

**H4. Stored XSS via SVG upload on a public route.**
`scm/routes/sofa-compartment-photos.ts:46,88-133`. `image/svg+xml` accepted;
served on a public, unauthenticated URL inline. → Drop SVG from
`photoExtFromMime`; add `nosniff` + attachment disposition. (agent HIGH-2)

**H5. Service-case write endpoints skip the tenant + ownership scope their read
path enforces.** `routes/assr.ts:1752` (`PATCH /api/assr/:id`) and the whole
`service_cases.write /:id*` family. `assr_cases.id` is a sequential integer, so a
low-privilege user PATCHes any case across the ownership and company boundary
(reassign, rewrite customer PII, mint survey tokens). RLS is bypassed so nothing
else stops it. → Add `requireCaseInScope(c, id)` (company + visibility) to the
top of every write handler. (agent Finding 1)

**H6. Session token in localStorage + no CSP.** `frontend/src/lib/authToken.ts`.
Any XSS reads the 7-day token. No XSS entry point found today, but H3/H4 are
exactly that. → Ship CSP (report-only first) + the header set in H7; consider
device-binding sessions or httpOnly-cookie migration. (agent auth Finding 1)

**H7. Destructive ops still fail-open.** `load-d1-dump-to-pg.mjs` (the script
that wiped prod) still defaults to `.dev.vars` and guards via a hardcoded project
substring that fails open for the next project; `db:reset` (`backend/package.json:18`)
wipes the remote D1 cold-backup with no guard. → Adopt the existing allow-list
guard (`scale-target-guard.mjs`); require explicit target; refuse without a fresh
dump; rename/remove remote `db:reset`. (agent F2/F3)

### M — MEDIUM (should fix)

- **M1. Missing security headers everywhere on the API** (CSP, HSTS,
  X-Frame-Options, and `nosniff` on backend). This is the multiplier that turns
  H3/H4 into working XSS. Adding `nosniff` + CSP blunts all of them at once.
- **M2. Multi-company isolation fails open** — a user with **zero**
  `user_companies` rows sees/writes **all** brands (`companyContext.ts:187-209`).
  One missed provisioning = cross-brand leak. → Verify how many live users have
  no grant, backfill, then flip default to fail-closed. (agent Finding 2)
- **M3. CORS wildcard `*`** on the whole API (`index.ts:132`). Not the
  catastrophic credentialed combo (no cookies), but restrict to known origins.
- **M4. Staging R2 points at the prod bucket** (`wrangler.toml:315-330`) —
  staging experiments can delete prod customer documents. → Split
  `houzs-erp-staging`.
- **M5. `.dev.vars` holds the prod DSN in plaintext on workstations** — the
  ransomed machines. → Local dev uses non-prod DSN; rotate DB password after any
  laptop incident.
- **M6. Announcements thumbnail accepts SVG** (`announcements.ts:1282-1292`).

### L — LOW / hardening

- SHA-pin third-party actions (`dorny/paths-filter@v3`, `cloudflare/wrangler-action@v4`).
- Mirror-receiver secret uses `===`, not constant-time (`mirror-map.ts:96`).
- `sinceDays` string-interpolated into SQL (safe only via clamp) — bind it.
- Per-user throttle on the OCR/AI extract endpoint (cost amplification).

### Owner account actions — do today, no code

1. **MFA on Supabase, GitHub, and Cloudflare accounts.** Account takeover of any
   of these bypasses everything above (a Supabase account takeover can delete the
   project *and* its backups).
2. Confirm Supabase PITR (C1).
3. Branch protection + Production reviewers (H1).
4. Rotate the prod DB password (laptops were ransomed; DSN sat on them in plaintext).
5. Keep an **offline** secrets/config inventory in a password manager, so a
   full-machine loss is a re-clone + re-deploy, not a reconstruction.

---

## What is genuinely strong (don't lose it)

- Bearer-token auth in DB-backed sessions, instantly revocable (better than JWT
  for your ransom-recovery case). PBKDF2-100k, constant-time compares,
  anti-enumeration, anti-timing, rate-limited login + 2FA, full session
  revocation on password change.
- All SQL parameterized through Drizzle; the two raw `ORDER BY` sites are
  whitelisted. Zero `dangerouslySetInnerHTML` in the frontend. All outbound
  fetches use fixed hosts (no SSRF).
- Deliberate, correct server-side company scoping on the paths traced (SCM SO,
  native sales, converters, POS, admin). The isolation *design* is sound — the
  two findings are gaps in it, not absence of it.
- Unusually strong deploy *detection*: ancestor-rollback refusal, GIT_SHA
  stamping, watchdog, post-deploy smoke checks. What is missing is *prevention*
  and *recovery*.
- Clean supply chain: lockfiles tracked, `npm ci`, no suspicious install scripts,
  current dependency versions.
