# System Health

Admin-only diagnostic and manual-refresh surface for integrations that normally run on a schedule (AutoCount pulls, session signing, build stamp, PostgREST paging). Two jobs: report what's running (read-only), and re-run an integration when waiting won't fix it.

## Permissions

- Every route under `/api/admin/health`, and the page and its menu row, require `it.view` (the IT pages gate, `services/itAccess.ts`, exposed to the client as the `it.pages.view` capability). `IT_PAGES_WILDCARD_PASSES` is true, so the `*` wildcard passes and Owner and Super Admin see it; set it false to hide the IT pages from them again.
- The ledger, AutoCount reconcile/pull/snapshot, host-build and page-ceiling routes additionally require `*`, so while the switch is off nobody can call them.
- The `system_health` page-access key no longer gates anything.
- `GET /jobs` (last run and verdict per cron job, from `public.job_runs`), `GET /queues` (waiting / failed / oldest age per queue, plus failed slip scans in 7 days) and `GET /hub-report` (IT Hub report set up? last sent / last failed, from the `health-hub` job runs) need only `it.view`.

## Rules that must not break

- `POST /autocount/so-pull?mode=all` must never be used in production — it exceeds the Worker's resource limits on this book's order volume and 503s. Use `mode=filtered` (default, incremental) or `?since=YYYY-MM-DD` for a backfill.
- A stale `pull_checkpoint` only advances when a pull run has zero failed rows — one permanently-failing row freezes it forever; a backfill does not fix that, it only papers over it.
- Compute the session-signing presence flag via `sessionSigningSecret(env)`, never `!!env.SESSION_SIGNING_KEY` — the helper also rejects a key under 16 characters.
- The `/health` build sha must stay a bundled constant (`backend/src/build-info.ts`, `sed`-patched before `wrangler deploy`), not a runtime `--var` — `wrangler secret bulk` can redeploy a Worker version that drops an injected var.
- Both AutoCount cron sweeps (`scm.autocount_relink_sweep`, `scm.autocount_delivery_date_sweep`) must fail CLOSED to off on any config value they cannot read — they end in writes.

## Gotchas

- IT Hub health report (`services/healthHub.ts`, `health-hub` job, every 5 min): POST `<IT_HUB_URL>/api/v1/sys/health` with the key of `IT_HUB_AI_USAGE_COMPANY`, payload `{ ok, time, db, counts, checks, problems }` as Hookka and Conts send it. Jobs, queues and the AI verdict come from `services/healthMeasures.ts` / `serviceHealth.ts`, the same code as the panels, so never compute them a second way. No hub address or key = nothing sent; a refusal is a failed job run.

