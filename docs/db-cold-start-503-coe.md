# Houzs ERP — Database Cold-Start 503 COE (Correction of Error)

**Date:** a recurring condition, not a single event — first traced 2026-06-14, owner-reported and re-fixed 2026-07-02 and 2026-07-04, still shaping code written 2026-07-21.
**Trigger:** In the owner's words, on mobile, *"很多次了"* — repeatedly. What he saw was **"The database is briefly unavailable"** and **"Couldn't load orders"** on the first tap of the day, or right after a deploy. Before the message existed, the same fault showed as an opaque **"Failed to fetch"** with nothing behind it. The pointed version of the question, recorded in `b5ae3599`: *why does HOOKKA never show this?*
**Status:** Mitigated on every client path; **not eliminated, and not eliminable in code.** The residual is an owner-level billing decision (§7). The connection layer that everyone's instinct says to tune is deliberately frozen — §8, lesson 1.

---

## 0. Does this warrant its own COE? Yes — and here is the boundary, because the overlap is real

`docs/system-foundation-coe.md` already covers a cold-start hang. Specifically: a ~12s cold Hyperdrive connection was the *amplifier* in the 2026-06-22 incident (§1, step 1), and its §4 gives the latency four sentences under the heading "The 'slow' problem (distinct from the crashes)". A second COE that restated that would be worse than none.

It does not restate it. That document's subject is **one architectural defect** — `middleware/db.ts` mutating shared isolate state — for which the cold start supplied the pause that let two requests interleave. Fix the mutation and that incident is over; the cold start remains, and did.

This document's subject is the cold start itself, and everything about it lies outside the other's scope:

- **A different span.** Nine months of nothing would be one thing; this is 2026-06-13 through at least 2026-07-21, with eight separate shipped mitigations, three of them *after* `system-foundation-coe` was written.
- **A different reporter and symptom.** Owner-reported, on mobile, twice (2026-07-02, 2026-07-04) — "Couldn't load orders", a failed save, a bounce to the login screen. None of that is a 500 and none of it appears in the other document.
- **Consequences the other document does not reach.** The cold-start window is now a *premise* in this codebase's correctness arguments: it is why company scoping fails open on an unresolved read (`BUG-HISTORY.md:264`, `:274`), why a POD screen once told a driver a customer owed the full amount (`:1698`), and why fail-closed session revocation had to be softened (`40e3e5c8`). Those are money and access consequences of a latency condition, and they are the reason this is worth its own file.
- **A rule the other document only implies.** `backend/src/db/pg.ts` is frozen. That fact is load-bearing, repeatedly re-derived, and stated nowhere as a rule.

So: separate COE, with an explicit hand-off. **For the 2026-06-22 outage, read `system-foundation-coe.md`. For "why is the first request of the morning slow, and why can't we just fix the pool", read this.**

---

## 1. Root cause

**Production reaches Postgres through a connection pool that goes cold, and the first query through a cold pool can take longer than a person will wait.** There is no defect. Every layer is behaving as designed:

1. The Worker runs on Cloudflare, in front of **Hyperdrive**, which pools connections to Supabase origin-side.
2. A Worker isolate that just restarted (**every deploy**) starts with no warm pool. A quiet period has the same effect from the other end — **the pooler reaps idle connections** (`backend/src/db/d1-compat.ts:211-213`).
3. The first query on a cold connection does not fail fast. In the worst observed case it **does not settle at all** — the socket never errors and the `postgres.js` promise simply never resolves, riding the Workers runtime's ~30s hang detector to a kill (`d1-compat.ts:198-206`).
4. Supabase compute is on the **Micro** tier, whose backend spin-up is the floor under all of this (`system-foundation-coe.md:82`).

Compounding it: Houzs sees this *more* than the sibling HOOKKA system does, and for a reason that is the opposite of a code difference — **HOOKKA is busier.** Steady daily traffic keeps its pool warm. Houzs, under heavy development and lighter real use, lands in the cold window far more often (`b5ae3599`).

### Evidence

- **`wrangler tail`, live**, is what proved the hang rather than assuming it. PR **#10** captured `POST /api/presence/heartbeat — Exception Thrown / ERROR: The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response`, and noted that a login probe a minute later answered in 0.5s — *"confirms it's intermittent/cold, not down."*
- **The 12-second figure is measured, not estimated.** `system-foundation-coe.md:16` quotes tail output: `[db-retry] d1-compat first attempt timed out` alongside `[slow-query] 12030ms`. The constant `FIRST_ATTEMPT_TIMEOUT_MS = 12_000` (`d1-compat.ts:207`) is that observation turned into code.
- **The 503 is the system's own classification, not a guess.** A cold-pool failure matches `TRANSIENT_CONN_RE` (`d1-compat.ts:233-234`) and `humanizeError` renders it as `503 {"error":"The database is briefly unavailable. Please try again in a moment."}` (`backend/src/index.ts:307-308`) — raised by the connection layer **before** the handler runs, which is the property every retry below depends on.

