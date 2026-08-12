# COE — the staging bench stopped deploying, and its nightly proof went on passing

**Date** — discovered 2026-08-12. The fault began **2026-07-30**.

> **Correction, 2026-08-12.** The first version of this COE said the token had
> been failing "since the day it was set, 2026-07-01". That is false, and it was
> false in the source this file copied it from. The owner refused it on sight —
> *"staging environment 怎么可能没有 set 过 cloudflare"*, *"之前 staging 都没问题的"* —
> and he was right. See *How this COE got its own root cause wrong* below. The
> corrected timeline is the one stated here.

## Trigger

Nobody reported this. There was nothing to report — that is the whole point of
the entry.

A routine question ("do we have staging?") found that
`https://autocount-sync-api-staging.houzs-erp.workers.dev/health` and
`https://houzs-erp-staging.pages.dev` both answer **200**, the Worker, the
Pages project, the isolated Supabase, the isolated KV and the isolated queues
all exist — and the last time any of it was **built from `main` was
2026-07-29 16:20 UTC**.

By 2026-08-12 `main` was **775 commits and 59 production migrations** further
on. Meanwhile the nightly **Staging E2E (smoke)** had reported `success` every
single night: 08-04, 08-05, 08-06, 08-07, 08-08, 08-09, 08-10, 08-11, each in
about 90 seconds, each running real browser proofs of login, the SO list and
company isolation.

Those proofs were true. They were proving that a two-week-old build still
worked.

## Root cause, traced with evidence

The tool that proved it: **`gh run list --workflow deploy-staging.yml`**, and
then a live `workflow_dispatch` of that workflow from `main` — run
**31566944717**, 2026-08-12 05:33 UTC — which reproduced the failure on
demand rather than inferring it from history.

The chain, each link checkable:

1. **The token worked for four weeks.** It was set in the GitHub **Staging**
   environment on 2026-07-01 (`updated_at 2026-07-01T08:24:58Z`, unchanged
   since) and Deploy (Staging) succeeded repeatedly on it. The last success is
   run 30470280714, **2026-07-29 16:20 UTC**.
2. **It stopped working overnight on 2026-07-30.** The first failure is run
   30518266259 at 06:00 UTC, and its log carries the same pair the run today
   does: `A request to the Cloudflare API (/accounts/***/workers/services/
   autocount-sync-api-staging) failed. Authentication error [code: 10000]`,
   then, on wrangler's fallback identity call,
   `A request to the Cloudflare API (/accounts) failed. Invalid access token
   [code: 9109]`. The frontend job failed identically against
   `/pages/projects/houzs-erp-staging`. Nothing in GitHub changed — the secret's
   `updated_at` still reads 2026-07-01 — so **the credential was revoked or
   expired on the Cloudflare side**, some time between 2026-07-29 16:20 and
   2026-07-30 06:00.
3. On **2026-07-31** the push trigger was narrowed from `[main, staging]` to
   `[staging]` alone, at the owner's instruction ("暂时不需要staging的"). The
   reasoning written into the file is sound and worth keeping: a permanently-red
   workflow is not free, it trains everyone to ignore red, and that is exactly
   how a two-hour production deploy outage went unnoticed the same day.
4. **But the `staging` branch is not maintained.** It last moved 2026-07-14 and
   sits 1,911 commits behind `main` (6 ahead). With `main` removed from the
   trigger list and nobody pushing to `staging`, the workflow simply stopped
   being invoked. It went from red to *silent*.
5. **Staging E2E kept running anyway**, because its triggers are
   `workflow_run` after a deploy, `workflow_dispatch`, **and a nightly
   `schedule`**. The schedule needs no deploy. It pointed at the still-running
   2026-07-29 stack and passed, correctly, every night.
6. Nothing made the staleness visible. Prod's deploy stamps the Worker with
   `--var GIT_SHA:${{ github.sha }}` and the **deploy-watchdog** workflow
   compares that stamp against `main` every 15 minutes, precisely so a stale
   prod is caught. `deploy-staging.yml` never added the stamp, so staging's
   `/health` answers `{"ok":true,"sha":null}` — from outside there is **no way
   to tell which commit staging is running**, and no watchdog looking.
7. Re-dispatched from `main` today, both jobs got all the way to the deploy and
   failed there, with the identical signature. **The token has been dead for two
   weeks and is still dead.**

