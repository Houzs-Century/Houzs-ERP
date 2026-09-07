# System health — the admin refresh and diagnostic surface

`backend/src/routes/systemHealth.ts`, mounted at `/api/admin/health`. Every route
here is gated `requirePermission("*")` — owner / IT-admin only.

This guide exists because the working-agreement check asked for it: the file had
no guide at all, so a route could be added to it and nothing would say what the
surface is for.

---

## What this module is FOR

Two jobs, and keeping them apart matters:

1. **Report** what the integrations are doing — read-only.
2. **Re-run** an integration on demand, when waiting will not fix it.

The second is the whole reason the module exists. The AutoCount mirrors are
pulled on a schedule, and a schedule cannot repair every kind of gap.

---

## The AutoCount refresh routes

| route | what it refreshes |
| --- | --- |
| `POST /autocount/po-pull` | both PO mirrors — docs first, then lines, so Finance's read gets the fresher data if the second call fails |
| `POST /autocount/so-pull?mode=filtered\|all` | the sales-order mirror |
| `POST /autocount/snapshot` | the unfiltered staging snapshot; writes only `ac_snapshot_*`, so it is the safe one to re-run for a fresh denominator |

### `so-pull` and why `mode` decides whether it can help you

**`filtered` (the default) cannot collect an old order, ever.** It asks AutoCount
`getSince(pull_checkpoint)`. An order whose LAST MODIFIED date precedes the
mirror's earliest checkpoint is never in that answer, so the five-minute pull can
run forever and that row will never arrive. Waiting is not a remedy for this
class — it is the thing that makes it look permanent.

**`all` DOES NOT WORK on this book, and that was measured rather than reasoned.**
Dispatched against production 2026-08-19: 39 seconds, then HTTP 503
`Worker exceeded resource limits`. `getAll()` over ~13,000 orders cannot fetch and
upsert inside one Cloudflare Worker request. The same route with `filtered`
returned 200 in the same session, so the route, the auth and the AutoCount
connection are all fine — only the full refresh is impossible.

**`?since=YYYY-MM-DD` is the backfill that works.** It asks
`getSince(<that date>)` instead of `getSince(checkpoint)`, so the backlog is
collected in WINDOWS small enough to finish. On that path the checkpoint is
neither read nor advanced — deliberately: a backfill reaches BACKWARDS, and
writing its window forward would skip everything between. Re-running is safe: the
INSERT is `ON CONFLICT(doc_no) DO UPDATE`, so rows refresh rather than duplicate.

Work backwards a month at a time from the oldest `doc_no` the health check
reports, and stop when a window returns `fetched: 0`.

**Worked example, 2026-08-19.** A salesperson could not raise a Service Case
against `SO-005263`. The order exists in AutoCount. The read-only check reported
`pull_checkpoint` CURRENT, 3281 rows in the mirror, newest `SO-013275` — and zero
rows for that number *or* its bare digits. Nothing was broken. That order had
simply never been collected, and a windowed `?since=` backfill is what brings it in.

---

## Reading the state before you re-run anything

`.github/workflows/autocount-pull-health.yml` → **AutoCount pull health
(read-only)**. It prints the three numbers that separate *running* from
*working*:

| | what it tells you |
| --- | --- |
| `pull_checkpoint` + how stale | stale means a run is still failing at least one row — the advance is guarded by `failed === 0`, so **one** bad row freezes it |
| newest `doc_no` / `doc_date`, and the doc_no RANGE | the range is what distinguishes "the pull is dead" from "the history was never collected" |
| rows touched in 7 / 30 days | zero here with a healthy checkpoint is the shape that hid for months |

**Read it before re-running.** A stale checkpoint means some row is failing, and
a backfill would paper over it rather than fix it — find the failing row first.

---

## The sentinel — the half that does not wait to be asked

`.github/workflows/autocount-pull-sentinel.yml` -> **AutoCount pull sentinel
(read-only)**, every six hours. It reads the same three numbers as the health
check and then, unlike the health check, it **exits non-zero on an alarm** so the
job fails and the standard failed-workflow email goes out. That email is the only
notifier this repo has, and it is the same channel `do-link-sentinel.yml` and
`mirror-sentinel.yml` use.

