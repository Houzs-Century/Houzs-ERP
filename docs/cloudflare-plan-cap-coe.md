# Houzs ERP — Cloudflare Free-Plan Cap COE (Correction of Error)

**Date:** not established. Bounded by evidence to **after 2026-04-30 and no later than 2026-07-04** — see §3.
**Trigger (as reported):** mass HTTP 500s across production with `Usage limit exceeded`, under real load.
**Status:** Resolved. Production is on Workers Paid.

> **Read this first — this COE is held to a lower evidentiary standard than the others in this directory, and says so on purpose.**
> `system-foundation-coe.md` and `docs/deploy-collision-coe.md` reconstruct their incidents from commits, migrations, workflow files and PR timestamps. This one cannot. The incident is attested by **exactly one line, written from memory a month after the fact**, and the repository contains **no primary artefact of it** — no commit, no PR, no configuration diff, no date. What follows separates, explicitly, what is attested from what is corroborated from what is unknown. **Do not cite the unknowns as established.**

---

## 1. What is attested

`BUG-HISTORY.md` line 3422, in full:

> **Mass 500s / "Usage limit exceeded"** — Cloudflare **FREE Workers plan** daily caps hit under real load. Fix: upgrade to Workers Paid. (Also: GitHub Actions budget block on a private repo → made repo public = free/unlimited.)

That is the entire record. Its provenance matters:

- It was added by `291d681a` (2026-07-14 13:57 MYT), merged as **PR #449**, whose body describes itself as backfilling *"from memory + the COE docs"*.
- It sits under the section heading `## Earlier (2026-06 → 07, backfilled 2026-07-14 from memory / COE docs / git)`, whose own subtitle reads: *"Historical entries reconstructed after the fact — **dates approximate**, refs to the COE docs where a full write-up exists."*
- `git log -S "Usage limit"` and `git log -S "Workers Paid"` across all refs return **only** that backfill commit and two later commits that merely move the file. Nothing else in the history has ever mentioned it.

So the source is a single deliberate act of remembering, by someone who was there, recorded under a mandatory bug-log rule. That is worth writing down — it is exactly the knowledge this backfill exists to rescue. It is not the same thing as a traced root cause, and this document does not present it as one.

---

## 2. What the audit could NOT establish

- **Which limit.** The entry says "daily caps". Cloudflare's Workers free plan enforces several independent limits, and they fail differently: a **daily request cap**, a **per-request subrequest cap**, and **CPU-time limits**. Nothing in the repo identifies which one was hit, and the symptom "mass 500s" does not discriminate between them.
- **The date.** Not recoverable. §3 brackets it; that is the best the record supports.
- **The user-visible symptom, beyond the quoted phrase.** No screenshot, staff report, or `wrangler tail` capture survives — contrast `system-foundation-coe.md` §1, where the exact error string was caught live in tail and is quoted.
- **What changed, concretely.** "Upgrade to Workers Paid" is a Cloudflare dashboard billing action. It leaves **no trace in this repository by design**, which is why this COE is thin and why no amount of further git archaeology will thicken it.
- **Whether it recurred.** Unknown.

---

## 3. What CAN be corroborated from the repo

Two artefacts bracket the plan change. Both rely on an external fact about Cloudflare's product tiers, stated here explicitly so a future reader can re-check it rather than inherit it:

**Lower bound — the account was on FREE as of 2026-04-30.** The evidence is `7b98025b` (2026-04-30, *"fix(cron): fold monthly gifting reset into daily 02:00 batch"*) — a commit that **reduced the number of cron triggers to stay under a free-plan ceiling** — and the comment it left in `backend/wrangler.toml`: `# Cron schedule (kept under the Workers free-plan trigger cap).` The config carries three crons to this day.