**The token is invalid, not under-scoped — which changes the remedy.** The run
log carries two codes, and the second is the specific one:

```
A request to the Cloudflare API (/accounts) failed.
  Authentication error [code: 10000]
  Invalid access token [code: 9109]
```

`9109` means the credential itself is not a valid token — revoked, expired or
malformed. It is not a permissions refusal. Every note written about this so far,
including `deploy-staging.yml`'s own comment and the roadmap's step 2, described
the fix as a token "carrying the same scopes as the working Production one",
which reads as though editing the existing token's permissions would fix it. It
will not. **A new token has to be minted;** the scopes matter only once it is a
valid one.

## What this cost

Nothing broke. What was lost is the *option* to not break things:

- `docs/SECURITY-DX-ROADMAP.md` names the staging bench as **the one structural
  thing that unlocks the rest** — splitting the 12k-line files, the persistent
  access-audit, the PITR restore drill. All of them are gated on a bench that
  has not been current since 2026-07-29.
- `docs/inventory-ledger-divergence-coe.md` defers the FIFO ledger fix as
  explicitly **staging-first**. It cannot start.
- Three switches in `backend/wrangler.toml` — `SESSION_FALLBACK_ENABLED`,
  `HOUZS_OWNS_2990`, `COSTING_DISPLAY_ENABLED` — each carry a comment telling
  the next operator to rehearse the flip on staging before touching prod. The
  AutoCount cutover resumes Friday with those rehearsals unavailable.

## What this audit RULED OUT

- **"Staging was decommissioned."** Refuted. Every binding is still declared in
  `[env.staging]`, both public URLs answer 200 today, and the KV namespace,
  the dedicated `houzs-scan-ocr-staging` queues and the separate Supabase
  project all still exist. Nothing was torn down; it was left running.
- **"The nightly E2E is fake, skipped, or `continue-on-error`."** Refuted.
  `staging-e2e.yml` sets `continue-on-error: false` deliberately and the runs
  complete in 80–100 seconds with real assertions. The suite is honest. It was
  asked a question about an environment, not about `main`, and it answered that
  question correctly.
- **"The token was working and was revoked recently."** The first version of
  this COE marked this REFUTED, citing `deploy-staging.yml`'s comment that the
  token had failed since it was set on 2026-07-01. **That was the wrong call and
  this is now CONFIRMED.** The run history shows Deploy (Staging) succeeding on
  that same token for four weeks, last at 2026-07-29 16:20; the first failure is
  2026-07-30 06:00. The credential died on Cloudflare's side while the GitHub
  secret sat untouched. Recorded rather than quietly edited, because a
  ruled-out section that was itself wrong is the most expensive kind of error in
  this document — it is the section written to stop the next person re-checking.
- **"Pausing the workflow was the wrong call."** Not refuted — it was the right
  call for the reason given. The defect is not the pause; it is that pausing a
  deploy left a *scheduled proof of that deployment* still running and still
  green, with no stamp by which anyone could tell the two had come apart.

## The same fault, in a second place, found the same hour

Looking for the staging evidence turned up an independent instance of the
identical class, which is why this COE covers both: the lesson is the shared
part.

`docs/generated/codebase-map-facts.md` is the mechanical inventory that
`CODEBASE-MAP.md` defers to precisely so the numbers "cannot drift". On
2026-08-12 it claimed 122 route modules, 164 pg migrations and a highest
migration of `0163`. The tree really held **135 route modules, 279 pg `.sql`
files and `0281`** — 116 production migrations missing from the inventory that
exists to be authoritative about migrations.

The timeline is exact:

| when | what |
|---|---|
| 2026-07-21 22:28 | `#963` writes `gen-codebase-map.mjs` and generates the facts file **once** |
| 2026-07-22 10:03 | `#925` upgrades the test toolchain and renames `backend/vitest.config.ts` to `vitest.config.mts` |
| ever since | the generator dies on `ENOENT ... vitest.config.ts` at line 162, before writing anything |

The generator was broken **eleven hours and thirty-five minutes after it was
born**, and the file it produced in that window stood as current for three
weeks.

