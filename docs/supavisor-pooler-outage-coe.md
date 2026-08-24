# Houzs ERP — Supabase Shared Pooler (Supavisor) Outage COE (Correction of Error)

**Date:** 2026-07-05, ~18:27 MYT → 2026-07-06, ~12:44 MYT (observed; see the timeline in §2 for the bounds).
**Trigger:** Two symptoms at once, and they looked unrelated. The app answered every request with *"The database is briefly unavailable. Please try again in a moment."* — the same sentence staff already knew from a routine cold start, except it did not clear. And every deploy died at the migration step with **`password authentication failed for user "postgres"`**, on a credential nobody had touched in three weeks. The Supabase dashboard reported the project **Healthy**.
**Status:** Recovered. **Nothing was shipped in response** — no code change, no runbook, no detector. The entire durable record until now was one line in `BUG-HISTORY.md`, written nine days later from memory.

> **Why this one matters more than its length suggests.** An operator who recognises this signature restores service in minutes. An operator who does not will spend hours re-checking a password that was never wrong, and every check will "confirm" the problem, because the auth error is real — it is just not about the password. The recognition rule is in §4.

---

## 1. Root cause

**A fault in Supabase's shared connection pooler (Supavisor) — the layer in front of the database — presented as a credential rejection to one client and as a connection failure to the other.** The database's own health, as reported by the Supabase dashboard, stayed green throughout, because the dashboard was not asking the question that was failing.

The system reaches Postgres by two independent paths, and this is what makes the incident legible:

| Path | Route | Credential it uses | What it saw |
|------|-------|--------------------|-------------|
| The Worker (production traffic) | Cloudflare **Hyperdrive** → Supabase pooler (`backend/src/db/pg.ts:75-89`, `backend/wrangler.toml:77-90`) | the connection string stored **on Cloudflare**, in the Hyperdrive config | connection-shaped errors → HTTP **503** |
| CI (`pg-migrate.mjs`) | direct `postgres.js` connection, **no Hyperdrive** (`backend/scripts/pg-migrate.mjs:36`, run from `.github/workflows/deploy.yml:63-65`) | the **`DATABASE_URL` GitHub repo secret** | **`28P01` password authentication failed** |

Two paths, two separate credentials, two different failure strings, one shared component behind both. A credential problem cannot make two independent credentials fail in the same hour; a fault in the thing they both dial can.

### Evidence — the tool that proved it was the GitHub Actions job log, not a guess

The exact error, preserved in the run log of the failed deploy (job `85214490041`, run `28737603666`):

```
2026-07-05T10:25:18Z PostgresError: password authentication failed for user "postgres"
    at .../backend/scripts/pg-migrate.mjs:37:9 {
  code: '28P01',
  severity_local: 'FATAL'
}
```

It appears **four times**, in four separate runs, all on 2026-07-05: `09:46:08Z`, `10:25:18Z`, `10:27:10Z`, `10:52:06Z` (jobs `85211886922`, `85214490041`, `85214623863`, `85216333234`). In every one of those runs the **`frontend` job succeeded** — so this was not a runner outage, not a network outage, and not a checkout or dependency failure. Only the step that talks to Postgres failed.

The production side is proved by a workflow that happens to be a continuous prober. `mail-sync.yml` POSTs every fetched message into the live Worker (`mail-sync/sync.mjs:272-285`), and logs the ERP's HTTP response verbatim. Its logs are, in effect, an uptime record we did not know we were keeping:

```
2026-07-05T10:27:10Z  msg fail: ERP POST 503 Service Unavailable
                      {"error":"The database is briefly unavailable. Please try again in a moment."}
```

That body is the exact string emitted by `humanizeError` at `backend/src/index.ts:308`, which fires **only** when `TRANSIENT_CONN_RE` matches (`backend/src/db/d1-compat.ts:233-234`). So the Worker was not returning a generic 500: whatever the driver threw through Hyperdrive was a *connection-shaped* error — dropped socket, refused connection, terminated connection, `fetch failed` — not an auth error. **The same underlying fault surfaced as "cannot connect" to Hyperdrive and as "wrong password" to a direct client.**

### Why a pooler fault presents as an authentication failure

Supavisor is a proxy that terminates the client's Postgres connection itself and then opens its own connection to the real database. It must therefore **authenticate the client on its own**, against tenant metadata it holds, before it ever reaches Postgres. When that tenant lookup is unavailable or wrong, the only vocabulary the Postgres wire protocol gives the proxy at that point in the handshake is an `ErrorResponse` — and `28P01 invalid_password` is the one it sends. The client library faithfully reports what it was told. Nothing in the message distinguishes *"your password is wrong"* from *"I could not look up who you are"*.