> **Corrected 2026-08-13: that comment is GONE, and this paragraph used to
> claim the opposite.** It read *"`backend/wrangler.toml:179` still reads …"*
> and *"nobody removed it when the plan changed"*. Somebody did:
> **`a4b186f9` (PR #974, 2026-07-21 23:49)** rewrote the clause into the
> self-retiring prose now at `backend/wrangler.toml:250-262`, seventy minutes
> after the `9db13349` this document pins as its as-of. §5 row 2 recorded the
> rewrite; §3 was never updated, so the two sections contradicted each other on
> the same line of the same file. **The lower bound now rests on `7b98025b`'s
> own diff, not on a surviving comment** — which is the stronger source anyway.
> Line `:179` today is inside the `[[queues.producers]]` block.

**Upper bound — the account was on Workers Paid by 2026-07-04.** `backend/wrangler.toml:131-140` binds a Cloudflare Queues producer and consumer (`houzs-scan-ocr`), added by **PR #260** (`3112c6da`, 2026-07-04, *"feat(scan): move background OCR onto Cloudflare Queues"*), with the note *"Queue + DLQ already created on the account."* **Cloudflare Queues is a Workers Paid product** — it cannot be created or bound on the free plan. The queue exists and production uses it, so the account was Paid by then.

**The GitHub Actions half of the entry is independently supported.** `gh repo view hello-houzs/Houzs-ERP` returns `visibility: PUBLIC` for a repo created 2026-04-08 — consistent with the stated remedy, since public repositories get unmetered GitHub-hosted Actions minutes on standard runners while private ones draw on a paid budget. And Actions cost was demonstrably a live pressure on this project: `7717cf78` (2026-07-11) records that *"the July 5 Supabase outage retry-storm + high push frequency burned ~4,900 Actions minutes in a week (limit 3,000/mo)"* — which is the same budget squeeze, still biting after the visibility change, and solved that time by path-filtering the deploy rather than by billing.

**Neither bound proves the outage.** They prove a plan change happened in that window. The outage is attested only by §1.

---

## 4. A related free-plan limit that IS fully documented — and is NOT this incident

The repository contains a detailed, traced record of a Cloudflare Workers free-plan limit causing a wrong answer in production. It is a **different limit** and a **different system**, and it must not be conflated with the entry in §1.

`backend/src/scm/routes/mfg-sales-orders.ts:1973-1976`:

> `Loo 2026-06-06 (SO-2606-025 incident) — a FAILED query is not a missing order. This used to swallow the error and report "Order was not found" for a real SO when the CF Workers free-plan subrequest cap killed this exact fetch (#51 of 50). Surface it as retryable instead.`

That is the **per-request subrequest cap** (50 on free), not a daily cap. The symptom was not a 500 — it was worse: a swallowed error rendered as a confident, wrong business answer, telling a user a real sales order did not exist. The named incident is **2990's**, on 2026-06-06, fixed by Loo. It reached this tree on 2026-06-18 when `5d384d6d` ported 2990's SCM backend wholesale, so **Houzs inherited the mitigations without having suffered the incident.**

Those mitigations are load-bearing and pervasive — the "subrequest diet" is designed into the SO write path:

| Site | What it protects |
|------|------------------|
| `scm/lib/mfg-pricing-recompute.ts:612` | per-line reads *"blew the CF Workers per-request subrequest cap"* — now batched |
| `scm/lib/mfg-pricing-recompute.ts:742,787` | fabric-code and fabric-library lookups, hoisted out of the per-line loop |
| `scm/lib/allowed-options-check.ts:314` | per-line loader cost 2 subrequests per line — collapsed |
| `scm/routes/mfg-sales-orders.ts:3230,3538` | *"a 6-item order blow the CF Workers subrequest cap"*; catalogue loaded ONCE per request |
| `scm/routes/suppliers.ts:920` | collapsed to a single `.in(purchase_order_id, [...])` batch |
| `scm/lib/free-gift-reconcile.ts:65` | *"Both batched — never per-line"* |
| `scm/routes/unbilled-deliveries.ts:250-253` | ~1 subrequest per 200 DOs, with the budget reasoned out in the comment |
| `frontend/src/vendor/scm/lib/delivery-planning-queries.ts:493` | avoids fanning a page render into a burst of Worker subrequests |

**Why this matters for the future:** those comments all justify themselves by naming a **free-plan** cap. If the account is now on Workers Paid — as §3 indicates — the ceiling they are defending against is 1,000 per request, not 50. Somebody will eventually read one of these comments, check the plan, conclude the constraint is obsolete, and un-batch a hot loop. **The batching is still correct** (it is also a latency and cost win against PostgREST), but its stated justification has expired. See §5.

---

## 5. Deferred

| Item | Owner | Note |
|------|-------|------|
| **Confirm the current Cloudflare plan and record it somewhere durable.** | Owner (billing) | Everything in §3 is inference from product-tier requirements. One line in `docs/ARCHITECTURE.md` stating the plan and the date it changed would retire the guesswork permanently. |
| **DONE — `backend/wrangler.toml:250-257` already records that the "free-plan trigger cap" clause is retired.** | — | Re-checked 2026-08-13. The clause was corrected and now retires itself in prose, citing the `houzs-scan-ocr` Queues producer/consumer binding as PAID-plan evidence, and the three-cron schedule is unchanged. Line `:179` is a `[[queues.producers]]` block, not the line this row describes — the reference drifted. Nothing to do. |
| **Re-justify the SCM subrequest diet on latency/cost grounds, not plan grounds.** | Owner / whoever next touches SCM pricing | The batching should stay. Its comments should stop citing a cap that no longer binds, so nobody "cleans up" an obsolete-looking constraint and re-introduces a 50-subrequest fan-out. |
| **Nothing in this system watches Cloudflare usage.** | Owner | `GET /api/admin/health/*` covers the Worker, the DB and the ledger; there is no signal for account-level platform quota. Whatever the limit was, the first notification was staff seeing 500s. |

---

## 6. Lessons

1. **A limit that lives in a billing dashboard leaves no trace in the repository — so it must be written down deliberately, at the time, or it is lost.** Every other incident in `docs/` was reconstructible from commits and migrations. This one was not, and the only reason it is known at all is that somebody typed one sentence into `BUG-HISTORY.md` a month later. **That is the rule working. It is also the thinnest the rule can work.** When the fix is a click in a vendor console, the commit that would normally carry the story does not exist — write the entry the same day, with the date, the exact limit, and the observed symptom.
2. **"Mass 500s" is a symptom this system produces from at least four unrelated causes**, and the phrase alone identifies none of them: cross-request I/O on a shared isolate (`system-foundation-coe.md`), Hyperdrive cold-start and pooler exhaustion (`api-fetch-hardening-coe.md`), `NOT NULL` columns whose defaults were dropped at the PG cutover (`pg-migration-dropped-defaults-coe.md`), and a platform quota (this one). **A bug entry that records only the symptom is nearly worthless a month later.** Record the error string, the surface, and how you told it apart from the other three.
3. **Cite the limit, not just the plan.** "Free plan caps" is not actionable. Requests-per-day, subrequests-per-request and CPU-per-invocation fail in different places, are hit by different traffic shapes, and are mitigated in completely different ways — as §4 shows, this codebase carries a whole architectural discipline built to respect *one specific* free-plan number.
4. **When a constraint expires, its mitigations do not automatically become wrong — but their comments do.** Nine sites in the SCM tree justify batching by naming a free-plan cap that the account has since bought its way past. Leaving the reasoning uncorrected is how a correct pattern gets deleted by a well-meaning future cleanup.
5. **Cost limits are availability limits.** A billing ceiling took production down, and separately an Actions budget nearly took the deploy pipeline down (`7717cf78`). Neither is a code defect and neither shows up in any health check this system has. **Treat vendor quotas as part of the availability surface, not as an accounting concern.**

---

## See also

- `BUG-HISTORY.md` line 3422 — the sole primary source, and its "reconstructed after the fact, dates approximate" caveat at `:3414-3416`.
- `backend/wrangler.toml:250-262` (the `[triggers]` clause that retires the free-plan cap in prose — it replaced the comment this document used to cite at `:179`), `:178-186` (the `houzs-scan-ocr` Queues producer/consumer — the Paid-plan upper bound).
- `backend/src/scm/routes/mfg-sales-orders.ts:1973-1976` — the fully-traced *subrequest*-cap incident, inherited from 2990, which this document is careful **not** to claim as the Houzs incident.
- `docs/system-foundation-coe.md`, `docs/api-fetch-hardening-coe.md`, `docs/pg-migration-dropped-defaults-coe.md` — the other three producers of "mass 500s".