**Why both exist.** The health check above is a DIAGNOSTIC: manual dispatch,
always exit 0, answering a question somebody already thought to ask. The cutover
failure was invisible precisely because nobody knew to ask — the pull ran every
five minutes for months, reported healthy runs, and moved nothing. A diagnostic
cannot find that. A sentinel can.

| exit | meaning |
| --- | --- |
| 0 | checkpoint current, rows arriving |
| 1 | ALARM — checkpoint stale past 2 days, or nothing arrived in 30 days, or the checkpoint is missing/unparseable/in the future |
| 2 | CANNOT ANSWER — no database, the query failed, or the mirror holds no timestamped rows at all |

**Exit 2 fails the job on purpose.** A sentinel that cannot see must not report
green; that is the `audit:map`-crashing-for-three-weeks shape. And an EMPTY
mirror is refused rather than answered: zero rows makes "nothing arrived in 30
days" trivially true, and reporting that as a stalled pull would send the next
reader at the wrong system.

The thresholds live in `backend/scripts/lib/autocount-pull-rules.mjs` as a pure
function with `backend/scripts/lib/autocount-pull-rules.test.mjs` beside it, and
the workflow runs that test before the sentinel. The 2-day staleness limit is
taken from the health check rather than invented, so the two cannot drift apart.
The 30-day arrival limit is deliberately far looser than any plausible quiet
period and has NOT been calibrated against this book's live arrival distribution
— the query to calibrate it is in the script's header.

**`pull_checkpoint` carries no timezone**, and the first live dispatch is how
that was learned: it printed `-1d behind`, because the stored
`2026-08-19T20:35:34` was read as UTC while it is MYT — 7.5 hours "ahead" for a
checkpoint half an hour old. The zone is NOT hardcoded from that one sample.
Instead the comparison tolerates any real UTC offset (-12..+14), so up to 14h of
slop rides on the 2-day limit, which really fires between ~1.4 and ~2.6 days. A
checkpoint further ahead than any offset explains is a separate alarm, because
the next `getSince()` would ask for a window starting in the future and skip
everything before it.

**What the sentinel cannot see:** whether the HISTORY is complete. The
incremental pull asks `getSince(checkpoint)`, so an order last modified before
the mirror's earliest checkpoint was never offered. That gap is invisible to
every alarm here and is what the `?since=` windows above are for.

---

## The trap this module was built around

At the Postgres cutover the INSERT in `services/pull.ts` named seven columns the
Postgres table does not have. Postgres refuses the whole statement on an unknown
column, so **every** sales-order row failed — and because the checkpoint only
advances on `failed === 0`, it froze at the cutover date and the same window was
refetched forever. Every per-row failure is caught and counted, so the job kept
reporting normal-looking runs while the mirror took nothing.

The INSERT is fixed. What has **not** been built is anything that watches for the
shape: *the pull ran, reported success, and moved nothing.* Until that exists,
this class is found the way it was found this time — by a person who cannot do
their job. See `BUG-HISTORY.md`, 2026-08-19.

---

## `GET /rest-page-ceiling` — the one number nobody had measured

**Read-only. Gated on `*`** (not on the `system_health` page): the ladder below
issues multi-thousand-row reads, so an unauthenticated or broadly-granted
trigger would be a denial-of-service lever. It is the same gate this module's
other heavy admin routes already carry.

### What it answers

`backend/src/scm/lib/paginate-all.ts` pages in `PAGE = 1000` windows and stops
on the first page shorter than `PAGE`. Its header asserted that PostgREST caps a
response at 1000 rows — **an assertion nothing had ever observed.** 52 files
import `paginateAll`, and the number decides whether they are correct:

| real ceiling | consequence |
| --- | --- |
| `>= PAGE` | the short-page stop is sound |
| `< PAGE` | page one comes back short, the loop stops on it, and **every paged read in the tree truncates silently** |

