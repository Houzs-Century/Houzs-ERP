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

**`all` goes through `getAll`, and per `services/pull.ts:29` it does NOT touch the
checkpoint.** That is what makes a backfill safe: it cannot disturb an incremental
pull that is working correctly. Re-running is safe too — the INSERT is
`ON CONFLICT(doc_no) DO UPDATE`, so rows refresh rather than duplicate.

**Worked example, 2026-08-19.** A salesperson could not raise a Service Case
against `SO-005263`. The order exists in AutoCount. The read-only check reported
`pull_checkpoint` CURRENT, 3281 rows in the mirror, newest `SO-013275` — and zero
rows for that number *or* its bare digits. Nothing was broken. That order had
simply never been collected, and only `mode=all` could bring it in.

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