Why nothing caught it: `audit:map` — the drift check — *is the same script with
`--check`*, so it crashed too, and `CODEBASE-MAP.md` documents, deliberately and
for a good reason, that it is NOT a CI or deploy gate (its sibling `audit:routes`
is a gate and jammed prod twice in one day). A check that is non-blocking by
design has nothing left to notice when the check itself dies.

The control case proves the point rather than undermining it. Regenerating all
three artifacts on 2026-08-12 found `route-capability-matrix.csv` and its
summary **byte-identical** — because `audit:routes` gates them on every CI run
and every deploy. The two that had rotted, `codebase-map-facts.md` and
`route-locator.md`, are exactly the two nothing gates.

## Fixes

| Change | Effect |
|---|---|
| `gen-codebase-map.mjs` resolves the vitest config across `.mts` / `.ts` / `.js` and exits with a named error instead of an ENOENT stack | the generator runs again; the next rename reports which filename to add rather than silently freezing the inventory |
| `codebase-map-facts.md` and `route-locator.md` regenerated | 122 -> 135 route modules, 923 -> 1037 endpoints, 125 -> 142 desktop routes, and the migration table finally reads 279 / `0281` instead of 164 / `0163` |
| `deploy-staging.yml` stamps `--var GIT_SHA:${{ github.sha }}` on the Worker deploy | staging `/health` stops answering `sha:null`; the build staging is running becomes readable from outside, the same way prod's is |
| `staging-e2e.yml` reports the stamp it tested against | a green nightly run now says WHICH commit it proved, so "green" can never again mean "green about something two weeks old" |
| `docs/SECURITY-DX-ROADMAP.md` step 2 rewritten | it claimed "Staging exists" as though that were the remaining work; it now records that staging exists, is stale, and names the token as the single blocker |
| `CLAUDE.md` gains a **do not guess** rule, ahead of the other mandatory ones | the existing `traced, not guessed` wording lives in the BUG-HISTORY and COE rules, which both govern the WRITE-UP only. Guessing was legal until the write-up, and a guessed fix could still be reported in confident "traced" language. The new rule governs the ACT — state the hypothesis, name what would refute it, go observe that, then fix — and requires every claim to the owner to be labelled PROVEN / LIKELY / UNKNOWN. Raised by the owner on 2026-08-12: *"我要确定的答案，有时找 bugs 都是猜的，很不好."* |

## The state this left staging in, 2026-08-12

The dispatch was not a no-op, and the shape of the failure matters: the
migration step runs BEFORE the Worker deploy.