The response reports, per requested limit (500 / 1000 / 1001 / 5000): rows
actually returned, the `Content-Range` total, and whether the edge capped.
**The gap between those two numbers is the answer.** It also issues
`paginateAll`'s own `.range(0, PAGE-1)` window and states a verdict —
`CORRECT`, `TRUNCATES_SILENTLY`, or `UNKNOWN`.

### Reading it honestly

- A rung whose `contentRangeTotal` is `<=` its requested limit is marked
  **`inconclusive`** and excluded from `ceiling`. That read ran out of *table*,
  not out of *ceiling*, and counting it would manufacture a number.
- `ceiling: null` / `status: "unknown"` is a real answer, not a failure. It
  means no probe pushed past the table's own size.
- `crossTable` re-asks the decisive `PAGE+1` of every other candidate table big
  enough to answer, so agreement across tables is **shown** rather than argued
  from "`db-max-rows` is server-level config".
- It measures a **row** cap only. Response-size and URI-length limits are
  different failures — see `URL_QUERY_BUDGET` in `paginate-all.ts` for the URI one.
- **Counts only.** No row, id, document number or name reaches the payload.

### Why it lives in the Worker

`backend/src/db/supabase.ts` builds a real `createClient`, and every
`sb.from(...)` in the SCM module is a PostgREST call — so the ceiling is a
property of the **REST edge**, and only something holding `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` can ask it. Those are **Worker** secrets and must
stay that way: this repository is public, non-admin collaborators can read
repository secrets, and the service-role key bypasses RLS on the single database
both tenants share. `backend/scripts/probe-mrp-read-ceiling.mjs` was written to
answer this from Actions and its REST half **never ran once** — it printed
`SKIPPED` and the workflow reported success. Rewriting it over `DATABASE_URL`
would have measured Postgres, which is not the thing in question.

**To get the number:** deploy, sign in as an owner, and call the route. If it
returns `TRUNCATES_SILENTLY`, `paginateAll` is wrong and that is its own fix,
not a footnote to this one.

## `GET /autocount/host-build` — which build the office machine is running

**Read-only. Gated on `*`**, the same gate the other `/autocount/*` routes in
this module carry. One proxied call of the AutoCount service's own `/health`;
it sends no document, queues nothing and writes nothing.

### What it answers

A change to `backend/scripts/autocount-service/AcSyncService.cs` ships **inert**.
The exe is rebuilt on the office machine by `deploy-on-host.ps1` — our deploy
cannot do it, because the SQL credentials live there and are compiled in — so a
merged C# change does nothing at all until somebody walks over and rebuilds. Two
fields settle whether that has happened:

| field | what it is | what it settles |
| --- | --- | --- |
| `builtAt` | the assembly's own file timestamp, UTC | earlier than the last commit that touched the C# = the host is behind |
| `mvid` | the module version id, unique per **compilation** | two readings with the same `mvid` are the same bytes; a rebuild always changes it |

The service has answered both since 2026-08-15. Until this route, the only thing
that read them was the outbox drain, which stamps them onto rows it dispatches
(`readHostBuild`, mig 0304) — an answer available *after* a document went, about
the build that sent it, not an answer to "what is running right now".

**The comparison is done by the reader, on purpose:**

```sh
git log -1 --format=%ad --date=short -- backend/scripts/autocount-service/AcSyncService.cs
```

A date compiled into the Worker would be a hand-maintained fact with an expiry
date, which is the thing the two fields exist to replace. The route ships that
command in its own `howToCompare` string so the payload is self-explaining.

### The verdicts, and why they are not one verdict

The host's API-key check is **fail-closed and sits above its `/health` branch**,
so several very different situations all look like "AutoCount is down" if they
are collapsed. Each is a different job for whoever reads this:

