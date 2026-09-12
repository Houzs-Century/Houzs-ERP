# Module: ERP -> Venture Portal live sales-order feed (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** Resolve a route to its
> current line with the GENERATED artifact, which cannot go stale because it is
> rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

The Venture Portal pays **Revenue Department commission** out of this system's
sales orders. Until this feed, that was a monthly `.xlsx` somebody exported here
and imported there. Now every changed sales order is pushed to the portal, with
its lines, **their costs**, its payments and its cancellations.

The portal's receiver has been live since **2026-09-05**. The contract it
publishes lives in the Venture Portal repository, not this one:
`docs/erp-sync/contract.md` [external] — the marker has to sit on the same line
as the path, immediately after it, or `check-docs-drift --strict` cannot see it
and reads the reference as a broken link. It wrapped onto the next line here
first, which is the trap CLAUDE.md names in its own words.

---

## 0. It ships OFF, behind THREE gates

All three must be set before one order can leave this system.

| gate | where | state on arrival |
|---|---|---|
| the switch + company scope | `scm.app_config` key `scm.venture_portal_feed` | **`'off'`**, seeded by mig `20260912T1800_scm_venture_portal_outbox.sql` |
| the receiver address | `scm.sync_config` key `vp.url` | **absent** — `scm.sync_config` (mig 0123) is empty |
| the shared secret | `scm.sync_config` key `vp.secret` | **absent** |

`vp.since` is a fourth, optional value: a date floor, so enabling the feed
cannot push years of history into somebody's commission.

**The gates are NOT symmetric, and the difference is deliberate.** The capture
trigger is UNCONDITIONAL — it is same-transaction capture and must not depend on
a readable flag — so rows accumulate whatever the switch says. The switch and the
config stop the **drain**. Turning the feed off therefore leaves the queue
intact, and turning it on later delivers what accumulated, bounded by the
company scope and `vp.since`.

All three are set from the **Venture Portal Feed** page, never by hand. That is
the point of the page: the contract asked for `INSERT` statements in a database
console, and CLAUDE.md forbids that shape.

---

## 1. How it flows

```
scm.mfg_sales_orders / _items / _payments
  │  AFTER trigger, SAME TRANSACTION as the salesperson's Save, exception-safe
  ▼
scm.venture_portal_outbox            one PENDING row per document
  │  */5 cron  →  drainVenturePortalOutbox()
  │               scope check  →  scm.vp_build_payloads()  →  one POST per doc
  ▼
POST <vp.url>   header x-sync-secret
  │
  ▼
the portal upserts one live row per document, ordered by snapshotAt
```

Plus a backstop: the `*/30` cron calls `reconcileVenturePortalOutbox()`, which
re-queues any in-scope order with no delivered row. Steady state is `requeued=0`.

**Latency is under five minutes**, not the ten seconds the contract designed
for. See §2.

---

## 2. Why the Worker and not pg_cron + pg_net

The contract specifies `pg_cron` every 10s and `pg_net` for the POST, mirroring
the 2990 -> Houzs mirror (`docs/2990-live-sync/02_worker_2990.sql`), and listed
"are the extensions on?" as an OPEN POINT.

**It is settled and the answer was NO.** Measured against production
(`anogrigyjbduyzclzjgn`) on 2026-09-12:

```sql
SELECT string_agg(extname || ' ' || extversion, ', ')
  FROM pg_extension WHERE extname IN ('pg_net','pg_cron');   -- NULL
```

Installing them would buy ~10 seconds and cost the thing this repo protects
hardest: a `pg_cron` job is invisible to typecheck, vitest, the lint ratchet and
every `audit:` script here. CLAUDE.md records what that costs — `audit:map`
reported nothing for three weeks because the script it ran had been crashing
since the day after it was written.

The Worker's `*/5` slot already drains two outboxes (`email_outbox`,
`scm.autocount_outbox`) in TypeScript that CI executes. Commission is settled
monthly; five minutes and ten seconds are the same number to it.