| step | outcome |
|---|---|
| `audit:routes`, `audit:job-types`, `audit:work-order-states`, `typecheck`, `npm test` | all passed (28m35s — this workflow runs the suite unsharded, unlike prod's) |
| Apply staging migrations | **passed. `278 migration(s), 245 applied, 50 pending` -> 50 APPLIED, 0 failed** |
| Deploy the Worker | failed, `9109` |
| Frontend Pages deploy | failed the same way |

So staging now runs a **schema from `main` against code from 2026-07-29** — the
database moved forward, the Worker and the SPA did not. That is tolerable and
was the right trade to take: these migrations are additive and idempotent by
convention, staging carries no real users, and one successful deploy after the
token is replaced closes the gap in the correct direction. It is recorded here
so nobody later reads a schema-versus-code mismatch on staging as a new fault.

One thing it proved in passing: the staging Supabase is **awake and reachable**.
`deploy-staging.yml` carries a retry ladder specifically because the free tier
can auto-pause; it applied 50 migrations on attempt 1 of 3.

## How this COE got its own root cause wrong

The first version of this document named the wrong root cause, and the way it
did so is worth more than the fix.

`deploy-staging.yml`'s trigger comment, written 2026-07-31, said the token had
been failing "since it was set on 2026-07-01". Whoever wrote it had the token's
`updated_at` (2026-07-01) and a workflow that was failing, and reasoned from the
two to a start date. They did not open the run history — which was one command
away and shows four weeks of green.

This COE then **quoted that comment as evidence**, and even wrote a "ruled out"
row on the strength of it. Worse, the contradiction was already inside this same
file: it stated the last successful deploy as 2026-07-29, four weeks AFTER the
date it claimed the token had never worked. Rather than treat that as a
refutation, the draft explained it away — "which predates the token, i.e. the
last good staging deploy was made by whatever credential was in place before" —
inventing an unevidenced earlier credential to keep the story standing.

The owner rejected it in one line: *"staging environment 怎么可能没有 set 过
cloudflare"* — *"之前 staging 都没问题的"*. He was right, and the check took two
commands: list the runs, read the first failing one's log.

Three failures, none of them technical:

1. **A note in a repo was treated as an observation.** It was somebody's
   inference, written in a hurry, with no tool named beside it. `CLAUDE.md`
   demands "name the tool that proved it" for exactly this reason, and the
   comment named none.
2. **A contradiction inside the same document was smoothed over instead of
   chased.** The evidence to refute the claim was already in the file. When two
   facts you hold disagree, one of them is wrong — that is a finding, not a
   presentation problem.
3. **The "ruled out" section was written from the same bad premise**, which is
   the most costly place to be wrong: that section exists so nobody re-checks.

This is the case the new *Do not guess* rule in `CLAUDE.md` was written for, and
it was written the same day this file got it wrong — which is the point. The rule
does not protect a document from being wrong; it only helps if the observation is
actually made.

## Deferred — owner

**Minting a NEW Staging `CLOUDFLARE_API_TOKEN` is the only thing that unblocks
this, and only the owner can do it.** Note the verb: `9109` says the current
value is not a valid token, so widening its permissions in the Cloudflare
dashboard will not help — create a fresh one, scoped like the working Production
token (Account → Cloudflare Pages:Edit, Workers Scripts:Edit). It must be
entered directly into the GitHub **Staging** environment secrets — never through
a chat transcript.

Until then, `main` deliberately stays OUT of the `deploy-staging.yml` trigger
list. Putting it back while the token is bad would recreate the
permanently-red workflow the pause was correct to remove. The order is: new
token → `workflow_dispatch` to prove it → then restore `main` to the trigger.

## Lessons

1. **A scheduled check that outlives the thing it checks becomes a lie.** The
   E2E's trigger set (`workflow_run` OR `schedule`) was written so the proof
   would survive a deploy failure. It did — and that is the bug. A proof of a
   deployed environment must fail, or at minimum announce itself as stale, when
   the deployment behind it stops happening.
2. **Permanently-green is more dangerous than permanently-red.** This file's
   sibling lesson is already written in `deploy-staging.yml`: red trains people
   to ignore red. What the pause produced was worse, because green trains nobody
   to look at all. Both are the same fault — a signal that no longer tracks
   reality — and the second one has no symptom.
3. **An inherited note is not evidence.** This COE's own first draft got its
   root cause from a comment in a workflow file and passed it on as fact,
   including into a "ruled out" row. A repo note carries whatever confidence its
   author had, which is often none — and once copied it reads as settled. Copy
   the CHECK, not the conclusion. When a document states a cause without naming
   the tool that proved it, that is a hypothesis wearing a fact's clothes.
4. **A check that is non-blocking by design needs its own liveness signal.**
   Both faults here are the same shape: something was made deliberately unable
   to fail loudly — the E2E so a deploy failure would not hide it, `audit:map`
   so a stale doc could never block a deploy — and both decisions were correct
   in isolation. The cost neither accounted for is that a check which cannot go
   red also cannot report its own death. If a signal is exempt from gating, then
   something must still answer "when did this last actually run, and against
   what?" The gated artifact in the same directory stayed byte-perfect for three
   weeks; the two ungated ones rotted.
5. **Every deployed surface needs a version stamp, not just production.** Prod
   has `GIT_SHA` and a watchdog because prod was overwritten by a stale clone
   four times. Staging was given neither, so the identical failure was
   undetectable there. The stamp costs one flag.
6. **Pausing a workflow is a change to a system, not a decision to defer one.**
   The pause was recorded thoroughly and honestly in the file itself — and still
   nothing recorded what the pause did to the *other* workflow that depended on
   it. When switching something off, name what was relying on it being on.

## See also

- `docs/SECURITY-DX-ROADMAP.md` — why the bench gates the rest of the work
- `docs/inventory-ledger-divergence-coe.md` — the deferred fix that is
  staging-first and therefore blocked
- `.github/workflows/deploy-staging.yml` — the trigger comment carries the
  token history and the restore procedure
- `docs/deploy-collision-coe.md` — the prod-side incidents that bought the
  `GIT_SHA` stamp and the watchdog staging never got
