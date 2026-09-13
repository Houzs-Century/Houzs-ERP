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
  │  the SAVE's own request, after its response   →  kickVenturePortalDrain()
  │  */5 cron, unchanged                          →  drainVenturePortalOutbox()
  │               scope check  →  scm.vp_build_payloads()  →  one POST per doc
  ▼
POST <vp.url>   header x-sync-secret
  │
  ▼
the portal upserts one live row per document, ordered by snapshotAt
```

Plus a backstop: the `*/30` cron calls `reconcileVenturePortalOutbox()`, which
re-queues any in-scope order with no delivered row. Steady state is `requeued=0`.

**The save sends its own order**, and the two crons stay exactly as they were —
they are the zero-loss guarantee and the kick is only the accelerator. See §2.

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
`scm.autocount_outbox`) in TypeScript that CI executes.

### Seconds, WITHOUT pg_cron — the kick (2026-09-13)

The paragraph that used to end this section said the feed "is not live within
seconds" and that an order saved at 10:01 reaches the portal at 10:05. The owner
asked for seconds — 「我要秒级 update 的」 — and that did not need the extensions
after all, because **the slow half was never the capture.** The trigger already
runs in the salesperson's own transaction. Only the DRAIN waited for a cron, and
a request can schedule the drain itself.

`kickVenturePortalDrain(env, ctx)` (`backend/src/scm/lib/venture-portal-outbox.ts`),
called from one middleware (`backend/src/scm/lib/venture-portal-kick.ts`) mounted
on `/api/scm/*` in `backend/src/scm/index.ts`:

| | |
|---|---|
| when | after `next()`, on a **non-GET** whose response is **2xx**. A read changed nothing; a refused write changed nothing either |
| where the work runs | inside `ctx.waitUntil`, so the person who pressed Save waits for none of it |
| the wait | `VP_KICK_DELAY_MS` = 1500 ms before the first sweep, so several requests saving one order collapse into ONE delivery — the payload is built at send time, and that only pays off if the send waits |
| the debounce | the SAME 1500 ms, held in a module-level timestamp. A write inside the window is covered by the drain already scheduled, because that drain has not run yet and the write's outbox row is already committed. Per-isolate and best-effort |
| how far one kick goes | up to `VP_KICK_MAX_SWEEPS` = 4 sweeps x `VP_DRAIN_BATCH` = **100 documents**, then it hands the rest back to the cron |
| when it sweeps again | only when a **full batch LEFT the queue** (`vpKickSweepAgain`: `sent + failed + outOfScope >= 25`). Not `processed` — a 401 keeps its row pending and costs it no attempts, so counting `processed` would fire 100 POSTs per kick for as long as two keys disagreed |
| if anything fails | swallowed and logged as `[vp-kick]`. It can never fail the request, and losing a kick costs only time |

**Measured latency: UNKNOWN.** The design path is save -> trigger (same
transaction) -> response -> 1.5 s debounce -> one POST, which the hand-off
estimates at **2-3 s (LIKELY, not measured)**. Nothing in this repo has yet
delivered one order to the live portal end to end, because the feed is off and the
key has to be pasted on the portal by hand first. **Replace this paragraph with
the number from the first real order** — that is acceptance step 4, and an
estimate left standing here would read as a measurement to the next person.

**What the kick CANNOT see, and the cron still must:** a change to
`scm.mfg_sales_orders*` made outside a Worker request — a migration backfill, a
repair script, a hand-written `UPDATE`. The trigger captures it; no request exists
to kick it; the `*/5` sweep collects it. Accepted, and the reason both crons stay.

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
| 503 | stays `pending` | **no** | the portal holds no key of its own yet |
| 400 / 422 | `failed` at once | yes | the portal could not READ the delivery. The contract's own table says it "will not fix itself", so retrying it every five minutes buys nothing and hides it |
| 5xx, timeout, transport | stays `pending` | yes | parked as `failed` at 6 attempts |

> **The 503 row's MEANING moved on 2026-09-13; its HANDLING did not.** It used to
> mean "the portal has no `ERP_SYNC_SECRET` on Vercel — nothing to fix on our
> side", and that sentence was rendered to operators by `vpRowTodo` as "ask the
> portal owner". Since the portal's PRs #117 + #118 it reads a key pasted on its
> own page and that env var is optional, so a 503 is now fixed from OUR page plus
> one paste. `classifyVpResponse` is untouched — retry, no attempt consumed, which
> was right before and is right now. What changed is only the sentence the page
> shows, and 401 got the same treatment: both name the next step (generate, paste,
> re-send) and say which side is empty. LIKELY, from the portal's own hand-off; the
> receiver's source is in another repository and has not been read from here.

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
| PUT | `/connection` | manage | `vp.url` + `vp.since`. **https only** — the body carries a customer name and every line's cost. Unchanged by the 2026-09-13 default: the address the page OFFERS is a page-side constant, never a server default |
| POST | `/secret/generate` | manage | **mints the key.** 48 URL-safe characters, stored exactly as `PUT /secret` stores it, returned **once** in that response and never again |
| PUT | `/secret` | manage | **write-only.** >= 32 characters. The paste-your-own fallback; the page has no box for it since 2026-09-13 |
| PUT | `/scope` | manage | the switch and the company list. `companies` is REQUIRED when enabling |
| POST | `/probe` | manage | GETs the receiver's `/health` with the secret. Sends no sales-order data |
| POST | `/queue-undelivered` | manage | the backfill AND the self-heal, one operation |
| POST | `/drain` | manage | send now rather than waiting for the sweep |
| POST | `/rows/:id/requeue` | manage | release one parked row. A `sent` row is refused `409` |

### The key is minted here and shown once

Owner 2026-09-13: 「那边 generate 一个 API key 出来；我这边只需要填那个 API key，
它就可以 link 起来了」. Before this, linking the two systems meant inventing a
string and typing the same string into two places.

`POST /secret/generate` mints 48 characters from a **64-symbol** URL-safe
alphabet with `crypto.getRandomValues` (`mintVpSecret`). The alphabet's length is
load-bearing: `byte & 63` is uniform only because 64 divides 256 exactly, so
trimming it to 62 "alphanumeric only" symbols would bias the first two, silently.
A test pins the length for that reason.

**It is returned in that one response and never again.** `GET /status` answers
with the key's LENGTH, its last four characters and `setAt` — when it was last
written, from `scm.sync_config.updated_at`. That is enough to tell "the right one
is in there" from "the field is empty", and enough to answer "is the portal
holding the key we generated on Sunday?", without putting a credential on a
screen, in a log, or in a browser's network tab. The value only ever leaves the
database as a request header the sender builds.

**The audit row carries no key.** `writeAudit` records
`venture_portal.secret.generate` with the actor, the entity and the key's LENGTH
and TAIL in `meta` — so the ledger answers who minted one and when, without the
ledger becoming worth stealing. The actor is passed explicitly from `houzsUser`
rather than left to `audit(c, …)`, which lifts it off `c.get('user')` — inside
`/api/scm/*` that is the pinned `scm.staff` system identity every caller shares.

**Rotating** is pressing Generate again and pasting the new key on the portal. The
window of 401s in between costs the queue nothing: a 401 does not consume a row's
attempts (§6), so the deliveries go out on their own once the two agree.

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

### Connection, since 2026-09-13 — two things nobody has to type

**The API key has no input box.** Where the free-text *Shared secret* field was,
the card now shows `Key ····9f2a · generated 13/09/2026 15:40` (`vpKeyLine`) and a
**Generate API key** button. Pressing it reveals the key ONCE, in a box with
**Copy** and **Done**, under the sentence that names where it goes:

> Paste this in the Venture Portal › Revenue › Fair › Commission Calculation ›
> Houzs ERP link. Not shown again; generate a new one to rotate.

The reveal is component state in `useVpActions` — never localStorage, never the
URL, gone on reload, and the server will not answer it a second time. **Copy
reports its own failure**: `navigator.clipboard` throws on an insecure origin and
on a denied permission, and a silent one there sends the operator to the portal
with an empty clipboard and no key left to copy.

**The receiver address arrives pre-filled** with `VP_DEFAULT_RECEIVER_URL` —
`https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders` — when `vp.url`
is empty (`vpReceiverDraft`). It is a PAGE constant, not a server default:
`PUT /connection` is unchanged and still https-only, and a receiver address the
server chose for an endpoint that sends customer names and line costs outward is
the wrong direction. `vpReceiverHint` says out loud which state it is in, because
a pre-filled box otherwise reads as a saved one and somebody would turn the feed
on while `vp.url` is still empty and the drain answers `not_configured`.

Both surfaces render all of it from the shared layer; the desktop and mobile
suites each assert the reveal appears once and is gone after **Done**.

---

## 10. Operating it

**Turning it on for the first time** (rewritten 2026-09-13 — no secret to invent,
no URL to type, and nothing to ask the portal owner for)

1. Page -> Connection -> the **Receiver address** is already the portal's own.
   Press **Save address**. (Nothing is stored until you do; the hint says so.)
2. Press **Generate API key** -> **Copy** -> paste it in the Venture Portal
   (Revenue -> Fair -> Commission Calculation -> *Houzs ERP link*) -> **Done**.
3. Press **Test connection**. Expect `{"ok":true,"service":"venture-portal",…}`.
4. Page -> Switch -> companies (Houzs Century is `1`) -> **Turn on**.
5. Page -> The queue -> **Queue anything not delivered** to backfill.
   493 in-scope orders existed on 2026-09-12. One kick clears up to 100, and any
   save kicks — so pressing **Send now** a few times, or simply working normally,
   walks it down far faster than the old 25-per-five-minutes. **UNTESTED at that
   scale** — watch the first run and record the wall clock here.
6. Portal HR matches each ERP salesperson to a portal staff row once
   (Revenue -> Fair -> Comm Cal). Remembered against `scm.staff.id`.

**Rotating the key** — press **Generate API key** again, then paste the new one on
the portal. Order does not matter: the window of 401s only delays deliveries,
because a 401 costs a row no attempts. (This used to read "set the new value on
the PORTAL first", which was advice for a key you invented yourself; when this
side mints it, the portal cannot be first.)

**Is it stuck?** The page's verdict answers it. `pending` that keeps growing while
`last_error` reads `http 401` is the key — the portal is holding a different one.
A `pending` row hours old with no error means BOTH senders have stopped: the kick
and the `*/5` sweep. `[vp-kick]` in the Worker log is the kick's own failures.

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
  **The kick is unaffected either way**: it is mounted after write-freeze, and a
  frozen write returns 503 without calling `next()`, so no kick is even entered
  for a save that did not happen.
- **The kick's limits, all three deliberate.** (a) The debounce timestamp is
  MODULE-LEVEL, so it is per-isolate: two isolates serving two saves a second
  apart schedule two drains. Harmless — the second finds an empty queue. (b) A
  change made to `scm.mfg_sales_orders*` outside a Worker request (a migration
  backfill, a repair script, a hand-written `UPDATE`) is captured by the trigger
  and kicked by nothing; the `*/5` sweep collects it. (c) One kick delivers at
  most `VP_KICK_MAX_SWEEPS * VP_DRAIN_BATCH` = 100 documents. It is an
  accelerator, not a backfill tool.
- **`/api/pos/*` is deliberately NOT a second mount.** Checked 2026-09-13:
  `backend/src/routes/pos.ts` has nine routes and the only two naming
  `scm.mfg_sales_orders` are both `SELECT`s inside `GET /sales-stats`. POS
  sales-order writes go through `/api/scm/mfg-sales-orders` and its cart through
  `/api/scm/pos-cart`, both already under the mount. Re-check with
  `grep -n "mfg_sales_orders" backend/src/routes/pos.ts` before assuming it stayed
  true — a POS write path added there would silently fall back to the cron.
- **Measured end-to-end latency is UNKNOWN** and §2 says why. Acceptance step 4
  produces it; the estimate in §2 is labelled and must be replaced, not quoted.
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
| `backend/src/scm/lib/venture-portal-outbox.ts` | the sender, the response taxonomy, the reconcile, `VP_ROW_STATUSES`, `VP_CONFIG_KEYS`, `mintVpSecret`, `kickVenturePortalDrain` |
| `backend/src/scm/lib/venture-portal-kick.ts` | the ONE middleware that schedules a drain after a successful SCM write (§2) |
| `backend/src/scm/lib/venture-portal-feed-flag.ts` | the switch + company scope, 30s cache, fails closed to OFF |
| `backend/src/scm/routes/venture-portal-feed.ts` | the ten endpoints |
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
| `backend/src/index.ts` | `drainVenturePortalOutbox` in the `*/5` cron; `reconcileVenturePortalOutbox` in the `*/30` cron. **Both unchanged on 2026-09-13** — they are the zero-loss guarantee |
| `backend/src/scm/index.ts` | `scm.route("/venture-portal-feed", venturePortalFeed)` — no `scmAreaGuard`, and the comment says why. **Plus `scm.use('/*', venturePortalKick())`**, immediately after `scmWriteFreeze()`: one mount, so no router that writes a sales order can miss it, and a frozen write never reaches it |
| `backend/src/services/audit.ts` | `writeAudit` records `venture_portal.secret.generate` — actor, length, tail, never the key (§8) |
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