**What this gives up, plainly:** the feed is not "live within seconds". A sales
order saved at 10:01 reaches the portal by 10:05 rather than 10:01:10.

---

## 3. The table — `scm.venture_portal_outbox` (mig `20260912T1800`)

| column | note |
|---|---|
| `id` | `uuid`, `gen_random_uuid()` |
| `doc_no` | the sales order this row is about |
| `op` | `INSERT` / `UPDATE` / `DELETE`, suffixed `:<table>` for a child edit; `RECONCILE` from a sweep. **Diagnostic only** |
| `status` | `pending` \| `sent` \| `failed` \| `skipped` |
| `attempts` | parked as `failed` at `VP_MAX_ATTEMPTS` (6) |
| `last_error` | the refusal, verbatim, truncated |
| `portal_outcome` | what the portal SAID it did — see §6 |
| `created_at` / `updated_at` / `sent_at` | |

**There is NO payload column, and that is a deliberate divergence from
`scm.autocount_outbox`.** 0277 says in capitals that its payload is a snapshot
taken at enqueue and never recomposed, because it is the audit record of what
the ERP told AutoCount. This feed is the opposite kind of thing: a **state
mirror**, not an operation log. The portal upserts one live row per document and
applies the newest `snapshotAt`. Building at SEND time collapses five edits into
one delivery and guarantees a retry carries current state.

**One PENDING row per document** follows from that —
`venture_portal_outbox_pending_doc_idx`, a partial unique index. The trigger
inserts `ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING`.

### The status vocabulary is `scm.autocount_outbox`'s, on purpose

So this system has ONE dialect for "where is my outbox row". It is **not the
same list** — `VP_ROW_STATUSES` is its own const
(`backend/src/scm/lib/venture-portal-outbox.ts`), because either outbox may grow
a fifth state for a reason that has nothing to do with the other. Recorded in
`backend/scripts/data/duplicated-decision-allowlist.json`.

---

## 4. What travels, and what does not

`scm.vp_build_payloads(text[])` builds one delivery per document. **The header
comes from the VIEW**, `scm.mfg_sales_orders_with_payment_totals`, never the
base table: `paid_total_sen` and `balance_sen_live` are computed there and the
portal's deposit gate reads `balance_sen_live` first.

```json
{
  "docNo": "HC-SO-013403",
  "snapshotAt": "2026-09-12T10:12:33.123456+00:00",
  "deleted": false,
  "header": { },
  "items": [ ],
  "payments": [ ],
  "salesperson": { "id": "<scm.staff.id>", "name": "", "staff_code": "", "user_id": 0 }
}
```

A document whose row is gone returns `{ "docNo": …, "deleted": true, "snapshotAt": … }`.

### Stripped before it leaves the database — 24 columns, and 6 of them are ours

The contract names eighteen: `phone`, `email`, `address1..4`,
`ship_to_address`, `bill_to_address`, `install_to_address`,
`emergency_contact_name` / `_phone` / `_relationship`, `customer_po_image_b64`,
`signature_b64`, `note`, `remark2..4`. The two `_b64` columns are whole images.

**Six more were added here**, found by reading what the payload actually carries
rather than what the contract remembered to name:

| added | what it is | why it goes |
|---|---|---|
| `city`, `postcode` | address components | the contract's own reasoning, applied to two columns it skipped |
| `approval_code` | a card / terminal authorisation code | payment credential. Not a commission input |
| `slip_key`, `slip_image_key`, `receipt_image_key` | pointers to payment-slip and receipt IMAGES | customer bank documents |

Widening the list cannot break the receiver: the portal reads a fixed column
list (contract §3, none of these in it) and answers 200 for anything it can
still read. Minimum privilege is the default (CLAUDE.md rule 5), and this
migration becomes immutable the moment it is applied.

**PROVEN against production, read-only, 2026-09-12** — the strip expression was
run over a real in-scope order via the Supabase MCP:

| measured | result |
|---|---|
| the 24 stripped keys still present | **0** |
| the 19 columns the portal reads still present | **19** |
| header keys that travel | 84 |

### The builder itself has been RUN against production, read-only

