## The SO price floor reached the operator in the rule's own words, with no action [low]

<!-- area: Sales orders + pricing -->

**Symptom.** An operator who tripped `so_total_below_original` was shown
"Changes cannot reduce the bill below the original sales order total." — the
backend's internal `reason`, describing the RULE and naming no action.

**Root cause (traced).** `so_total_below_original` had **zero** occurrences
anywhere under `frontend/` — no `ERROR_CODE_MESSAGES` entry in
`authed-fetch.ts` — so `humanApiError` fell past step 1 (curated code) to step 2
(echo the server's `reason`). Note the correction to the original report: it was
not the generic 422 fallback, it was the raw rule text.

**Fix.** A curated entry that says what to DO ("Put the amount back, or have a
manager approve the lower price first"), in the house style of its neighbours.

**Ref.** feat/so-multi-add-lines, 2026-08-16.