| verdict | what actually happened | what to do |
| --- | --- | --- |
| `REPORTED` | the host answered and named its build | compare `builtAt` with the command above |
| `BUILD_UNREADABLE` | it IS a build that reports its identity, but could not stat its own file | which build is running stays UNKNOWN — say so, do not guess |
| `BUILD_NOT_REPORTED` | it sent no build keys at all — only an exe built before 2026-08-15 does that | the host is behind; rebuild it |
| `HOST_REFUSED_OUR_KEY` | HTTP 401 — the service is **running** and our key does not match its `C:\Temp\ac-svc-key.txt` | fix the key, not AutoCount |
| `HOST_HAS_NO_KEY` | HTTP 503 **with** the service's own JSON — it has no key file and is refusing everybody | put the key file back on the host |
| `HOST_DID_NOT_ANSWER` | nothing reached the machine: a gateway status with a non-JSON body, or no response at all (`hostStatus: 0`) | the service is stopped or the machine is off |
| `HOST_ERROR` | the host answered with an error of its own | read `hostError` for its words |
| `NOT_CONFIGURED` | `AC_SYNC_URL` is not set on this Worker (HTTP 503) | nothing about the office machine may be concluded from this |

`BUILD_NOT_REPORTED` versus `BUILD_UNREADABLE` is the distinction the C# is
written to preserve: it sets both keys to `null` rather than omitting them when
its own reflection fails, so a payload carrying **neither key** is an old exe and
a payload carrying **two nulls** is a new one that could not read itself. Absent
never reads as "asked and compared".

The gateway split is the one #2686 paid for: Cloudflare answers an unreachable
origin with `text/plain` containing `error code: 502`, and reporting that as
AutoCount refusing something sent a reader to look at the account book for a
stopped Windows service.

### Why it lives in the Worker

Two reasons, and both are hard:

- **Credentials.** `AC_SYNC_URL` + `AC_SYNC_KEY` are **Worker** secrets and
  deliberately not GitHub ones, so a `workflow_dispatch` check cannot ask the
  host at all. Same posture, same reasoning as `/rest-page-ceiling` above.
- **Transport.** `AcSyncService` binds `http://localhost:<port>/` (port from
  `C:\Temp\ac-svc-port.txt`, default 8900), so an IP-addressed request over
  ZeroTier is answered by `http.sys` — 400, or 403 `Forbidden URL` if the Host
  header is spoofed — before the handler ever sees it. The Worker reaches the
  service through the tunnel, so the Worker is the only thing in this system that
  can ask.

### What never reaches the response

No URL and no key. `AC_SYNC_URL` is a secret and a transport failure's message is
written by the fetch implementation, which legitimately quotes the address it
could not reach — so every string this route passes through from anywhere but its
own source goes through `stripUrls` first. Host fields are picked by name rather
than forwarded wholesale; a key a newer host sends that this route does not read
is reported in `otherKeys` **by name only**.

## `GET /live` — the secret-presence flags, and why one of them matters most

`/live` reports the reachability probes (DB, KV, R2, SCM) and two
**presence-only** flags for secrets: `anthropic.configured` and
`sessionSigning.configured`. Neither ever carries a value; both answer only
"is it set".

`sessionSigning` is the one worth reading first when anybody says the system is
slow. It is `sessionSigningSecret(env) !== null`, and it decides whether a
request pays for authorization:

| flag | what every API request does before the route body runs |
| --- | --- |
| **On** | `tryPassAuth` verifies a signed pass locally. No database read. |
| **Off** | `getUserBySession` runs a six-table join AND a four-branch `UNION ALL` on the shared pool (`services/auth.ts`). |

Off is one reason the CHEAPEST endpoints show up slow — and as of 2026-08-31 it
is NOT the one that was measured. The pass is never renewed: it lives 8 hours, a
session lives 7 days, and nothing minted one outside the four login endpoints, so
for most of every session the DB path ran whatever this card says
(`docs/bugs/0593-*`). Read this card as "is the switch on", never as the
explanation for a slow page. `/api/presence`,
`/api/announcements/banner` and `/api/branding` are all edge-cached, and the
cache is INSIDE the handler — it saves the route's own query, never the two
reads in front of it. `GET /api/auth/me` crossing 800ms is the clean proof,
since it has no route work to blame.

### The second card: what the request in hand actually DID