---

## 2. Fixes shipped

Eight changes across five weeks. They fall into three groups: make the server retry, make the pool stay warm, make the client patient.

| Ref | Date | What | Effect |
|-----|------|------|--------|
| `b6692450` | 2026-06-13 | `d1-compat`: retry **once** on a dead pooled connection, on a **fresh** client — never the stuck one. | First self-heal. A connection error means the query never reached the server, so re-running cannot double-write. |
| `9c763e54` | 2026-06-13 | **Keep-warm cron**: `SELECT 1` every 5 minutes (`backend/src/index.ts:348-352`, `wrangler.toml:181`) + KV session cache. | Keeps the pool alive through quiet periods so the first *real* request of the morning is not the one that pays. |
| **#10** | 2026-06-14 | Frontend: cap each GET at 27s with an `AbortController`, retry twice. Mutations uncapped and never retried. | Kills the opaque **"Failed to fetch"**. 27s is chosen *above* the ~20s cold start and *below* the 30s hang-kill — it aborts only a true hang, never a slow-but-working query. |
| **#26** (`f66b0a90`) | 2026-06-16 | `d1-compat`: cap the **first** attempt at 12s and mark it with a matchable string, so a hung connection retries fast instead of riding to the runtime kill. The retry itself is deliberately **not** timed. | Turns an unbounded hang into a bounded one. A genuinely slow healthy query still completes. |
| **#103** (`4772d2f2`) | 2026-06-22 | One shared `TRANSIENT_CONN_RE` for **both** the retry layer and the user-facing classifier; frontend retries idempotent GETs on 503. | The two classifiers had drifted; a blip could be retried by one and surfaced as a dead end by the other. (Shipped as part of `system-foundation-coe.md` §2.) |
| **#177** | 2026-07-02 | Retry the cold-pool 503 on **mutations** too — but only that specific 503, matched on its body. | Owner hit a failed save early after idle. Safe because this 503 is raised before the handler runs, so nothing executed. |
| **#198** | 2026-07-02 | `fetchMe` stopped wiping the token on *any* boot error; only a 401 clears it. | **A cold-pool 503 on app open was logging users out of a valid 7-day session.** |
| **#201** | 2026-07-02 | Server-side: retry the cold connection up to **3×** with backoff instead of once. | *"Login after an idle period showed a 503"* — one retry was not enough to absorb a slow warm-up. |
| **#267** (`b5ae3599`) | 2026-07-04 | Client patience: `GET_RETRIES` 2→4, `COLD_POOL_RETRIES` 3→4 (~10s of spaced retries) — `frontend/src/api/client.ts:291-310`. | Rides out a typical cold window **silently** instead of dumping an error on the first tap. |
| **#268** (`4aacd79a`) | 2026-07-04 | The same widening in `frontend/src/vendor/scm/lib/authed-fetch.ts:225-250`. | **#267 had missed the path mobile actually uses.** Orders / SO / Service / Delivery / Scan go through `authedFetch`, not the core client — so the owner's surface was still failing after the fix "shipped". |

Two later changes are consequences rather than mitigations, and are listed because they show the blast radius: `retryUnlessClientError` (`frontend/src/lib/retryPolicy.ts:67`, `BUG-HISTORY.md:774`, `:962`) retries 5xx once *because Hyperdrive cold start genuinely self-heals* while refusing to retry 4xx; and `40e3e5c8` (PR **#918**, still open at `9ea3c425`) adds a bounded 60s session-liveness fallback because pure fail-closed revocation *"logged the whole company out on every brief DB blip"*.

---

## 3. What the audit RULED OUT

- **Not a Houzs code defect.** `b5ae3599` compared the two connection layers directly: Houzs `pg.ts` is a faithful port of HOOKKA's `db-pg.ts` — same `max:1`, `idle_timeout:0`, no `connect_timeout`, same 2026-06-04 revert note — and **Houzs has *more* resilience, not less** (HOOKKA's frontend has no retry layer at all). The difference is traffic volume, not code.
- **Not fixable by enlarging or retrying the connection pool — this was tried and it made things worse.** `pg.ts:77-87` records it: *"do NOT add `max>1`, `.end()`-per-request, or query retries: each caused connection churn/exhaustion when tried 2026-06-13."*
- **Not fixable by a `connect_timeout` either — also tried, also reverted.** `pg.ts:28-32`: under load a 10s cap *"turns slow-but-working queries into fast-fail 500s and blanks lists (operator sees 'all data gone' when rows are intact)"*. Shipped as an emergency revert on 2026-06-04. **Capping the connection converts a latency problem into a data-integrity-looking problem**, which is strictly worse.
- **Not copyable from HOOKKA's Hyperdrive configuration.** HOOKKA avoids much of the cold start by pointing Hyperdrive at the **6543 transaction** pooler. Houzs cannot: Hyperdrive→6543 is double-pooling and broke prod three times (`system-foundation-coe.md:82`).
- **Not the service-worker cache class.** `docs/api-fetch-hardening-coe.md` traces a prod crash to stale cached JS chunks after six rapid deploys. Adjacent (both are made worse by burst deploys) and unrelated in mechanism.
- **Not the 2026-07-05 pooler outage**, even though the user sees the identical sentence. That one lasted eighteen hours and needed a vendor-side restart — `docs/supavisor-pooler-outage-coe.md`. **Duration is the discriminator; the message is not.**
- **Not "retry harder" as a universal answer.** `BUG-HISTORY.md:1699` is explicit, and it is the most useful thing in this section: a mobile POD read that showed a wrong balance was assumed to lack a retry. It did not — `authedFetch` already gives it **up to 5 attempts over ~9.6s, under a react-query `retry: 1`, i.e. up to 10 network attempts.** *"The read is already as reliable as this codebase knows how to make it. A read that fails anyway is exactly the case that must be handled honestly, not retried harder."*