One detail in the captured error supports this reading rather than a plain wrong-password: the failure names the user **`postgres`**, the base upstream role. `DB-REPOINT-RUNBOOK.md:21` shows this project's pooler connection strings are of the form `postgres.<project-ref>` — a tenant-qualified username. A rejection that names the *unqualified* role is the shape of a failure on the proxy's own upstream leg, not a rejection of the credential the client presented.

**This paragraph is inference about a vendor's internals, and is marked as such.** The repository proves the symptom, the timing, and the two-path correlation. It does not prove Supavisor's implementation. What makes the inference safe to act on is that the *operational conclusion* does not depend on it: two independent credentials failing simultaneously already rules the credential out, whatever the proxy is doing internally.

---

## 2. Timeline (every row is a timestamp from a preserved Actions log or the GitHub API)

All times UTC; MYT is +8.

| UTC | What |
|-----|------|
| 2026-06-14T10:18:01Z | `DATABASE_URL` repo secret created. **Not modified again before the incident** (GitHub secrets API `updated_at`). |
| 2026-07-05T07:52:18–07:54:18Z | Last green backend deploy — same secret, same script, no error (job `85204588167`). |
| 2026-07-05T08:14:26Z | Mail sync healthy against prod: `76 seen, 1 new, 75 dup, 0 failed`. Production's DB write path is alive. |
| **2026-07-05T09:46:08Z** | **First `28P01`.** Deploy re-run fails at `pg-migrate`. |
| 2026-07-05T10:25:18Z / 10:27:10Z / 10:52:06Z | `28P01` again, three more runs. |
| **2026-07-05T10:27:10Z** | **First observed production 503** — mail sync: 82 of 82 messages rejected with the "briefly unavailable" body. |
| 2026-07-05T11:52Z → 2026-07-06T00:19Z | Prod still 503. Every hourly mail-sync run: **0 new, 100% failed** (11 consecutive runs). |
| 2026-07-06T03:15:50–03:17:29Z | Deploy re-run fails again — but with `ENETUNREACH … :5432` on an IPv6 address, **not** `28P01`. A different fault (see §3). |
| 2026-07-06T04:27:36Z | `DATABASE_URL` repo secret **updated** — its first change since 2026-06-14. |
| 2026-07-06T04:28:00–04:29:54Z | Backend deploy green. |
| 2026-07-06T04:44:39Z | Mail sync healthy: `87 seen, 41 new, 46 dup, 0 failed` — the 41 messages that had been 503-ing all night land. |

**Observed production impact: ~18h15m** (2026-07-05T10:27Z → 2026-07-06T04:44Z), bounded below by the last healthy probe at 08:14Z. The gaps between mail-sync runs mean the true start could be up to two hours earlier and the true end up to four hours earlier; the log cadence, not the fault, sets that resolution.

---

## 3. What this COE rules OUT

- **Not a rotated or expired credential.** The GitHub secrets API records `DATABASE_URL` as untouched from `2026-06-14T10:18:01Z` until `2026-07-06T04:27:36Z` — the recovery itself. The same secret had produced a green deploy 1h54m before the first failure. And no commit anywhere in history changes it: `git log -S` finds no connection-string edit in the window.
- **Not a CI or runner problem.** The `frontend` job succeeded in every one of the four failing runs. `npm ci`, checkout and the build all worked; only the Postgres step failed.
- **Not the same fault as the ENETUNREACH on 2026-07-06T03:15Z, and confusing the two costs hours.** That one is an IPv4/IPv6 dual-stack routing failure — GitHub-hosted runners have no IPv6 egress, and the pooler hostname can resolve AAAA-first. It is fully diagnosed elsewhere in this repo (`32a02eea`, 2026-07-01, and the comment it left at `.github/workflows/deploy-staging.yml:79-86`), and its fix is `NODE_OPTIONS=--dns-result-order=ipv4first`. **It presents as the same headline — "the deploy died at pg-migrate" — and has nothing to do with the pooler's authentication.** Read the error code: `ENETUNREACH` is "I could not reach the host", `28P01` is "the host rejected me".
- **Not the 2026-06-13 pooler incident.** `backend/wrangler.toml:80-89` records a different pooler failure three weeks earlier: the **transaction** pooler (6543) got stuck, Hyperdrive hung reaching origin for hours, and the fix was to repoint the Hyperdrive config at the **session** pooler (5432). Same vendor component, different failure, and — critically — a different remedy. In 2026-06-13 the database was reachable by direct connect the whole time; here the direct connect was the thing being refused.
- **Not the routine cold start.** `docs/db-cold-start-503-coe.md` covers the 503 that clears in seconds. Here the *identical user-facing sentence* persisted for eighteen hours across hundreds of retries. **The message does not distinguish them; duration does.**
- **Not "prod was fine and only CI broke".** That was the tempting read, since staff kept merging PRs through the evening. The mail-sync logs refute it: 82 of 82 inbound messages rejected, hour after hour.

