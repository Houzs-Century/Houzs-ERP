# Account Security Setup (owner actions)

These are the security steps that live OUTSIDE the code — the ones no PR can do,
because they are account and platform settings only the account owner can change.
They matter more than any code fix here: the code wall is now well built, so the
realistic remaining way in is a **stolen login walking through the front door**,
and MFA is what stops that. See `docs/THREAT-MODEL.md` for the full picture.

Do them in this order. The first one is the single highest-value action available.

---

## 1. Supabase MFA — DO THIS FIRST (most critical)

**Why first:** a Supabase account takeover lets an attacker delete the entire
project **including its backups** — even the PITR enabled 2026-07-23 cannot save
you, because the attacker is deleting from the account layer, above the backups.
This one account protects the database itself.

**Steps:**
1. Log in to Supabase → top-right **avatar** → **Account Preferences**.
2. Left menu → **Security** (`https://supabase.com/dashboard/account/security`).
3. **Multi-Factor Authentication** → **Enable / Add**.
4. Choose the method offered (Supabase primarily offers an **authenticator app**;
   scan the QR with any authenticator, e.g. the phone's built-in one, Google or
   Microsoft Authenticator).
5. **Save the Backup Codes it shows you** — print or write them down and keep them
   somewhere safe. They are the way back in if the phone is lost.
6. Log out and back in once to confirm the second step appears.

## 2. GitHub MFA — use a Passkey (no app needed)

**Why:** GitHub holds all the code. Account takeover = code deleted or a backdoor
planted. GitHub supports **passkeys**, so this needs no authenticator app — the
computer's fingerprint / Windows PIN is the second factor.

**Steps:**
1. GitHub → **Settings** → **Password and authentication**.
2. **Passkeys** → **Add a passkey** → follow the prompt (Windows Hello / fingerprint
   / PIN). Done — no app.
3. (Optional but recommended) also register a second passkey on the phone, or save
   the recovery codes GitHub offers, as a backup.

## 3. Cloudflare MFA — Passkey or security key (no app needed)

**Why:** Cloudflare holds the Worker + Pages + R2 (the files) + the DNS. Cloudflare
supports **passkeys / security keys**.

**Steps:**
1. Cloudflare dashboard → **My Profile** → **Authentication**.
2. Add a **security key / passkey** (fingerprint / PIN), or an authenticator app if
   preferred. Save the backup codes.

---

## How MFA actually feels day to day (so it isn't a burden)

- **Two factors:** password (what you know) + passkey/code (what you have). An
  attacker who phishes the password still can't get in — they don't have the
  second factor. You have both, so you can.
- **"Remember this device"** — on a trusted computer, tick it at login and you are
  only asked for the second factor about once every 30 days. Day to day it is
  nearly invisible.
- **Backup codes are the safety net** — save them when you enable each account. If
  the phone/fingerprint is ever unavailable, a backup code gets you in.

---

## 4. R2 object versioning — protect the files (near-free)

The database has PITR; the **R2 bucket `houzs-erp`** (PODs, payment slips, SO
photos) has **zero** recovery today. A bad script or ransomware that overwrites/
deletes objects is unrecoverable without this.

- Cloudflare (the account that OWNS the `houzs-erp` bucket) → **R2** → `houzs-erp`
  → **Settings** → enable **Object versioning**.
- Note: the production bucket appears to live under a different Cloudflare account
  than the primary login — enable it from whichever account holds the bucket, or
  have that account's owner do it.

## 5. Branch protection on `main` (GitHub org admin)

**DONE — 2026-07-31. Do not follow the steps that used to be here.**

`main` carries the `main-protection` RULESET: `deletion`, `non_fast_forward`,
`required_status_checks` (contexts `backend-typecheck` + `frontend`, strict) and
`pull_request`. Verify with:

```
gh api repos/hello-houzs/Houzs-ERP/rules/branches/main
```

Not `/branches/main/protection` — that endpoint reports CLASSIC protection only
and answers **404** for a ruleset, which is how this section came to say "no
gate", and to cite `CLAUDE.md` for it while `CLAUDE.md` says the opposite.

The removed steps prescribed exactly the live configuration, so following them
achieved nothing — except the last one, which was actively harmful: *"do not
include administrators (keep an emergency escape hatch)"* would ADD a bypass
actor. The live ruleset has `bypass_actors: null` and `current_user_can_bypass:
"never"` — nobody can force a merge, including the owner. That is the property;
do not trade it away for an escape hatch nobody has needed.

## 6. Cloudflare WAF + Bot Fight Mode (mostly free)

Makes the automated internet scanners bounce before they reach the app.

- Cloudflare → the site → **Security** → turn on **Bot Fight Mode** and the managed
  **WAF** rules; add a **rate limiting** rule on the login endpoint.

## 7. Rotate the production DB password

A plaintext copy of the prod DSN has sat in `.dev.vars` on laptops that have been
ransomed. Rotate the DB password now, and again after any laptop incident or staff
departure.

- Supabase → project → **Settings** → **Database** → reset the database password,
  then update the `DATABASE_URL` secret in GitHub Actions.

---

## Departure checklist (when someone leaves)

Resetting the ERP login is correct but NOT sufficient — it does not cut a leaver who
kept a `.dev.vars` (direct DB access) or who held GitHub/Cloudflare access. On any
departure:

1. Reset / disable their **ERP login** (sessions are now instantly revocable).
2. **Rotate the production DB password** (see step 7) — kills any `.dev.vars` they kept.
3. Remove their **GitHub** and **Cloudflare** access.