---

## 4. The part that is not about latency

A cold start is a few seconds of slowness. What makes it a COE subject is that "the read might fail" became a standing premise, and code that answered that premise carelessly produced wrong business facts:

- **A driver was shown the wrong money.** `MobilePOD.tsx` read payments as `data ?? []`, so `paid = 0` and the balance rendered as the full order total. `data` is `undefined` both when a read has not answered **and when it failed** — the coalesce collapsed "I don't know" into "this customer has paid nothing", and put that number in front of a driver collecting cash (`BUG-HISTORY.md:1698`). The entry names the cold start as *"a documented recurring condition here… not a hypothetical."*
- **Company scoping fails open on purpose during the window.** `scopeToCompany` no-ops when the active company is unresolved, which a cold start can cause. Post multi-company merge that is a cross-company **read** exposure, and it is the most likely explanation for the owner's "Houzs user sees 2990 DOs" screenshot (`BUG-HISTORY.md:264`, `:274`). Failing closed instead would blank single-company lists on every cold start. **The tradeoff is documented and deliberate; it exists only because the window exists.**

  **Corrected 2026-08-13 — the hole is now three narrow ones, not one wide one.**
  `b6c45ac2` (PR #893, 2026-07-20 — before this COE was written) made
  `scopeToCompany` FAIL CLOSED whenever the context is RESOLVED but no single
  active company could be picked: it emits `.in('company_id', [])`
  (`scm/lib/companyScope.ts`, the `scopeToCompany` comment). Separately,
  `loadCompanies` now prefers LAST-KNOWN-GOOD over a blank on a failed master
  read, "so a live multi-company context does NOT momentarily degrade to the
  cross-company fail-open" (`middleware/companyContext.ts`), and a brand-new
  isolate with no last-known-good resolves from the caller's OWN
  `user_companies` grants — one grant resolves unambiguously, several with no
  usable header set the allow-list and leave the active company unset, which
  fails closed. **What still fails open is only the case where the companies
  master AND `user_companies` are both unreadable**, which cannot be
  distinguished from a genuine single-company install. The tradeoff is real but
  it is no longer the routine cold-start behaviour this bullet described.
- **Fail-closed session revocation could not ship as designed.** PR #918 made revocation authoritative; a brief blip then logged the entire company out, because an unreachable DB propagated as an auth failure. `40e3e5c8` bounds it with a 60-second liveness cache — an explicit owner trade of revocation latency for availability.

---

## 5. What the record does NOT show

- **How often it actually fires, or for how long.** No production 503-rate metric exists. Every number here comes from a `wrangler tail` session someone happened to run, or from a code constant sized against one. The mail-sync workflow logs incidentally record prod 503s (used to bound the separate 2026-07-05 outage), but nobody has ever mined them for the routine cold-start rate.
- **Whether the mitigations reduced staff-visible failures, and by how much.** #267 and #268 shipped on the reasoning that ~10s of patience covers a typical window. Nothing measured the window's distribution before or after. The only "verification" on record is that the owner stopped reporting it.
- **What "很多次了" means numerically.** No count, no dates, no screenshots.
- **The real cold-window distribution.** 12s is one captured `[slow-query]`; ~20s is an estimate in PR #10's reasoning for the 27s cap. There is no percentile anywhere.

---

## 6. Deferred

| Item | Owner | Note |
|------|-------|------|
| **Upgrade Supabase compute off the Micro tier.** | **Owner (billing)** | The only fix that shortens the window rather than hiding it. Every software mitigation that exists has been applied. Named as the root cure in `system-foundation-coe.md:82` and unchanged since. |
| **Measure the window before tuning anything else.** | Owner | Retry counts are now sized against a single observation. `[slow-query]` already logs (`d1-compat.ts:442`); a periodic first-query timing would turn "typical cold window ~10s" from an assumption into a number. |
| **Every new client fetch path inherits the retry, or the fix misses.** | whoever adds one | #268 exists solely because #267 fixed `api/client.ts` and mobile SCM uses `vendor/scm/lib/authed-fetch.ts`. Two paths today; a third would silently be unprotected. |
| **`statement_timeout` remains unset.** | Owner | Tracked as H4 in `system-foundation-coe.md:62`, unresolved: a stuck pooler can hang the Worker, but any cap touches the frozen config and the 2026-06-04 incident warns exactly against that. A generous server-side value (≫ real query times) was recommended and deliberately not applied unilaterally. |
| **Do not burst-deploy.** | everyone | Each deploy resets the pool (`docs/DEPLOY-USER-MGMT.md:8-10`). Burst deploys multiply the cold windows — and, separately, churn the SW cache (`api-fetch-hardening-coe.md`) and can discard the build entirely (`deploy-collision-coe.md`). Three unrelated hazards, one habit. |

---

## 7. Lessons

1. **`backend/src/db/pg.ts` is frozen, and "frozen" is a verifiable claim here, not a slogan.** Its last functional change is `b5922f36`, **2026-06-13 — 3,112 commits ago** on `main` (re-measured 2026-08-13; the figure here read 1,767 when written — `git rev-list --count b5922f36..origin/main` is the check, and the point is the distance, not the number). Every parameter in it is a scar: `prepare:false` (HOOKKA, 2026-04-27), no `connect_timeout` (emergency revert, 2026-06-04), `max:1` with no per-request `.end()` and no driver-level retries (churn/exhaustion, 2026-06-13), never cache the client across requests (`system-foundation-coe.md`'s cross-context I/O bug). **The cold start is the symptom this file is most tempting to "fix", and the three most obvious fixes have each already caused a worse outage.** Change the client's patience, the pool's warmth, or the compute tier — not this file.
2. **A retry belongs where the request has not yet executed.** Every safe retry in this system rests on one property: the cold-pool 503 is raised by the connection layer *before* the handler runs, so nothing happened and re-running cannot double-write. That is why even mutations may retry that specific 503 (#177), and why `TRANSIENT_CONN_RE`'s comment forbids adding any real SQL error to it. **Check "did this reach the server?" before adding anything to a retry set.**
3. **Fix the path the user is actually on, and prove which one that is.** #267 was correct, complete, and invisible to the owner, because his screens fetch through a different helper. A fix that ships to a path nobody uses reads exactly like a fix that worked.
4. **`?? []` and `?? 0` are how a latency problem becomes a money bug.** `undefined` means both "not answered yet" and "failed", and the coalesce destroys the only discriminator — the error. In a system where reads *are documented to fail transiently*, defaulting a failed read to an empty value is not defensive coding, it is asserting a fact you do not have. Three separate money bugs in one day traced to this (`BUG-HISTORY.md:2204`).
5. **A message written for a three-second event will be reused for an eighteen-hour one.** *"The database is briefly unavailable. Please try again in a moment."* is honest here and misleading in `docs/supavisor-pooler-outage-coe.md`. Nothing in the product distinguishes them, so **the operator's rule has to be: a transient message that outlives a minute is not transient.**
6. **The comparison that ended the speculation was "what is different about HOOKKA?", answered by reading both files.** It was not a code difference; it was traffic. Diffing the sibling system took one session and closed off every "our connection layer must be wrong" theory that would otherwise have been re-litigated — and, per lesson 1, acted on destructively.

---

## See also

- `backend/src/db/pg.ts:22-36` — the hard-won rules, each with the date of the incident that produced it.
- `backend/src/db/d1-compat.ts:198-239` — the first-attempt timeout, the fresh-client retry, and `TRANSIENT_CONN_RE`; `:421` — the 3-attempt retry from #201.
- `backend/src/index.ts:307-308` (the 503) and `:348-352` (the keep-warm cron).
- `frontend/src/api/client.ts:291-310` and `frontend/src/vendor/scm/lib/authed-fetch.ts:225-250` — the two client retry paths that must stay in step.
- `docs/system-foundation-coe.md` §1 and §4 — the 2026-06-22 incident this one hands off to, and the compute-tier decision.
- `docs/supavisor-pooler-outage-coe.md` — the eighteen-hour outage wearing this incident's error message.
- `BUG-HISTORY.md:3434` — the one-line prior record; `:264`, `:274`, `:1698`, `:1699`, `:2204` — the correctness consequences.
