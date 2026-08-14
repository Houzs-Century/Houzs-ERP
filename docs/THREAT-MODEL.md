# Houzs ERP — Threat Model

Written 2026-07-23 alongside `docs/SECURITY-AUDIT-2026-07-23.md`. The audit answers
"what is broken in the code". This answers the broader question the owner actually
asked: **"how could a hacker still get in and destroy or take our data, and what is
already stopping them?"**

## The owner's priority, stated plainly

The fear is **not** primarily data theft (confidentiality). It is **loss and
destruction** (availability): the database wiped, the code gone, the business
unable to operate — the ransom scenario this company has already lived through more
than once. So this model is ordered by that priority, and every row names **who owns
the remaining action** — because the biggest remaining gaps are not in the code.

## The one-line conclusion

> The code wall is now well built. The realistic remaining way in is **stolen
> credentials walking through the front door** — an attacker who logs in as you or
> an employee bypasses every code defense in this repo. The controls that stop that
> are almost all **account-layer, owner-owned, and mostly free.**

---

## 1. Destruction / ransom (the owner's top fear)

| Threat | How it happens | Defense | Status / owner |
|---|---|---|---|
| Production DB wiped or encrypted | Stolen deploy/DB credential → `DROP`/`TRUNCATE`, or ransomware | Supabase daily backups + **PITR** (restore to the second) | Backups on; **PITR enabled 2026-07-23** ✓ |
| A destructive script re-runs against prod | `load-d1-dump`/`copy-pg`/`db:reset` pointed at prod | Fail-closed guards (allow-list, ACK required) | Fixed — PR #1081 (merge pending) |
| Unreviewed / malicious deploy to prod | ~~Push to `main` auto-deploys; no gate~~ | Branch protection + required checks | **DONE 2026-07-31** — `main-protection` ruleset, `bypass_actors: null`. Required approvals is 0 by choice, so a PR is forced but a review is not |
| R2 files (PODs, payment slips, photos) deleted/overwritten | Bad script or ransomware hits the `houzs-erp` bucket | R2 object versioning | **NOT DONE — owner (Cloudflare acct holding the bucket)** |
| Code lost | Laptop ransomed / disk dies | GitHub holds full history (1991+ commits) | Inherent ✓ — re-clone restores it. Protect the GitHub **account** with MFA |

**Reading:** the DB is now recoverable to seconds (PITR). The two live gaps are
**R2 versioning** (files have zero protection) and **branch protection** (nothing
stands between a stolen token and a prod deploy). Both are owner-owned.

## 2. Credential theft — the realistic way in

Every row here **bypasses the code entirely** — the attacker is a legitimate login.

| Threat | How it happens | Defense | Status / owner |
|---|---|---|---|
| Supabase / GitHub / Cloudflare account takeover | Phished password, reused password, infostealer on a laptop | **MFA** on all three accounts | **NOT DONE — owner. Highest-value single action.** |
| Session/token theft via XSS | Injected script reads the localStorage token | Stored-XSS fixes + report-only CSP | Fixed — PRs #1076/#1080/#1087 (merge pending) |
| Plaintext prod DSN on a workstation | `.dev.vars` holds the live DB password on a ransomed laptop | Local dev uses non-prod DSN; rotate DB password after any incident/departure | **NOT DONE — owner** |
| Ex-employee retains access | Login reset, but DB password / GitHub / Cloudflare access not revoked | Rotate DB password + remove ALL accounts on departure, not just the ERP login | **Owner process — see note** |

**Note on departures:** resetting the ERP login is correct and is now instantly
effective (DB-backed revocable sessions, PR #1079). But it does **not** cut a leaver
who kept a copy of `.dev.vars` (direct DB access) or who held GitHub/Cloudflare
access. Departure checklist must be: reset ERP login **+ rotate the DB password +
remove GitHub/Cloudflare membership.**

## 3. Break-in through the code (what the audit hardened)

| Threat | Defense | Status |
|---|---|---|
| SQL injection / command injection / SSRF | Parameterized Drizzle, fixed outbound hosts | Clean (audit verified) |
| Stored XSS via uploads/attachments (incl. the "malicious email attachment") | Content-type allow-list + attachment disposition + nosniff | Fixed — PRs #1076/#1080 |
| Cross-company / cross-user access to service cases | One scope middleware on all writes | Fixed — PR #1079 |
| Multi-company isolation fail-open | Diagnostic shipped; fail-closed flip gated on it | Diagnostic PR #1089; flip is follow-up |
| Missing security headers / CORS `*` | secureHeaders + CORS allow-list | Fixed — PRs #1075 (merged) / #1090 |
| Brute-force login | Rate limiting + PBKDF2 + 2FA (already present) | Strong (audit verified) |

## 4. Scanners and automated attacks (the "we might be targeted" fear)

Automated bots scan the whole internet (Shodan, Censys, Nuclei) for easy targets.

| Threat | Defense | Status |
|---|---|---|
| Leaked-file probes (`/.env`, `/.git`) | Files are not served (SPA returns the app shell; verified live) | Safe ✓ |
| Secrets in the JS bundle / git history | None found across 2880 commits + the live bundle | Clean ✓ |
| Real server IP exposed | Hidden behind Cloudflare | Safe ✓ |
| Automated vuln scanning / bot floods | Cloudflare WAF, Bot Fight Mode, rate limiting | **Owner should turn these on in Cloudflare (mostly free)** |

## 5. Third parties and supply chain

| Threat | Defense | Status |
|---|---|---|
| Forged data injected via the 2990 mirror / mail-sync | Shared-secret signature, fail-closed, constant-time compare | Present + hardened — PR #1084 |
| A compromised third party over-reaches | Least-privilege, separate credential per integration | Owner should scope integration keys to the minimum |
| Malicious npm dependency | Lockfiles tracked, `npm ci`, no suspicious install scripts | Clean (audit verified) |
| Retagged third-party GitHub Action | SHA-pinned the two that touch deploy secrets | Fixed — PR #1084 |

## 6. Silent data exposure (confidentiality — lower on the owner's list, still real)

| Threat | Defense | Status |
|---|---|---|
| API returns more fields than the UI shows (devtools leak) | Explicit column selects, strip sensitive fields | Under audit 2026-07-23 (over-fetch pass) |
| Auth secrets (password hash, tokens, TOTP) in a response | Never select them into client JSON | Under audit (same pass) |
| Insider/leaver exfiltrates data they can see | Audit log of who downloaded what | **Gap — not currently logged** |

---

## The owner's action list (nothing here is code; do them in this order)

1. **MFA on Supabase, GitHub, and Cloudflare.** Free. Highest value — it closes the
   single most likely break-in (credential theft). Use an authenticator app, not SMS.
2. **R2 object versioning** on the `houzs-erp` bucket (near-free) — the only DB/file
   store with zero recovery today. Needs the Cloudflare account that owns the bucket.
3. **Branch protection on `main`** (GitHub org admin) — put a gate between a stolen
   token and a prod deploy.
4. **Cloudflare WAF + Bot Fight Mode + rate limiting** (mostly free) — make the
   automated scanners bounce.
5. **Rotate the production DB password** — a plaintext copy has sat on
   ransom-exposed laptops; rotate now and after every laptop incident or departure.
6. **Departure checklist:** reset ERP login **+** rotate DB password **+** remove
   GitHub/Cloudflare access — not just the ERP login.

## What this model is NOT

An AI-assisted threat model is a map, not a guarantee. It catches the common and the
structural; it does not replace a professional penetration test for a system holding
customer and payment data. Use it to close the known doors and to make explicit who
owns each remaining one.