---

## 4. The recognition rule (the operational point of this document)

You are looking at a pooler fault, not a credential fault, when **all** of these hold:

1. The error is `28P01` / "password authentication failed", **and**
2. nothing changed the credential — check the GitHub secret's `updated_at`, and check whether the same secret worked earlier the same day, **and**
3. the *other* path is failing too — production is answering `503 "The database is briefly unavailable"` — even though production authenticates with a completely different stored connection string, **and**
4. the Supabase dashboard says the project is **Healthy**.

Point (4) is not reassurance; it is part of the signature. The dashboard is reporting on the database, and the database is fine.

**The action is to Restart the project from the Supabase dashboard.** That is what the sole prior record prescribes (`BUG-HISTORY.md` line 3435), and this reconstruction is consistent with it: the production Worker never reads the `DATABASE_URL` GitHub secret — its connection string lives in the Hyperdrive config on Cloudflare, and `deploy.yml:66-79` pushes only `FORM_INTAKE_KEY` and `SHEET_SYNC_KEY` as Worker secrets — **so whatever the 04:27:36Z secret update changed, it cannot be what cleared production's 503s.** Something outside this repository fixed production. A dashboard restart leaves no repository trace, exactly as the billing action in `docs/cloudflare-plan-cap-coe.md` left none.

---

## 5. What the record does NOT show

- **That a Restart was performed, or by whom, or when.** It is attested only by `BUG-HISTORY.md` line 3435 — one line, backfilled 2026-07-14 under a section that labels itself *"reconstructed after the fact, dates approximate"* (`:3425-3427`). The 18-hour recovery window is consistent with an overnight gap before someone acted, but nothing dates the action.
- **What the `DATABASE_URL` secret was changed to at 04:27:36Z, or why.** The value is a secret and never appears in a log. Two readings fit: a password reset performed as part of the recovery, or a repoint of the CI connection string away from whatever endpoint produced the `ENETUNREACH` 70 minutes earlier. The repo cannot choose between them — and its own claims about that secret are internally inconsistent, which is worth knowing before anyone reasons from them: `deploy.yml:60` calls it the "prod Supabase **direct connection** string", and `32a02eea` asserts prod "points at a direct-connection hostname that **resolves IPv4-only**", yet on 2026-07-06 that same secret resolved to an IPv6 address. One of those statements is stale.
- **What staff saw, in their own words.** No screenshot or report survives. The user-facing sentence is quoted from the code that produced it, and its delivery to a real client is proved by the mail-sync log — not by a staff account.
- **Whether Supabase acknowledged an incident.** No status-page capture is in the repo.
- **Whether it recurred.** No `28P01` appears in any subsequent failed production deploy. All 54 failed `deploy.yml` runs after 2026-07-06 were checked at the step level; four failed at `pg-migrate` (2026-07-11, 2026-07-13, 2026-07-14 ×2) and every one of those was `42P07` — a duplicate-object error in a migration file, unrelated. **Single occurrence, so far.**

---

## 6. Fixes shipped

**None.** This row is the finding, not an omission in the write-up.

No commit between 2026-07-06 and `9ea3c425` (2026-07-21) adds detection, retry, alerting or documentation for this failure mode. What that leaves in place today:

| Where | State | Consequence |
|-------|-------|-------------|
| `backend/src/db/d1-compat.ts:233-234` (`TRANSIENT_CONN_RE`) | Does **not** match `password authentication failed` or `28P01`. It does match `MaxClientsInSessionMode`, a Supavisor-specific string — so pooler *saturation* is classified, and pooler *auth* failure is not. | The Worker only 503'd because Hyperdrive independently produced a connection-shaped error. Any direct-driver path would have surfaced a raw 500. |
| `backend/scripts/pg-migrate.mjs` | No retry, no backoff, no error classification. First error aborts. | A transient pooler blip fails a deploy outright — and because `deploy.yml` runs migrate **before** `wrangler deploy`, a green Worker is never even attempted. |
| `backend/scripts/smoke-check.mjs` | Would have caught it (`GET /api/auth/status` is a full DB round-trip). | But it runs **after** the deploy step, so in this incident it never executed. The one probe built to detect "Worker up, DB unreachable" was sequenced behind the thing that failed. |
| `docs/` | **No runbook exists.** `docs/DB-REPOINT-RUNBOOK.md` is a project-*migration* procedure (and is itself stale — it targets `ctbaifabbzghtsrmpirm`, not the live `anogrigyjbduyzclzjgn`). There is nothing that tells an operator what to do when production is 503 and deploys report bad credentials. | The knowledge lived in one person's head for 16 days. **The absence is the finding.** |

---

## 7. Deferred