*Added 2026-09-02, `docs/bugs/0604`.* The paragraph above ends by telling you not
to read the On/Off card as an explanation — and until now there was nothing else
to read. **`authFastPath` is that something**, and it reports observations rather
than settings:

| field | answers |
| --- | --- |
| `session_pass.this_request` | `pass` / `session-db` / `unknown` — what the request that fetched THIS page did. `unknown` means the middleware did not record it and is never collapsed onto either answer. |
| `config_cache.<family>` | the TTL beside the browser's poll interval, the hit/miss for this request, and `ttl_shorter_than_poll`. |
| `reading` | one plain sentence, DERIVED from those numbers so it cannot drift away from them. |

**On is not firing.** A key can be set while every request still pays the two
joined reads — the pass may be absent, expired, or never sent. That is `0593`
exactly, so the two states now render as two separate cards: *Signed sessions*
(the setting) and *This request's authorization* (the behaviour). If the first
says On and the second says Database, chase the pass, not the caches.

**`unknown` is checked BEFORE the caches, and that order is a bug fix, not a
style choice** (`docs/bugs/0605`). It used to sit below, so `unknown` beside a
short TTL printed *"Authorization took the fast path"* — a claim about the one
thing the card had just said it could not see. The owner read exactly that
contradiction on the first live loading of this page. The cache finding is still
reported under `unknown`, because it holds either way — but as a separate clause
that claims nothing about the path.

**`unknown` is not a dead end.** It carries `client_sent_pass` (presence of the
header only — never the value, never a prefix, never a length), because the two
causes need opposite fixes: **no header** means the browser has none to send (it
expired, or was never stored); **header present and still no record** means we
lost the record, which is a different bug.

**`ttl_shorter_than_poll` uses `<=`, not `<`.** A TTL EQUAL to the poll expires
exactly as the next poll arrives, which is the banner's measured 874-984ms case,
not a near miss.

Presence is structurally short today — **kept 15s, asked for every 60s** — so one
user alone misses every poll. `backend/tests/authFastPathProbe.test.ts` asserts
that, so the day it is fixed the test is what says so. It also PINS both mirrored
poll intervals against the hooks' source: `configCache.ts` said the banner poll
was 60s and reasoned "300s (5 polls)" from a value that has been 180_000 for some
time (1.67 polls). Proved red by moving the constant.

### What the client-error dump measured, 2026-09-02

3-day window, from **Client errors dump (read-only)** — occurrences, not
signatures:

| endpoint | slow occurrences |
| --- | --- |
| `/api/presence` | 354 |
| `/api/announcements/banner` | 343 |
| everything else | 64 |

**`GET /api/auth/me` does not appear at all.** The paragraph above names it as
the clean proof of the DB path being paid, so its absence is the closest thing to
evidence that the renewal fix (`0593`, deployed 2026-08-31 18:41 UTC) did what it
was meant to. It is NOT proof: the dump groups by signature with a last-seen
date, so it cannot be split into before and after that deploy. Recorded as
LIKELY, and the probe above is what will settle it.

Two things not to do with this flag:

- **Do not compute it as `!!env.SESSION_SIGNING_KEY`.** `sessionSigningSecret`
  also rejects a key under 16 characters, so a placeholder would read On here
  while the runtime still takes the DB path. Pinned by
  `src/routes/systemHealthSessionSigning.test.ts`.
- **Do not read it as a health verdict.** Off is not a fault; it is a switch
  nobody has thrown. Turning it on is the owner setting one Worker secret, and
  this card is how the change gets confirmed afterwards.

Background: `docs/bugs/0592-nobody-could-tell-whether-signed-sessions-were-on-so-every-r.md`.

## The pass renews itself now — where the authorization cost actually goes

The card above answers "is the switch on". It does not answer "why is this page
slow", and until 2026-08-31 nothing did, because a second gap sat behind it.

**A pass lives 8 hours; a session lives 7 days; nothing minted one outside the
four login endpoints.** So the signed-session fix covered the first 8 hours of a
session and then stopped applying — about 95% of a session's life ran the DB
path, whatever the switch said. `docs/bugs/0593-*` has the trace and the two
constants.

