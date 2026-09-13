# Hand-off · Venture Portal feed — an API key this side generates, and seconds instead of five minutes

**From:** the Venture Portal side (repo `wenwei4046/Venture-Portal`), 2026-09-13.
**For:** whoever picks up `docs/modules/venture-portal-feed.md` next.
**Owner's ask, in his words:** 「那边 generate 一个 API key 出来；我这边只需要填那个 API key，它就可以 link 起来了；我要秒级 update 的。总之是 House ERP 那边 send 过来，我这边收。」

Labels follow this repo's working agreement: **PROVEN** = run and observed, **LIKELY** = consistent with what was read, **UNKNOWN** = not established.

---

## 0. TL;DR（白话）

现在这一页（Venture Portal Feed，PR #3751）**方向是对的**：ERP 送、Portal 收。老板要改两处：

1. **Key 由 ERP 生成**，不是老板自己想一串贴两边。页面加一个 **Generate API key** 按钮，生成后显示一次，老板复制到 Venture Portal 贴上就 link 好了。Portal 那边**不再需要** Vercel 的 `ERP_SYNC_SECRET`，也不需要老板输入 Receiver address（默认填好）。
2. **秒级**：不等五分钟的 cron。sales order 一存，同一个 request 结束后就把 outbox 送出去（`waitUntil`），cron 留着当保险。

其余全部不变：outbox、trigger、payload、`x-sync-secret`、回包处理、reconcile。

---

## 1. What exists today (PROVEN by reading `origin/main` at `c1e84392`, 2026-09-13)

| piece | where | state |
|---|---|---|
| capture | `scm.venture_portal_outbox` + three AFTER triggers, mig `20260912T1800` | unconditional, same transaction |
| sender | `backend/src/scm/lib/venture-portal-outbox.ts` `drainVenturePortalOutbox` | runs in the `*/5` cron (`backend/src/index.ts`), 25 per sweep (`VP_DRAIN_BATCH`) |
| backstop | `reconcileVenturePortalOutbox` | `*/30` cron |
| config | `scm.sync_config` `vp.url` / `vp.secret` / `vp.since`; switch + companies in `scm.app_config` `scm.venture_portal_feed` | all set from the page; secret write-only (`PUT /secret`, ≥ 32 chars) |
| probe | `POST /probe` → `GET <vp.url with /sales-orders → /health>` with `x-sync-secret` | answers the portal's `{ok:true,…}` |
| page | `frontend/src/pages/VenturePortalFeed.tsx`, mobile twin, logic in `frontend/src/lib/venturePortalFeed.ts` | live at `/venture-portal-feed`; the queue held 7 waiting on 2026-09-13 |

The portal's receiver (`POST https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders`) reads exactly the payload `scm.vp_build_payloads` builds, answers the taxonomy §6 of the module guide expects, and — since portal PR #117 (merged) — carries `outcome` in the 200 body (`applied` / `duplicate` / `stale` / `held` / `skipped` / `mixed`), which `readPortalOutcome` already reads from `outcome ?? result`.

