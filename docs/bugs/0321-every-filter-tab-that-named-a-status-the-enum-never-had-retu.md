## Every filter tab that named a status the enum never had returned 500, and its count silently read 0 [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** In BOTH companies: Sales Invoice `Sent`, `Partial` and `Paid` each
answered 500, and all four of its pill counts read 0 beside a list whose `all`
count read 1. Delivery Order `Delivered` answered 500, and its pills did not sum
to All — 25 of 27 delivered orders were unreachable in Houzs Century, 12 of 36
in 2990's Home. Nothing on screen looked broken; the numbers looked settled.

**Root cause (traced).** `SI_STATUS_BUCKETS` carried `ISSUED`, `PARTIAL` and
`COMPLETED`; `DO_STATUS_BUCKETS` carried `COMPLETED`. A comment described them as
a "backward-compatible fallback" for raw DB statuses. They are not: `status` is a
Postgres enum on both tables, so the column could never have held any of them,
and `.in('status', …)` handed the label straight to Postgres — `invalid input
value for enum sales_invoice_status: "ISSUED"`. The second half is what hid it:
each count query destructured `count` and dropped `error`, so `count ?? 0`
rendered a *failed read* as a real zero. `OVERDUE` and `CLOSED` were the mirror
fault — genuine enum members in no bucket at all, counted in `all` and shown in
no tab.

**Fix.** Non-members removed; `OVERDUE` joined the SI `sent` bucket and `CLOSED`
the GRN `posted` bucket, matching the fallback both frontends already applied.
`lib/status-counts.ts` `readStatusCounts()` now answers 500 `status_counts_failed`
naming the failing bucket instead of serving 0, wired into all five list
endpoints. `tests/statusBucketsEnumMembership.test.mjs` derives the enum from
`scripts/scm-schema/*.sql` plus every `ALTER TYPE … ADD VALUE` migration rather
than a hand-copied list, asserts both directions for every bucket map, and fails
if a `*_STATUS_BUCKETS` map appears under `backend/src` whose enum it does not
know. `tests/statusCountsFailLoud.test.mjs` pins that every list's count read
reports rather than degrades. Both are in `MUST_GATE_MERGE`.

Ref: PR #2382, 2026-08-18. Verified against production before and after.
