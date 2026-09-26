# ERP → Venture Portal live sales-order feed

Pushes every changed Houzs sales order — lines, **their costs**, payments,
and cancellations — to the Venture Portal, which pays Revenue Department
commission from it. Replaces a monthly hand-exported `.xlsx`. Used by whoever
administers sync connections (Settings) and read by Finance/Revenue ops
checking delivery status. The same switch and key also push the product
catalogue, **items only** — see [Catalogue push](#catalogue-push-items-only).

## Statuses and flow

Ships **off** behind three gates, all of which must be set from the
**Venture Portal Feed** page (never by hand):

| gate | where | default |
|---|---|---|
| switch + company scope | `scm.app_config` key `scm.venture_portal_feed` | `'off'` |
| receiver URL | `scm.sync_config` key `vp.url` | absent |
| shared secret | `scm.sync_config` key `vp.secret` | absent |

`vp.since` is a fourth, optional date floor. **Capture is unconditional** —
a same-transaction `AFTER` trigger on `mfg_sales_orders` / `_items` /
`_payments` queues an outbox row regardless of the switch; the switch and
config gate only the **drain**, so turning the feed off leaves the queue
intact and turning it on later delivers what accumulated. Re-picking the
event (`project_id`, `fair_match`, `fair_date`) or editing `venue` /
`venue_id` is a change; so is a project whose venue, organizer, dates or
status change — `trg_vp_outbox_project` queues every order pointing at it.

Outbox row: `pending → sent | failed | skipped`; parked `failed` at 6
attempts. Three drain paths: (1) the saving request itself schedules a drain
~1.5s after its response (`kickVenturePortalDrain`, collapses a burst of
edits into one delivery, sweeps up to 4×25=100 docs, re-sweeps only when a
full batch left the queue); (2) the unchanged `*/5` cron
(`drainVenturePortalOutbox`) — the zero-loss guarantee; (3) the `*/30` cron
(`reconcileVenturePortalOutbox`) requeues any in-scope order with no
delivered row. **Trigger-written rows drain before backfill/RECONCILE rows**
within a sweep — a live save must never queue behind a backlog.

Response taxonomy (deliberately NOT the portal contract's "retry forever on
non-2xx"):

| answer | outcome | costs an attempt? |
|---|---|---|
| 2xx | `sent` | yes |
| 401 / 503 | stays `pending` | no — ours to fix, not the document's |
| 400 / 422 | `failed` at once | yes — the portal could not read it; will not self-heal |
| 5xx / timeout / transport | stays `pending` | yes — parked `failed` at 6 |

## Permissions

- `scm.venture_portal.read` — see the switch state, queue, deliveries,
  failures.
- `scm.venture_portal.manage` — turn on/off, choose companies, set/rotate
  the secret, re-send.
- `settings.manage` — accepted for **both** of the above (whoever already
  owns sync connections owns this).
- The router carries **no `scmAreaGuard`** (listed in
  `SCM_UNGUARDED_PREFIXES`) and is deliberately **cross-company** — the
  company scope is the setting this page edits, so a company predicate here
  would hide the thing being configured from the person configuring it. The
  permission gate is the only boundary.

## Rules that must not break

- **No payload column on the outbox.** This is a state mirror, not an
  operation log — the payload is rebuilt fresh at SEND time from the view,
  never stored at enqueue. Do not add a stored snapshot here.
- **One PENDING row per document** (partial unique index, `ON CONFLICT (doc_no)
  WHERE status='pending' DO NOTHING`) — ordering across repeated edits is
  handled by rebuilding at send time, never by queuing a second pending row.
- The header comes from the **view** `mfg_sales_orders_with_payment_totals`,
  never the base table — `paid_total_sen` / `balance_sen_live` are computed
  there and the portal's deposit gate depends on `balance_sen_live` being
  current.
- The PII/cost strip list must be applied **in SQL** before anything leaves
  the database (minimum privilege) — widening it is safe (the portal reads a
  fixed column list and ignores extras), narrowing it is not.
- A line travels as its row EXCEPT `variants`, which is cut to `fabricCode`,
  `seatHeight`, `legHeight`, `divanHeight`, `gap`, `totalHeight`, `size`,
  `specials` (string elements only; an object value is dropped) and omitted
  when the line has none of them. `extraAddonAmountRM`, `remark`,
  `extraAddonNote` and every other variant key stay here — the portal parses a
  line by those eight and falls back to `description2` without them.
- Each delivery carries `fair`: the picked project (`project_id` →
  `public.projects`) as `projectId`, `code`, `name`, `venue`, `organizer`,
  `brand`, `startDate`, `endDate`, `status`, `eventType` (the event type's
  slug), plus the order's own `match` (`fair_match`) and `fairDate`
  (`fair_date`); `null` when the order has no project. Built from the BASE
  table joined to `projects` — the header view's column list predates
  `project_id` — with named keys only. The portal keeps it as the bill's fair
  and takes its organizer and days over anything typed there, so a wrong
  project on an order is fixed HERE.
- `vp_build_payloads` takes an array and answers the whole batch in **one**
  round trip — never recompose per-document in a Worker loop (subrequest
  budget).
- `PUT /connection` is **https-only** — the body carries a customer name and
  every line's cost.
- The API secret is **write-only** and shown exactly once at generation (48
  chars from a 64-symbol alphabet via `crypto.getRandomValues`) — `GET
  /status` may only ever answer length + last 4 characters + `setAt`, never
  the value.
- `PUT /scope` stamps `updated_by` with the caller's **`scm.staff` uuid**,
  not the integer Houzs user id — the column is a uuid.
- The two populations in any latency measurement — trigger-written SAVE rows
  vs. backfill/RECONCILE rows — must never be pooled; a pooled median reads
  as the feed being far slower than it actually is.

## Gotchas

- `pg_cron` / `pg_net` are **not installed** on production and that
  question is settled (measured empty on `pg_extension`) — do not
  resurrect a `pg_cron`-based design; the Worker-side kick already delivers
  seconds-level latency without either extension.
- The kick is an **accelerator only**, not a backfill tool — it cannot see a
  change made outside a Worker request (a migration backfill, a repair
  script, a hand `UPDATE`). Only the trigger + `*/5` cron sweep collects
  those, so both crons must stay wired even with the kick in place.
- A company-wide write-freeze also blocks turning the feed's own switch off
  from the page (the router sits behind `scmWriteFreeze`) — the cron drain
  keeps delivering what is already queued regardless. Known and accepted,
  not a bug to silently patch.
- `portal_outcome` (`applied` / `duplicate` / `stale` / `held` / `skipped`)
  must render **beside** the delivery state, never instead of it — a 200
  (`sent`) row is not necessarily an applied one; a `held` month must never
  read as delivered-and-counted commission.
- Two kicks can legitimately overlap (no in-flight lock, by design) — do not
  add one; a lock would starve a save landing mid-sweep of any kick at all,
  defeating the point. The cost is at most a harmless duplicate POST.
- The migration's DDL (table, triggers, functions) has only been verified by
  running its body read-only against production — it has not been confirmed
  applied via an actual `pg-migrate` run. Check the deploy log rather than
  assuming the objects exist before relying on them.

## Catalogue push (items only)

Each in-scope company's catalogue — SKU master (`mfg_products`, inactive rows
too), Modular models with `allowed_options`, the six Bedframe/Sofa maintenance
pools, special add-ons, fabrics, and master sofa combos (soft-deleted ones
too) — goes to `POST <portal>/api/erp/v1/products` (contract v2). Same switch,
company scope, `vp.url` and `vp.secret` as the orders; `vp.since` does not
apply.

- **No price or cost ever leaves.** `scm.vp_build_catalogue` names every
  column it sends, so a column added to a source table adds nothing.
  Maintenance entries become a string or `{value, active}` (no `priceSen`);
  combos send the KEYS of `prices_by_height` as `heights`, never a value;
  `allowed_options` and `modules` pass `scm.vp_strip_money_keys`. The fabric
  `*_price_tier` fields are PRICE_1/2/3 labels, not money.
- **Receiver**: `vp.url` (https) with its trailing `/sales-orders` replaced by
  `/products`. Any other `vp.url` → nothing is sent and `GET /status` shows
  `catalogue.urlProblem`. Never guess another URL.
- **Cadence: live.** A write to any source table marks
  `scm.venture_portal_catalogue_changes` in the same transaction (statement
  triggers that name only the columns the catalogue sends — a cost, price,
  stock, photo or note update marks nothing). The SCM write kick runs the push
  after its order drain, in the same task, while a mark is present, so a Save
  reaches the portal in seconds; the `*/5` cron runs the same push after its
  drain and stays the safety net for a change made outside a request. Every
  push first clears the marks it covers (a mark written during it earns the
  next push). Each push asks `scm.vp_catalogue_digest` (md5 of the body) and
  builds and sends only when it differs from `delivered_digest` in
  `scm.venture_portal_catalogue_state`. The body is fetched with
  `scm.vp_catalogue_snapshot`, which returns the digest of that same build —
  record that one, never the digest asked first.
- **Split by section only.** One POST unless the body exceeds
  `VP_CATALOGUE_MAX_POST_BYTES` (the portal's host refuses a body over 4.5 MB);
  then whole sections are packed into several POSTs, each with `full: true`.
  Never split one section across two posts: `full` retires every row of a
  carried section the post does not mention. Posts stop at the first refusal.

| answer | `last_outcome` | `delivered_digest` | next run |
|---|---|---|---|
| 2xx on every post | `sent` | this digest | skipped until the catalogue changes |
| 401 / 503 on the first post | `retry` | kept | sends again |
| 400 / 413 / 422 on the first post | `failed` | kept | skipped until the digest changes or somebody forces a send |
| 500 / 502 / 504 / timeout / transport | `retry` | cleared | sends again |
| a refusal after an earlier post of the run was accepted | as above | cleared | as above |

`delivered_digest` must only describe what the portal holds, so it is cleared
whenever the portal MAY now hold something else; a cleared record re-sends
whatever the digest. Permissions: `POST /catalogue/send` (send now, even when
unchanged) needs the manage keys; `GET /status` → `catalogue` shows each
company's row.

## Where the code is

- `backend/src/db/migrations-pg/20260912T1800_scm_venture_portal_outbox.sql`
  — table, triggers, `vp_build_payloads`, `vp_requeue_undelivered`.
- `backend/src/db/migrations-pg/20260923T1843_scm_vp_catalogue_feed.sql` —
  the catalogue builder, digest, snapshot and money guard, the state table, and
  `vp_build_payloads` with the `variants` allowlist.
- `backend/src/db/migrations-pg/20260924T1100_scm_vp_catalogue_live.sql` —
  the change marks and the statement triggers that write them.
- `backend/src/db/migrations-pg/*_scm_vp_order_fair.sql` — the `fair` key,
  the capture trigger's event columns and `trg_vp_outbox_project`; executed
  by `backend/tests-pg/vpOrderFair.pg.test.ts`.
- `backend/src/scm/lib/venture-portal-catalogue.ts` — the catalogue sender
  (URL, digest decision, section split, response verdict); its SQL is
  executed by `backend/tests-pg/vpCatalogueFeed.pg.test.ts`.
- `backend/src/scm/lib/venture-portal-outbox.ts` — sender, response
  taxonomy, reconcile, secret minting.
- `backend/src/scm/lib/venture-portal-kick.ts` — the request-triggered drain
  middleware; the catalogue step rides the same task.
- `backend/src/scm/lib/venture-portal-feed-flag.ts` — switch + company
  scope, cached, fails closed to off.
- `backend/src/scm/routes/venture-portal-feed.ts` — the route surface.
- `frontend/src/lib/venturePortalFeed.ts` — shared logic for both UIs.
- `frontend/src/pages/VenturePortalFeed.tsx` (desktop),
  `frontend/src/mobile/MobileVenturePortalFeed.tsx` (mobile).
- `backend/scripts/check-venture-portal-latency.mjs` — the read-only
  save-to-portal latency measurement.
