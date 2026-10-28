# ASSR e2e tests

Playwright suite that runs a full service-case lifecycle with **staff** and **customer** browser contexts side by side in a single run.

## What it covers

| # | Scenario | Duration |
|---|---|---|
| Smoke | Auth + endpoint reachability | ~5s |
| Lifecycle | 14-act end-to-end case journey | ~60–90s |

The lifecycle spec mirrors the manual walkthrough one-for-one:

1. Supplier setup (idempotent — reuses or creates `[E2E] Test Upholstery`)
2. Staff creates a case via the UI with 3 photo uploads
3. Staff generates a portal link; customer opens it
4. Portal response whitelist check — **fails if any internal field leaks**
5. Stage transitions (registration → logistics) with customer-side verification
6. Customer posts a comment; staff confirms it in the timeline
7. Customer uploads photo; staff uploads photo (both visible in customer gallery)
8. Staff hides the internal photo → customer cannot access it
9. Supplier link, auto-PO generation, cost fields — all verified hidden from customer
10. Manager QA approval → case closed → customer sees "Completed"
11. Satisfaction survey generated + submitted with 4★ + notes
12. Public `/track` form happy + sad paths
13. Security: portal token can't reach staff API, random tokens rejected
14. Quality Metrics dashboard responds

## Setup

```bash
cd tests/e2e
npm install
npx playwright install chromium
cp .env.example .env
# Edit .env with real staff credentials + a real SO/phone pair
```

### Required env vars

| Var | Purpose |
|---|---|
| `ERP_BASE_URL` | Frontend host (defaults to `http://localhost:5173`) |
| `ERP_API_URL` | Worker URL (defaults to production) |
| `STAFF_EMAIL` / `STAFF_PASSWORD` | Dispatcher-level staff account |
| `TEST_SO_NO` / `TEST_SO_PHONE` | A real Sales Order in AutoCount with a phone on file |
| `TEST_SUPPLIER_NAME` | *(optional)* supplier to reuse; defaults to `[E2E] Test Upholstery` |

## Run

```bash
# All tests (smoke + lifecycle)
npm test

# With a visible browser so you can watch
npm run test:headed

# Step-by-step debugger (Playwright Inspector)
npm run test:debug

# Just the smoke tests
npm test -- smoke

# Just the lifecycle
npm test -- lifecycle

# HTML report after a run
npm run test:report
```

## What it **does** modify in the database

Each lifecycle run creates:

- 1 new ASSR case (issue text starts with `[E2E TEST]`)
- 5 attachments on that case (3 complaint photos + 2 from Act 7)
- 1 activity-log entry per stage transition + comments + QA + survey
- 1 APO purchase order number
- 1 satisfaction survey token
- 1 case_track_tokens entry (the portal link)
- Possibly 1 supplier (`[E2E] Test Upholstery`) on first ever run

To find + remove after a run:

```sql
-- See everything the test created
SELECT id, assr_no, complaint_issue FROM assr_cases
 WHERE complaint_issue LIKE '[E2E TEST]%'
 ORDER BY id DESC LIMIT 10;

-- Purge (use wrangler d1 execute)
DELETE FROM assr_cases WHERE complaint_issue LIKE '[E2E TEST]%';
-- Child tables cascade automatically via FK ON DELETE CASCADE.
```

If you also want to drop the test supplier:

```sql
DELETE FROM suppliers WHERE name = '[E2E] Test Upholstery';
```

## Caveats

- The lifecycle spec runs **serially** (single worker). It's a single linear story — parallelism would race on shared state.
- **Uses real AutoCount lookups.** `TEST_SO_NO` must resolve to a real SO when the middleware is reachable; otherwise case creation fails at step 2.
- Because this writes to production data by default, run against a staging environment when possible. Override `ERP_BASE_URL` / `ERP_API_URL` for local dev.
- The UI selectors rely on text content (placeholder / button name) rather than `data-testid`, so copy changes in the app will require matching updates here. This is deliberate — we want the test to fail if UX copy drifts so those changes get noticed.

## CI

Set the env vars in your CI secrets store, then:

```yaml
- run: npx playwright install --with-deps chromium
- run: npm test
  working-directory: tests/e2e
```

Playwright produces `test-results/` and an HTML report. Keep both as CI artifacts so failures are debuggable.
