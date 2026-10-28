# 2990 → Houzs LIVE SO mirror — design

**Goal:** every SO the 2990 POS creates/edits appears in the merged Houzs system
(company_id=2) **live**, with **zero loss (一个不漏)**, **without touching the POS**
and without risking 2990's production.

**Non-negotiables (owner):**
1. POS ↔ 2990 backend link must not break. → we touch neither; capture is at the DB.
2. Data must be live, not periodic-stale. → push from the DB, not a slow cron pull.
3. Zero loss. → outbox (same-tx capture) + retry-to-ack + idempotent + reconciliation.

## Pieces

| # | Piece | Where | Status |
|---|-------|-------|--------|
| 1 | `sync_outbox` table + triggers on SO header/items/payments | **2990 DB** | ✅ `01_outbox_2990.sql` |
| 2 | Receiver: verbatim, idempotent SO upsert by doc_no, company_id=2 | **Houzs** | ⏳ |
| 3 | Drain worker: outbox → receiver, retry to ack | **2990 side** | ⏳ (mechanism decision below) |
| 4 | Reconciliation sentinel: 2990 SO count == Houzs company_2 count | either | ⏳ |
| 5 | End-to-end proof on Houzs-staging stand-in | Houzs staging | ⏳ |

## Zero-loss chain
SO commit → trigger writes outbox **in the same transaction** (can't exist an SO
without a forward task) → worker forwards, marks delivered **only on Houzs ack**,
retries forever on failure (survives a Houzs outage) → receiver **upserts by
doc_no** (retries never duplicate) → reconciliation counts both sides daily and
backfills any gap. Trigger is exception-safe so it can **never block a 門店 sale**.

## Reuse
The receiver's transform = the already-proven `migrate-2990-into-houzs.mjs`
mapping applied to ONE SO instead of the whole DB. Same column passthrough +
company_id=2 stamp + doc-no prefix. So the live path == the batch-import path,
per SO — low new-code, consistent with the initial load.

## OPEN DECISION — the worker mechanism (how "live")
- **A. pg_cron + pg_net inside 2990 DB** (every ~10s drain outbox → HTTPS POST to
  Houzs receiver). Truly live (seconds), DB-native, no extra host. Needs the
  `pg_net` + `pg_cron` extensions enabled on 2990's Supabase.
- **B. Cloudflare Worker cron** (min ~1 min) — near-live, no 2990 DB extensions.
- **C. GitHub Action cron** — min ~5 min, NOT live. Only as the reconciliation
  sweep, not the primary path.

→ Prefer **A** (matches the "live" requirement). Fallback **B** if 2990's Supabase
can't enable pg_net. Must check the extensions before committing.

## Test strategy (no 2990 staging exists)
Build outbox + receiver + worker + reconcile against **Houzs staging** (its
`scm.mfg_sales_orders` is the same clone schema). Insert a fake SO → watch the
whole chain → reconcile green. Prove: (a) zero-loss, (b) idempotency (double
delivery = one row), (c) outage recovery (stop receiver, insert SOs, restart →
backlog drains). Only after green + owner review: apply `01_outbox_2990.sql` to
2990 prod (additive; POS-safe trigger).