Not the function — the function exists on no database. Its whole BODY, verbatim,
as an anonymous `DO` block over the real schema, plus a query that assembles one
document's payload. The Supabase MCP connection is READ-ONLY (`cannot execute
CREATE TABLE in a read-only transaction`), which is what makes this safe to say.

`HC-SO-2609-063`, the newest in-scope order on 2026-09-12:

| measured | result |
|---|---|
| payload size | **8,506 bytes** — the contract's "a few KB", confirmed |
| line items / payments carried | 4 / 1 |
| `salesperson` resolved through the `::uuid` cast and the `scm.staff` join | **yes** |
| `items[0].line_cost_sen` present — the costing the portal was waiting for | **yes** |
| `header.balance_sen_live` present — the deposit gate's input | **yes** |
| `header.phone` present | **no** |
| `header.approval_code` present | **no** |

What this settles: the strip list, the view read, the uuid cast, the staff join,
the two nested aggregates and both `ORDER BY`s all execute against the real
schema and produce the shape the contract asks for. What it does NOT settle is
anything the migration CREATES — see §11.

### The costing, which is half of what the portal was waiting for

`items[].line_cost_sen` is the cost source its margin layer could not open
without. `unit_cost_sen` and `line_margin_sen` travel too, and all three are in
the item trigger's column list, so **a cost corrected after the sale
re-delivers the order.**

### Cancellation travels three ways

| what happened | how the portal sees it |
|---|---|
| `status` becomes `CANCELLED` | a header change; the portal's excluded-status rule drops it |
| the whole order row is deleted | `deleted: true` |
| one line is cancelled | `items[].cancelled = true`; the portal reads live lines only |

All three are in a trigger column list, so all three re-deliver.

---

## 5. The one round trip per sweep

`vp_build_payloads` takes an ARRAY and answers for the whole batch. A
50-document sweep composing header + items + payments + salesperson in the
Worker would be 200 subrequests against 1. CLAUDE.md holds this repo to a
standing subrequest diet.

---

## 6. The response taxonomy — and it is NOT the contract's

The contract says every non-2xx keeps the row pending and retries **forever**.
This does not, and the difference is the useful part:

| answer | outcome | costs an attempt? | why |
|---|---|---|---|
| 2xx | `sent` | yes | delivered. `portal_outcome` records what the portal did with it |
| 401 | stays `pending` | **no** | the secret does not match. Ours to fix, not the document's — six 401s while somebody is still filling in the config must not park six orders |
| 503 | stays `pending` | **no** | the portal has no `ERP_SYNC_SECRET` yet. Nothing to fix on our side |
| 400 / 422 | `failed` at once | yes | the portal could not READ the delivery. The contract's own table says it "will not fix itself", so retrying it every five minutes buys nothing and hides it |
| 5xx, timeout, transport | stays `pending` | yes | parked as `failed` at 6 attempts |

**A 200 is a successful delivery even when the portal did not apply it.** The
contract warns against conflating the two twice. `portal_outcome` carries the
portal's own word — `applied`, `duplicate`, `stale`, `held`, `skipped` — and the
page renders it BESIDE the state, never instead of it: a `held` month is
delivered and NOT counted, and a bare tick there would tell somebody their
commission is in when it is not.

---

## 7. Permissions

| key | what it buys |
|---|---|
| `scm.venture_portal.read` | see whether the feed is on, what is queued, what was delivered, why anything failed |
| `scm.venture_portal.manage` | turn it on/off, choose companies, set or rotate the secret, re-send a delivery |
| `settings.manage` | accepted for **both** halves — whoever already owns the sync connections owns this one, so the page works on day one with no grant migration |

The split is the one the two AutoCount keys are drawn on, for a sharper reason:
managing this decides which companies' sales orders — with their costs and
margins — leave the system for somewhere they become the input to somebody's
commission, and **a delivery cannot be recalled.**

`scm.access` does not imply either: an L2 SCM area key is a PAGE key and this
page belongs to no area. The router is mounted with **no `scmAreaGuard`** and is
listed in `SCM_UNGUARDED_PREFIXES` (`backend/src/scm/lib/scm-areas.ts`).

**Deliberately cross-company**, unlike every other SCM route. Which companies
feed the portal is the setting this page edits, so a company predicate would hide
the thing being set from the person setting it. The boundary is the permission
gate.

---

## 8. The routes — `/api/scm/venture-portal-feed`

| method | path | key | note |
|---|---|---|---|
| GET | `/status` | read | the switch, the scope, the connection, the queue counts, last delivery, last error, oldest waiting |
| GET | `/rows` | read | `?status=&doc_no=&limit=` (capped 200) |
| PUT | `/connection` | manage | `vp.url` + `vp.since`. **https only** — the body carries a customer name and every line's cost |
| PUT | `/secret` | manage | **write-only.** >= 32 characters |
| PUT | `/scope` | manage | the switch and the company list. `companies` is REQUIRED when enabling |
| POST | `/probe` | manage | GETs the receiver's `/health` with the secret. Sends no sales-order data |
| POST | `/queue-undelivered` | manage | the backfill AND the self-heal, one operation |
| POST | `/drain` | manage | send now rather than waiting for the sweep |
| POST | `/rows/:id/requeue` | manage | release one parked row. A `sent` row is refused `409` |

### The secret is write-only through the API

`PUT /secret` sets it; **nothing reads it back.** `GET /status` answers with its
LENGTH and last four characters — enough to tell "the right one is in there"
from "the field is empty" without putting a credential on a screen, in a log, or
in a browser's network tab. The value only ever leaves the database as a request
header the sender builds.

---

## 9. The page

`/venture-portal-feed` — desktop `frontend/src/pages/VenturePortalFeed.tsx`,
mobile `frontend/src/mobile/MobileVenturePortalFeed.tsx`, **one shared logic
layer** in `frontend/src/lib/venturePortalFeed.ts`. Every verdict and sentence
lives in the shared layer; the two surfaces render and decide nothing.

The order of the page is the order of the question somebody arrives with: is it
working, is it on and for whom, is it wired up, then the queue with the reason on
the row.

**A count is not a verdict**, and `vpVerdict` is where that is enforced. "12
waiting" is a busy queue; "1 waiting since Tuesday" is a feed that stopped, and
those are the same number. The staleness branch reads `oldestPending`.

---

## 10. Operating it

**Turning it on for the first time**

1. Get the receiver URL and the shared secret from the portal owner. The secret
   must also be set as `ERP_SYNC_SECRET` on the portal's Vercel Production env —
   until it is, the portal answers 503 and our queue simply waits.
2. Page -> Connection -> save the address, save the secret, press **Test
   connection**. Expect `{"ok":true,…}`.
3. Page -> Switch -> companies (Houzs Century is `1`) -> **Turn on**.
4. Page -> The queue -> **Queue anything not delivered** to backfill.
   493 in-scope orders existed on 2026-09-12; at 25 per five-minute sweep that
   is about 100 minutes, or press **Send now** repeatedly to walk it down while
   watching. **UNTESTED at that scale** — watch the first run.
5. Portal HR matches each ERP salesperson to a portal staff row once
   (Revenue -> Fair -> Comm Cal). Remembered against `scm.staff.id`.

**Rotating the secret** — set the new value on the PORTAL first, then on this
page. The window of 401s only delays deliveries: a 401 costs a row no attempts.

**Is it stuck?** The page's verdict answers it. `pending` that keeps growing
while `last_error` reads `http 401` is the secret; a `pending` row hours old with
no error is the drain not running.

**A month's commission run is already applied.** Deliveries for it arrive as
`held`. HR reopens the run in the portal and replays.

---

## 11. Known limits

- **A company-wide write freeze also pauses CHANGING the feed.** The router is
  in `SCM_UNGUARDED_PREFIXES` and write-freeze blocks non-GET on `/api/scm/*`,
  so during a freeze the feed can be running and not turnable off from the page.
  The cron drain is not an HTTP request and keeps delivering what is queued.
  Whoever imposed the freeze can still flip `scm.app_config`. Exempting this
  prefix is a change to write-freeze's own contract and belongs in its own PR.
- **The SQL is UNAPPLIED.** `pg-migrate` applies it on the next push to `main`.
  The statement splitting was verified against
  `backend/scripts/lib/split-sql.mjs` (20 statements, every dollar-quoted body
  intact) and the builder's body was RUN read-only against production (§4) — but
  the objects themselves have been created on no database. Not verifiable from
  here either: the Supabase MCP connection is read-only, so no `CREATE` in this
  file has ever been executed anywhere. What is still open is therefore the DDL
  itself: the table, the three triggers, the two `CREATE FUNCTION` wrappers, the
  grant block and the seed. If one of them has a syntax error, the deploy's
  `pg-migrate` step fails and **blocks every later migration until it is
  fixed** — so read the Deploy run, do not assume it.
- **Backfill throughput is untested** at 493 documents (see §10).
- **The PII strip list is enforced in SQL**, so no TypeScript test covers it.
  It is instead PROVEN by a read-only run of the expression against production
  (§4): 0 of the 24 stripped keys survive, all 19 the portal reads do. Re-run
  that query, not this sentence, if the view gains a column. Everything the
  SENDER decides is covered by
  `backend/src/scm/lib/venture-portal-outbox.test.ts`.

---

## 12. Files

### What the module IS

| file | what |
|---|---|
| `backend/src/db/migrations-pg/20260912T1800_scm_venture_portal_outbox.sql` | table, three triggers, `vp_build_payloads`, `vp_requeue_undelivered`, the seeded `'off'` flag |
| `backend/src/scm/lib/venture-portal-outbox.ts` | the sender, the response taxonomy, the reconcile, `VP_ROW_STATUSES`, `VP_CONFIG_KEYS` |
| `backend/src/scm/lib/venture-portal-feed-flag.ts` | the switch + company scope, 30s cache, fails closed to OFF |
| `backend/src/scm/routes/venture-portal-feed.ts` | the nine endpoints |
| `frontend/src/lib/venturePortalFeed.ts` | the ONE logic layer for both surfaces |
| `frontend/src/pages/VenturePortalFeed.tsx` | desktop |
| `frontend/src/mobile/MobileVenturePortalFeed.tsx` | mobile |

### Where it is WIRED UP

Listed because "where is this thing registered" is the question that costs the
most time in this repo, and because a shared registry file changing is exactly
where a feature half-lands — a route with no nav row, or a nav row pointing at
no route.

| file | what this module puts there |
|---|---|
| `backend/src/index.ts` | `drainVenturePortalOutbox` in the `*/5` cron; `reconcileVenturePortalOutbox` in the `*/30` cron |
| `backend/src/scm/index.ts` | `scm.route("/venture-portal-feed", venturePortalFeed)` — no `scmAreaGuard`, and the comment says why |
| `backend/src/scm/lib/scm-areas.ts` | `/venture-portal-feed` in `SCM_UNGUARDED_PREFIXES`, with what that costs under a write freeze (§11) |
| `backend/src/services/permissions.ts` | `scm.venture_portal.read` and `scm.venture_portal.manage` (§7) |
| `frontend/src/App.tsx` | the `/venture-portal-feed` route + its `Guard anyPerm` |
| `frontend/src/components/Sidebar.tsx` | the `NAV_TABS` entry, System section — also what gates the MOBILE menu row |
| `frontend/src/mobile/MobileApp.tsx` | the `venture-portal-feed` screen, its path mapping, its menu row and its `TabLocked` guard |
| `frontend/src/routing/routeManifest.ts` | `/venture-portal-feed` in `STAFF_ROUTE_PATTERNS` — the drift gate fails without it |

### Where it came from

| file | what |
|---|---|
| `docs/2990-live-sync/` | the 2990 -> Houzs mirror this design descends from |
| `docs/modules/autocount-writeback.md` | the outbox this one borrows its shape and status vocabulary from, and diverges from twice (§3) |
