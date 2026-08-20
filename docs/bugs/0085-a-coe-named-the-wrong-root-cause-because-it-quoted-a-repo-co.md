## A COE named the wrong root cause because it quoted a repo comment instead of the run history [medium]

**Symptom** - the staging COE, the roadmap, `deploy-staging.yml` and a
BUG-HISTORY entry all stated that the Staging `CLOUDFLARE_API_TOKEN` had been
failing "since the day it was set, 2026-07-01". The owner rejected it on sight:
*"staging environment 怎么可能没有 set 过 cloudflare"*, *"之前 staging 都没问题的"*.

**Root cause (traced, not guessed)** - `deploy-staging.yml`'s trigger comment,
written 2026-07-31, inferred the start date from the secret's `updated_at`
(2026-07-01) plus the fact that the workflow was failing. Nobody opened the run
list. `gh run list --workflow deploy-staging.yml` shows Deploy (Staging)
succeeding on that same token for four weeks — last success run 30470280714,
2026-07-29 16:20 UTC — and the first failure, run 30518266259 at 2026-07-30
06:00, already carries `Invalid access token [code: 9109]`. The credential died
on Cloudflare's side; the GitHub secret was never touched.

The COE then quoted that comment as evidence and built a **"ruled out"** row on
it, marking "the token was working and was revoked recently" as REFUTED — the
one thing that was actually true. The contradiction was already inside the same
document (it stated the last good deploy as 2026-07-29, four weeks after the
date it claimed the token had never worked) and was explained away with an
invented earlier credential rather than chased.

**Fix** - corrected in all four places, with the old claim left visible rather
than silently overwritten, since a wrong "ruled out" row is what stops the next
person re-checking. Added as lesson 3 of the COE: *an inherited note is not
evidence — copy the CHECK, not the conclusion.*

**Ref** - `docs/staging-truth-and-map-refresh`, 2026-08-12

---