- `so-pull` backfill: work backwards from the oldest missing `doc_no` in monthly `?since=` windows and stop when a window returns `fetched: 0`; the checkpoint is not read or advanced on this path, so re-running is always safe (upsert on `doc_no`).
- An order missing from the mirror with a current, healthy checkpoint usually just predates the mirror's earliest checkpoint (`filtered` mode can never reach it) — check the doc_no range before assuming something is broken.
- `GET /autocount/host-build` verdicts are not all "AutoCount is down": `HOST_REFUSED_OUR_KEY` (401) means fix the key, not AutoCount; `HOST_HAS_NO_KEY` (503 with JSON) means the host's key file needs restoring; `HOST_DID_NOT_ANSWER` means the Windows service or machine is off; `BUILD_NOT_REPORTED` means the exe predates identity-reporting and needs a rebuild — read the specific verdict, don't assume the integration is broken.
- The `sessionSigning.configured` flag only reports whether the secret is set, not whether requests are using the fast path — read `authFastPath`'s `session_pass.this_request` field for what the current request actually did.
- A signed session pass renews itself on any DB-path hit via the `X-Session-Pass` response header — if that header is missing from `Access-Control-Expose-Headers`, renewal silently stops working.
- `/rest-page-ceiling` and `/autocount/host-build` both need Worker-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `AC_SYNC_URL`/`AC_SYNC_KEY`) — they cannot be probed from a GitHub Actions workflow, only by calling the deployed route as a signed-in owner.
- The month-end stock-close sweep and the inventory valuation page (`GET /inventory/valuation`) share one replay engine (`stock-close.ts`) — don't add a second valuation calculation.
- `/api/announcements` is served by three routers mounted on the same prefix in order (module, receipts, approval) — a route added to the wrong one can silently shadow or be shadowed.
- Failed logins (`public.auth_failed_logins`, `GET /logins`): every failed branch of `/auth/login` and `/auth/totp/login` saves a row via `recordFailedLogin` AFTER the response (waitUntil, errors only logged); it must never change the login's status, body or timing, and never store the password or code. Kept 90 days (`pruneFailedLogins`, daily cron).
- Job failure alerts (`services/jobFailureAlerts.ts`, `job-alerts`, hourly): a job whose `/jobs` verdict is critical gets one bell notice (source `job_alert`, title `Background job failing: <job>`) to the `it.view` desk. The notices are the dedupe record: a job is alerted again only after an ok run since its last alert and 6 h after it. Classify through `readJobs` only.
- Nightly integrity check (`services/nightlyIntegrityRun.ts`, `integrity-nightly`, 00:05 MYT): the half-done-documents classes over the last 2 days, judged by `scripts/lib/half-done-documents.mjs` (shared with the 180-day audit). Skips product-master SERVICE codes, company-1 hard-bound spec buckets that net out, PO lines created before 2026-08-29 MYT. New findings = one notice per company (source `integrity_check`); logs carry counts only. A failed class fails the run, which the job alert then reports.
- `/logins` verdict: one email >= 10 failures in 24 h or > 100 total = warning; one email >= 30 = critical. Rate-limited attempts count as failures.
- `GET /database`: one catalog statement per metric, each in its own transaction with `SET LOCAL statement_timeout = '5s'`. Never plain `SET`: the Hyperdrive pooler is session mode, so it would leak.
- Without `pg_read_all_stats`, other roles' sessions are hidden: long-transaction counts become a lower bound and `limitedVisibility` is set. Lock waits read `pg_locks` (any role can read it, and it has `waitstart`).
- Polled GET lists answer an unchanged poll with an empty `304` (`backend/src/middleware/pollEtag.ts`, mounted in `index.ts` from `POLLED_LIST_PATHS`). The tag hashes the body together with the user and company, so after a company switch the browser's old tag gets a full `200` (Chromium sends the other company's tag despite `Vary`). A response carrying `X-Session-Pass` is sent `no-store` and untagged, and a route that sets its own `Cache-Control` or `ETag` is left alone. A new polled list goes in that array; the wiring test checks every entry is a real GET route.
- Chrome polls (banner, bell, sidebar counts) run through `frontend/src/lib/visiblePoll.ts`: nothing while the tab is hidden, one refetch on return, one request per key per interval however many components read it — never a per-query `refetchInterval`. The sidebar counts are one `GET /api/badge-counts` a minute, which re-dispatches each count to its own endpoint through the full app so its gates still decide. Presence and the notifications feed pause on a hidden tab in their own hooks.
- Connections are judged against the smaller of `max_connections` and the 60-connection cap noted in `wrangler.toml`.

## Where the code is

- `backend/src/routes/systemHealth.ts` — all diagnostic/refresh routes; database load (`systemHealthDatabase.ts`), `/jobs` and `/queues` (`systemHealthJobs.ts`), `/services` and `/logins` live in their own files mounted inside it.
- `backend/src/routes/systemHealthServices.ts` — `GET /services`, one row per outside service, read only from what is already recorded (`execution_logs`, `scm.autocount_outbox`, `email_log`, `scm.wa_message_log`, `push_devices`, `scm.venture_portal_outbox`, `ai_usage_events`); verdict rules in `services/serviceHealth.ts`. Mail-inbox sync and untimed APNs errors are not recorded, so they cannot be judged.
- `backend/src/services/jobRuns.ts` (`track()` wraps every job in `scheduled()`, 14-day retention) and `jobHealth.ts` (job catalogue and verdict rules). A new cron job needs a `track("name", ...)` and a catalogue entry, or its test fails.
- `backend/src/scm/lib/paginate-all.ts` — the `paginateAll` pagination helper `/rest-page-ceiling` measures.
- `backend/src/db/supabase.ts` — PostgREST client used by the ceiling probe.
- `backend/src/acc/stock-close.ts` — month-end stock close sweep + valuation replay.
- `backend/src/build-info.ts` — bundled `GIT_SHA` for `/health`.
- `backend/src/index.ts` — route mounts and the `scheduled()` cron slots.
- `backend/scripts/lib/autocount-pull-rules.mjs` — sentinel alarm thresholds.
- `.github/workflows/autocount-pull-health.yml`, `autocount-pull-sentinel.yml` — read-only pull diagnostics.