| Item | Owner | Note |
|------|-------|------|
| **Write the operator runbook** — "production is 503 and/or deploys fail auth": the four-point recognition rule from §4, then Restart the project. One page. | Owner | This COE is not a substitute. A runbook is read at 2am by someone who is not reading `docs/*-coe.md`. |
| **Do NOT add `password authentication failed` to `TRANSIENT_CONN_RE`.** | whoever next touches `d1-compat.ts` | Recorded here so nobody "fixes" it that way. That regex drives an automatic retry (`isDeadConnError`) and the user-facing 503. Classifying a genuine credential failure as transient would make a real misconfiguration retry silently and forever, and hide it behind "briefly unavailable". Its own comment already sets the rule: *every string here is a pre-execution connection failure*. `28P01` arrives from a server that answered. |
| **Give `pg-migrate.mjs` a bounded retry and a named diagnosis.** | Owner / whoever next touches the deploy runner | Two or three attempts with backoff would ride out a blip. More valuable than the retry: on `28P01`, print the recognition rule instead of a raw stack trace — the operator reading that log is exactly the person who needs it. Change carefully; this script gates every production deploy. |
| **Run `smoke-check.mjs` (or a cheaper DB ping) *before* `pg-migrate`.** | Owner | Today the detector sits behind the failure. A pre-flight reachability probe would name the fault as "cannot reach the database" rather than leaving `28P01` to imply "your password is wrong". |
| **Nothing watches production between deploys.** | Owner | Production was 503 for eighteen hours and the only continuous record is a mail-sync workflow that exists for an unrelated purpose. `GET /api/admin/health/*` must be polled by someone to mean anything. This is the same gap `docs/cloudflare-plan-cap-coe.md` §5 records for platform quota. |
| **Reconcile the `DATABASE_URL` description in `deploy.yml:60` and `32a02eea` with reality.** | Owner | Two places assert it is a direct, IPv4-only connection; the 2026-07-06 log shows otherwise. `CLAUDE.md` names this exact hazard: a stale fact is worse than no fact. |

---

## 8. Lessons

1. **`28P01` from a pooled Postgres means "the front door rejected me", not "your password is wrong".** Before touching a credential, check whether it changed — `gh api repos/<owner>/<repo>/actions/secrets` returns `updated_at` for every secret, and it settled this incident in one call. A password that has not been edited in three weeks and worked two hours ago is not the fault.
2. **When two independent credentials fail in the same hour, the fault is in what they share.** Production authenticates through a connection string stored on Cloudflare; CI authenticates through a GitHub secret. Neither can affect the other. The correlation *is* the diagnosis, and it is available in seconds — long before any theory about the vendor's internals.
3. **A vendor dashboard reporting "Healthy" is answering a narrower question than the one you asked.** It probed the database. The database was fine. Everything between your client and the database was not, and no health indicator you did not build covers that gap.
4. **The same user-facing sentence covers a three-second event and an eighteen-hour outage.** *"The database is briefly unavailable"* is correct for the cold start it was written for and actively misleading here, because it tells staff to wait for something that will not clear. Duration, not wording, is the only signal the current system gives — so **when a "transient" message persists past a minute, stop treating it as transient.**
5. **Sequence the detector in front of the thing that fails, not behind it.** `smoke-check.mjs` was built precisely to catch "the Worker is up but the DB is unreachable" and it never ran, because `pg-migrate` fails first and the job stops. A check that only executes on the happy path is not a check.
6. **When the fix is a click in a vendor console, the commit that would normally carry the story does not exist — so write the entry the same day.** This incident produced four preserved job logs, eleven hours of mail-sync 503s, and one secret timestamp; all of it was still there sixteen days later and it was enough to reconstruct the whole thing. What was *not* there was the one fact only a human had: that restarting the project fixes it. `BUG-HISTORY.md` line 3435 rescued it. That is the rule working — and, as in `docs/cloudflare-plan-cap-coe.md`, it is the thinnest the rule can work.

---

## See also

- `BUG-HISTORY.md` line 3435 — the sole prior record, and its "dates approximate" caveat at `:3425-3427`.
- `backend/src/index.ts:302-310` + `backend/src/db/d1-compat.ts:227-239` — the 503 classifier and the transient-error regex that does *not* cover this case.
- `backend/scripts/pg-migrate.mjs:36-37` — the direct connection that produced `28P01`; `.github/workflows/deploy.yml:57-65` — where it runs, before the deploy.
- `backend/wrangler.toml:80-89` — the **different** 2026-06-13 pooler incident and its session-pooler remedy.
- `.github/workflows/deploy-staging.yml:79-86` and `32a02eea` — the IPv6 dual-stack `pg-migrate` failure, which is not this.
- `docs/db-cold-start-503-coe.md` — the transient 503 that shares this one's error message.
- `docs/cloudflare-plan-cap-coe.md` — the other incident whose fix left no trace in this repository.