`middleware/auth.ts` now re-issues on the authoritative path — reaching
`getUserBySession` *means* the caller has no usable pass — and returns the new
one on an `X-Session-Pass` response header, which is why that header is in
`Access-Control-Expose-Headers` in `backend/src/index.ts` (both the `cors()`
options and the hand-set error path; a header the browser hides is a renewal that
silently never happens). The SPA absorbs it in `correlatedFetch`, the single
funnel every authenticated transport goes through.

Reading this pair together is the whole diagnostic:

| card says | and requests are still slow | means |
| --- | --- | --- |
| On | yes | not authorization — look at the route, the pool, or Hyperdrive |
| On | no | working as intended |
| Off | yes | the switch, and it is one secret |

What to measure rather than assume: the `[slow …]` signature counts on
`/api/auth/me`, `/api/presence` and `/api/announcements/banner` from the
**Client errors check (read-only)** workflow. `/api/auth/me` is the cleanest of
the three — it returns the authenticated user and nothing else, so it has no
route body to blame.

## `GET /health` — the build stamp, and why it is baked into the bundle

`/health` returns `{ ok, sha }` where `sha` is the commit the live Worker was
built from. The **Deploy watchdog** workflow reads it and compares it to `main`
to catch a rogue/stale overwrite of prod — a null or unknown stamp is treated as
a rogue deploy. The handler is `app.get("/health", …)` in
`backend/src/index.ts`, and the value comes from `resolveBuildSha(GIT_SHA, …)`.

**The stamp is a value COMPILED INTO the bundle, not a `--var GIT_SHA` env.**
`backend/src/build-info.ts` exports `GIT_SHA` (the committed placeholder is
`"dev"`); `.github/workflows/deploy.yml` and `deploy-staging.yml` `sed` the real
commit sha onto that export line right before `wrangler deploy`. This replaced
the fragile env stamp after 2026-09-01, when `wrangler secret bulk` (the separate
secrets step that runs after the deploy) non-deterministically redeployed a
Worker version WITHOUT the CLI-injected `--var`, leaving `/health`'s sha null and
the watchdog false-alarming in a redeploy loop (`docs/bugs/0596-*`). A bundled
constant survives every var/secret operation; `resolveBuildSha` still falls back
to the legacy `c.env.GIT_SHA` and then null, so the watchdog's rogue-deploy
detection is unchanged (a bare clone carries `"dev"`/an old sha). Pinned by
`backend/tests/buildInfoSha.test.ts`.

## The cron slots (`backend/src/index.ts` `scheduled()`)

Five wrangler cron expressions fan out inside one `scheduled()` handler; each
job is `ctx.waitUntil`-guarded so no failure can break its slot-mates:

| cron | what runs |
|---|---|
| `*/5` | Hyperdrive keep-warm ping, email-outbox drain, AutoCount SO pull, amendment write-back drain, ERP→AutoCount outbox drain |
| `*/15`, `*/30` | trip/TMS sweeps; ASSR per-stage alerts + lead-time activations; announcement overdue escalation (`services/announcementEscalation.ts` `runOverdueEscalation`, 2026-09-06 — supervisors notified once a must-acknowledge notice has been live 48h, stamped in `announcements.escalated_at`) |
| `0 2` (10:00 MYT) | daily batch: SLA escalation, DO-mirror + PO pulls, ASSR digest, project reminders, client-error digest, idempotency-key TTL sweep, AR-aging MV refresh, Sunday scan-so distill |
| `5 16` (00:05 MYT) | **month-end stock close sweep** (GL redesign item 4, 2026-09-05): `sweepStockClose` re-checks the two most recent closed months for every company — posting the closing/reversal pair the night a month ends, re-posting when a late-keyed document changed a replayed value. Every outcome lands in `scm.acc_stock_close_runs`; the Month-end tab on /scm/accounting is the visible log. Logic in `backend/src/acc/stock-close.ts` — which also exports `stockBreakdownAsOf`, the per-item replay behind `GET /inventory/valuation` (the Inventory page's 选日期 view), so the page and the ledger read one engine. |