**Done on the portal side (PRs #117 + #118, merged 2026-09-13, production follows main):** the receiver checks the incoming `x-sync-secret` against a key **pasted on the portal's own page** (Revenue → Fair → Commission Calculation → *Houzs ERP link*), kept in Supabase Vault. `ERP_SYNC_SECRET` on Vercel becomes optional. So the whole hand-shake is: this page generates the key → the owner pastes it on the portal → **Test connection** here answers 200 → Turn on.

---

## 2. Change 1 — the key is generated here, shown once

### Backend

- `POST /api/scm/venture-portal-feed/secret/generate` (MANAGE_KEYS, beside the existing `PUT /secret`):
  - mint 48 characters from `crypto.getRandomValues` (URL-safe base64; well over the portal's 32-character floor, `ERP_SYNC_SECRET_MIN_LENGTH` in `Venture-Portal src/lib/erp-sync/auth.ts` [external]);
  - store it exactly as `PUT /secret` does today (`scm.sync_config` `vp.secret`, `resetFeedFlagCache` if that path touches it);
  - answer `{ secret }` **once**. `GET /status` keeps answering length + last four only. Never log it. Audit it the way `PUT /secret` is audited (an `audit_events` row saying *a key was generated*, not the key).
- Keep `PUT /secret` for the paste-your-own case, or retire it — owner's call; the page below assumes Generate is the primary road.
- **Receiver address default.** When `vp.url` is empty, `GET /status` (or the page) offers `https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders` as the default so the owner never types it; `PUT /connection` stays as is (https only). The portal's link card shows the same address for copy-paste, so both sides agree.

### Page (desktop + mobile through the shared logic layer)

- In **Connection**: replace the free-text Shared secret box with **Generate API key** → a one-time reveal box (the key, a *Copy* button, and the sentence: *Paste this in the Venture Portal — Revenue › Fair › Commission Calculation › Houzs ERP link. It is not shown again; generate a new one to rotate.*) → after dismissal the box shows `key ····last4 · generated <when>` exactly as `GET /status` describes it today.
- **Rotation** = Generate again → paste on the portal. The window of 401s costs the queue nothing (`classifyVpResponse`: 401 does not consume an attempt) — say so on the page.
- Nothing else on the page changes.

---

## 3. Change 2 — seconds, not five minutes

The module guide §2 chose the Worker over pg_cron/pg_net, and this keeps that choice. The trigger already captures in the same transaction; what waits is only the **drain**. Kick it from the request that caused the change.

### Backend

- `kickVenturePortalDrain(env, ctx: ExecutionContext)` in `venture-portal-outbox.ts`:
  - `ctx.waitUntil(...)` a small task: wait ~1.5 s (so a burst of line edits on one order collapses into one delivery — the payload is built at send time), then `drainVenturePortalOutbox(env)`; if the sweep sent a full batch, sweep again, at most 4 sweeps per kick (100 documents) so a backfill or a POS rush clears in seconds rather than 100 minutes;
  - a module-level "last kick" timestamp so two writes 200 ms apart schedule one drain per isolate (best-effort; the cron is the guarantee, not this);
  - it must never throw into the request: everything inside `waitUntil`, errors logged as `[vp-kick]`.
- **Where to call it.** One place, not per handler: a Hono middleware after `next()` on every **non-GET** request under `/api/scm/*` (and `/api/pos/*` if the POS writes sales orders through its own router — UNKNOWN, check `backend/src/routes/pos.ts`) whose response is 2xx. A drain on an empty queue costs one cached flag read, one config read and one outbox read, which is inside the subrequest diet. Register it in `backend/src/scm/index.ts` next to `write-freeze` so it is visible where routers are mounted (the "where is this wired" table in the module guide gets a row).
- **Cron paths that change orders** (the stock-allocation sweep, anything else in `scheduled()` that touches `mfg_sales_orders*`) — call the kick at the end of the job, or accept the `*/5` backstop for those.
- Keep `*/5` drain and `*/30` reconcile exactly as they are — they are the zero-loss guarantee. Optionally add a `* * * * *` trigger for the drain so the worst case is one minute (the trigger cap comment in `wrangler.toml` says the cap is no longer the constraint).

### Expected latency (LIKELY, to be measured)

save → trigger (same transaction) → response → 1.5 s debounce → one POST (~0.3 s on the portal's dev server, contract §1) ≈ **2–3 s**. Measure it on the first real order and write the number into the module guide, not this estimate.

---

## 4. What must NOT change

Payload shape (`scm.vp_build_payloads`), the PII strip, the `x-sync-secret` header, `classifyVpResponse`, `VP_MAX_ATTEMPTS`, the three gates (switch / url / secret), the company scope, `vp.since`, the reconcile. The portal's contract (`docs/erp-sync/contract.md` [external] in the portal repo) is unchanged except §2 Auth (key pasted on the portal OR the Vercel env) and the `outcome` word — both merged and live.

---

## 5. Acceptance — the runs that prove it (paste their output; the working agreement's rule 3)

1. Generate API key on the page → `GET /status` shows `····last4`, the key appears nowhere else (grep the Worker log for it: 0 hits).
2. Paste it on the portal's link card → **Test connection** here → `200 {"ok":true,"service":"venture-portal",…}`.
3. Turn on (companies `1`, since `2026-08-01`).
4. Create one sales order in Houzs Century → within 5 s the portal's Comm Cal page lists it under *Recent deliveries* with `APPLIED`; the outbox row is `sent` with `portal_outcome = applied`. Record the measured seconds.
5. Edit that order's payment → a second delivery, `portal_outcome = applied`, and the portal's balance moved.
6. **Queue anything not delivered** → the backlog (493 in-scope orders on 2026-09-12) drains at ≥ 25 per sweep, 4 sweeps per kick; note the wall-clock it took. Deliveries for months whose commission run is applied come back `held` — expected, not a failure.
7. Turn off → create an order → nothing leaves; turn on → it leaves.

---

## 6. Open points

| | |
|---|---|
| Does the POS write sales orders through `/api/scm/mfg-sales-orders` or its own router? | UNKNOWN — decides whether the middleware needs a second mount |
| Do any DB-side paths change `mfg_sales_orders*` outside a Worker request (a migration backfill, a manual SQL)? | those are caught only by the `*/5` cron / `*/30` reconcile — acceptable, say so in the guide |
| Backfill throughput at ~500 documents | UNTESTED on both sides (module guide §11) |
