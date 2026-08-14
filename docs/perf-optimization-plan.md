# Houzs ERP — Performance & Rendering Optimization Plan

System-wide status doc / work checklist. Built from: (a) live Chrome
Performance traces on prod (long-task / main-thread profiling, not just network),
(b) a full mining of HOOKKA's `BUG-HISTORY.md` for caching/version/render
pitfalls, and (c) an exhaustive per-module codebase audit (every SCM page, every
non-SCM page, the whole mobile tree, and the shared shell).

Purpose: every remaining work item, scoped by file + line + priority, so sections
can be handed out. Check items off as they land.

---

## 摘要 (owner TL;DR)

- 我用 trace 把「卡」的真凶抓出来了:**不是热身、不是缓存,是加载瞬间的主线程长任务**(JS 解析执行 + 每页数据加工)。热的时候 TTFB 才 31ms,大列表也已经虚拟化(1141 行 DOM 里只有 58 行,滚动零长任务)。
- 全系统审计后,几乎所有性能问题都归到**两个根因**:①很多列表**没有虚拟滚动**(渲染全部行);②很多列表 fetch **没有 limit**(或用 500/1000 一次拉全量再前端过滤)。
- 手机层还有一个大头:**整个手机层没有代码分包**,22 个页面一次性打包 → 首次进手机要下载+解析一个巨大 chunk = 我 trace 到的那个长任务。
- 「没权限就砍掉、连 load 都不 load」这条 —— **全系统审计结果:已经做对了**。没有发现「先加载再隐藏」的违规,gated 导航都是直接 return null、gated 请求都用 enabled:false。只有 3 个极小的可优化点。
- 下面按根因 + 按模块列了每一条(带文件行号),分好了 A–G 段可以派人做。

---

## Trace-based jank classification (what "卡" actually is)

Measured live on `/scm/products` (the ~1141-SKU list), warm:

| Cause | Measurement | Verdict |
|-------|-------------|---------|
| Warmup (cold-start) | warm TTFB **31ms**; cold ~400ms post-deploy only, keep-warm cron self-heals in 5min | "等" not "卡"; only right after a deploy |
| Cache | invalidation beats staleTime + epoch read-after-write guard; the one `Infinity` risk fixed (#419) | not a jank source |
| **Render (the real "卡")** | big lists ARE virtualized (58 DOM rows, **scroll long-tasks = 0**). Jank = **2× ~110ms long tasks at load, 147ms total blocking** | **JS eval + per-page data processing blocking the main thread** |

So the fixes that actually kill lag are: **row windowing**, **capping list fetches**,
**mobile code-splitting**, and a few **O(n²) render hotspots** — NOT chasing warmup
or cache (already handled). Measurement caveat: a CDP-driven tab is background-
throttled (timers clamp to 1s, rAF stops), so per-frame scroll numbers need the tab
foregrounded; buffered long-task capture at load is unaffected and is what's cited.

---

## 0a. Second-pass RESULTS — re-measured on prod after every PR shipped

Seven PRs (#1458-#1464), all behaviour-preserving. Measured the same way before
and after: real navigations, `PerformanceResourceTiming`, company 2990 HOME.

| | before | after |
|---|---|---|
| `/assr` usable | 1983 ms | **778 ms** |
| `/team` usable | 1989 ms | **694 ms** |
| `/team` slowest avatar | 1147 ms | **41 ms** |
| `/scm/inventory` DOM nodes | 11,963 | **2,783** |
| `/scm/inventory` usable | 1560 ms | **896 ms** |
| `/scm/product-models` usable | 1361 ms | **786 ms** |
| `/scm/product-models` slowest photo | 665 ms | **24 ms** |
| `/api/auth/me` | 381-1054 ms | **90 ms** |
| `/api/assr/summary` | 306 ms | 247 ms |
| `/api/scm/purchase-invoices` | 893-966 ms | **~670 ms** |
| `/api/scm/mfg-purchase-orders` | 915 ms | **783 ms** |
| `/api/scm/grns` | 814 ms | **739 ms** |

### Read this before trusting any single number here

The first post-deploy sample of `/api/scm/purchase-invoices` came back at
**1481 ms** — worse than before the fix. Four consecutive samples immediately
after: **677, 691, 646, 660 ms**. The 1481 was a cold connection, and reporting
it would have manufactured a regression that does not exist.

This is the same variance documented as N2 below (`/api/branding` measured at
148 ms and 833 ms minutes apart; `/api/auth/me` at 110 ms and 1054 ms). **One
sample of a Hyperdrive-backed endpoint is not a measurement.** Take three or
more, and quote the cluster, not the extreme.

### What shipped

| PR | change |
|---|---|
| #1458 | `/auth/me` stopped awaiting a DELETE; `/assr/summary` 13 serial aggregates → one wave; the assr list 4 serial round trips → 2; mig 0232 index; logos 500 KB → 112 KB |
| #1459 | avatars: `immutable` when `?k` matches the current R2 key |
| #1460 | five photo proxies: same, on keys already proven unique per upload |
| #1461 | `DataTable` windows expandable tables while collapsed |
| #1462 | the PO-chain enrichment pair, serial in all three purchase lists → one wave |
| #1463 | four assr lookup lists cached 5 min, plus the writer-side invalidation that makes that safe |
| #1464 | inbox + announcements-banner cache FILL moved off the response path |

### Deliberately NOT done, with the reason

- **`scan-so.ts` photo keys** are `scan-jobs/<jobId>/<i>` — positional, not
  per-object. A re-run can write different bytes under the same key, so that url
  does not name a fixed object. Excluded from the `immutable` sweep.
- **Retiring the `stage_since` correlated subquery.** `assr_cases.stage_entered_at`
  carries the same fact since mig 074, but only for rows written after it. Dropping
  the subselect would change what older cases display.
- **`configCache.ts` `bumpConfigVersion`** stayed awaited — it is a correctness
  barrier, not a cache fill.
- **The Service Case detail's second fetch of the same case** is CORRECT, not a
  duplicate: `mark-opened` can advance a case's stage, and the reload is gated on
  the server answering `advanced: true`. Verified on ASSR/2607-074, which was
  "Review" in the list and "Verification" after opening.
- **Hyperdrive keep-warm tuning.** The `*/5` cron pings `SELECT 1`, which warms
  one connection; requests are served from many isolates/PoPs (this session's
  traffic came through KUL against an ap-southeast-1 database). Widening it is
  guessing at pool internals — it needs a measured experiment, not a code change.

### Still open, in rough value order

1. **The shell tax** (N1) — the biggest remaining win and the riskiest.
2. **`/api/scm/purchase-invoices` runs the LEGACY non-paginated path** — the
   frontend sends no `page`, so it pulls `limit=500` with three embedded joins.
   Switching changes the response shape.
3. **Cold-start variance** (N2) — config, not code.
4. **`total JS (gzip)` over its 1800 KB ceiling** — hygiene; the INITIAL bundle
   is 151 KB against a 165 KB ceiling, so this is not user-facing today.
5. **`_headers` is still being overridden at the zone.** Verified live on
   2026-08-01: `/sw.js` returns `max-age=14400, must-revalidate` where `_headers`
   asks for `max-age=0`, and `/assets3/*.js` returns `max-age=14400`. The
   `must-revalidate` survives and only the number is rewritten — the signature in
   the existing ⚠️ OPEN owner action. Note a **Cache Rule** outranks the
   Caching → Configuration setting, so check Rules → Cache Rules too. This also
   caps the `immutable` headers above at 4 hours rather than a year.

---

## 0b. Second pass — measured live on prod 2026-08-01 (logged in, company 2990 HOME)

Method: real navigations against `erp.houzscentury.com`, reading `PerformanceResourceTiming`
per page. "usable" = when the LAST API call of the page settles.

**The headline: rendering is NOT the bottleneck any more.** Main-thread blocking
measured **0 ms with 0 long tasks on every page tested** (Overview, Service Cases,
SO, DO, PO, GRN, PI, SI, Inventory, Projects). The first campaign's windowing +
mobile-split work did its job. What is left is server latency.

| page | usable | dominant cost |
|---|---|---|
| `/assr` | **1983 ms** | shell tax + summary |
| `/scm/inventory` | 1560 ms | `inventory/products` 781ms + see W6 below |
| `/scm/purchase-invoices` | 1498 ms | `/api/scm/purchase-invoices` **966 ms** |
| `/scm/purchase-orders` | 1434 ms | `/api/scm/mfg-purchase-orders` **915 ms** |
| `/scm/grns` | 1354 ms | `/api/scm/grns` **814 ms** |
| `/scm/sales-orders` | 840 ms | — |
| `/projects` | 738 ms | — |

New findings, none of which are in section 1:

- [x] **A1 — `/api/auth/me` awaited a WRITE.** `pruneExpiredSessions` (a
  `DELETE FROM sessions`) was awaited inside `/me`, which sits at the head of
  every page load. `sessions(expires_at)` is indexed so it never scanned, but the
  round trip was charged to every navigation. Moved to `waitUntil`. The app's own
  `[perf] slow` logger caught `/api/auth/me` at **847 ms** live. FIXED.
- [x] **A2 — `/api/assr/summary` ran 13 aggregates serially.** One concurrent
  wave now. FIXED.
- [x] **A3 — the Service Case list made 4 serial round trips** (2 visibility
  reads, then COUNT, then the page). Now 2 waves. FIXED.
- [x] **A4 — `assr_activity` had no index covering the `stage_since` subquery.**
  Mig 0232. FIXED.
- [x] **A5 — 500 KB of logo PNGs on first paint.** `logo-wordmark.png` was
  **12088x3544** for a ~400px render (30x oversampled). Resized + recompressed:
  500 KB -> 112 KB, alpha kept. FIXED.
- [ ] **W6 (P0) — desktop `/scm/inventory` renders all 344 rows: 11,963 DOM
  nodes.** Root cause traced: `DataTable.tsx:288-292` makes row windowing a
  **no-op for grouped/expandable tables**, and Inventory's balances table is
  expandable (chevron -> variants). The largest list in the app is exactly the
  one the W1 windowing work excluded. Mobile is unaffected (same page at a narrow
  viewport = 1,573 nodes), so `MobileModuleList` windowing is working.
- [ ] **N1 (P0) — the shell tax.** Every full page load fires 6-8 requests that
  belong to no page: `auth/me`, `branding`, `companies`, `notifications`,
  `presence`, `presence/heartbeat`, `announcements/banner`, `inbox`, and they
  arrive in THREE serial waves (Overview: auth/me at 91ms -> wave 2 at ~494ms ->
  wave 3 at ~779ms, `assr/summary` settling at 1085ms). One `/api/bootstrap`
  would collapse both the count and the waterfall. Highest remaining single win;
  also the highest risk, because every page depends on it.
- [ ] **N2 — connection cold starts dominate the variance.** The SAME endpoint
  measured 148 ms and 833 ms (`/api/branding`), 110 ms and 847 ms (`/api/auth/me`)
  minutes apart. This is the Hyperdrive cold-pool behaviour `db/d1-compat.ts`
  already documents and retries. Tuning keep-warm is a config question, not a
  code one.
- [ ] **N3 — bundle is over its own ceiling.** `total JS (gzip) 1917.5 KB` vs the
  1800 KB budget in `scripts/check-bundle-size.mjs`; the gate fails on main.
- [ ] **N4 (P0) — one image request PER ROW, through the authenticated API.**
  This is a CLASS, not two incidents. `/team` fires ~20
  `/api/users/:id/profile-pic` (32 requests on the page, ~1s each behind the
  browser connection limit); `/scm/product-models` fires **57** requests, most of
  them `/product-models/:id/photo/:key`. Each costs a DB read plus an R2 GET.
  The avatar half is fixed (see below); the model-photo half already carries
  `public, max-age=3600` (`scm/routes/product-models.ts:84`), so it is bounded
  but still 57 cold requests. The durable answer for both is fewer requests, not
  longer TTLs: return the bytes' url in the LIST payload, or sprite/batch them.
  Sweep the other image endpoints for the same shape before adding a third.
- [x] **N4a — avatars are now cacheable.** `Avatar.tsx` already appended the R2
  key as `?k=`, and keys carry a `Date.now()` prefix, so a url bearing the
  CURRENT key names exactly one immutable object. `GET /users/:id/profile-pic`
  now serves `immutable` for a year when `?k` MATCHES the row's key, and keeps
  the old 300s when it is absent or stale — pinning a mismatched pair would
  freeze the new image under the old url. Logic + tests in
  `backend/src/lib/avatar-cache.ts`. FIXED.
- [ ] **N5 — `/api/branding` is fetched on every page and cached 300s**
  (`routes/branding.ts:204`) for a payload that changes almost never. It was the
  slowest call on five of the 49 routes swept, peaking at 833ms. A longer TTL
  (it already self-heals in 10 min client-side, see section 0) or an edge cache
  is the cheap win; G1 says never `Infinity`.
- Techniques confirmed ALREADY PRESENT (do not re-propose): route hover prefetch
  (`Sidebar.tsx` -> `lib/prefetch-routes`), `content-visibility: auto`
  (`DataTable.tsx:2359`), route + mobile `React.lazy`, modulePreload filtering,
  Rolldown chunk groups, staleTime/gcTime, localStorage query snapshot,
  cross-tab invalidation, 623 Postgres indexes incl. trigram GIN.
  NOT present, still available: `queryClient.prefetchQuery` on hover (today the
  hover prefetches the CHUNK but not the DATA), `useDeferredValue`/
  `startTransition` for filter input, a Web Worker for xlsx/jspdf export, edge
  caching for `branding`/`companies`.

### The full sweep — 49 routes, full page load, sorted slowest first

`usable` = when the last API call settles. `block` = main-thread blocking
(long-task time over 50ms). **Every row measured `block 0ms`.** That is the
finding: at today's data volumes this app has no rendering problem outside the
single Inventory row below.

| route | usable | api | slowest call | dom | rows |
|---|---|---|---|---|---|
| `/assr` | 1983 | 7 | branding 352 | 1539 | 8 |
| `/team` | 1989 | **32** | users/:id/profile-pic 1147 | 2932 | 43 |
| `/scm/inventory` | 1560 | 10 | inventory/products 781 | **11963** | **344** |
| `/scm/products` | 1570 | 11 | maintenance-config 390 | 2537 | 48 |
| `/scm/purchase-invoices` | 1498 | 9 | purchase-invoices **966** | 1461 | 2 |
| `/scm/purchase-orders` | 1434 | 10 | mfg-purchase-orders **915** | 1400 | 2 |
| `/scm/product-models` | 1361 | **57** | product-models/:id 665 | 2891 | 65 |
| `/scm/grns` | 1354 | 9 | grns **814** | 1430 | 2 |
| `/scm/delivery-planning` | 1293 | 12 | delivery-planning 553 | 5374 | 48 |
| `/scm/warehouses/racks` | 1237 | 11 | auth/me 533 | 955 | 0 |
| `/scm/consignment-orders` | 1150 | 10 | branding 535 | 1246 | 1 |
| `/scm/outstanding` | 1086 | 10 | outstanding/summary 595 | 1558 | 50 |
| `/announcements` | 1068 | 12 | auth/me 501 | 1090 | 0 |
| `/scm/trips` | 1044 | 12 | delivery-planning 509 | 3047 | 21 |
| `/system-health` | 1023 | 12 | admin/health/live 519 | 1437 | 44 |
| `/scm/unbilled-deliveries` | 1016 | 9 | unbilled-deliveries 522 | 1238 | 1 |
| `/mail-center` | 1005 | 12 | branding 377 | 1098 | 0 |
| `/settings` | 997 | 9 | branding 508 | 896 | 0 |
| `/scm/mrp` | 929 | 9 | mrp 429 | 1247 | 19 |
| `/scm/stock-transfers` | 870 | 10 | staff 365 | 1187 | 1 |
| `/scm/maintenance` | 861 | 12 | maintenance-config 354 | 2536 | 48 |
| `/my-cases` | 856 | 9 | assr/my-cases 363 | 2473 | 0 |
| `/scm/sales-orders` | 840 | 10 | mfg-sales-orders 299 | 2651 | 28 |
| `/scm/suppliers` | 844 | 9 | notifications 191 | 1219 | 13 |
| `/scm/hr/commission` | 786 | 10 | hr/commission 295 | 976 | 5 |
| `/scm/sales-orders/maintenance` | 774 | 15 | announcements/banner 521 | 1011 | 4 |
| `/scm/lorry-capacity` | 746 | 9 | announcements/banner 527 | 2067 | 27 |
| `/scm/delivery-orders` | 746 | 10 | staff 212 | 1490 | 1 |
| `/scm/sales-invoices` | 745 | 10 | sales-invoices 196 | 1519 | 1 |
| `/projects` | 738 | 13 | projects/summary 201 | 1028 | 0 |
| `/scm/fleet` | 734 | 12 | announcements/banner 517 | 1968 | 63 |
| `/sales` | 732 | 11 | branding 301 | 941 | 0 |
| `/scm/po-amendments` | 711 | 11 | so-amendments 201 | 1041 | 4 |
| `/scm/delivery-returns` | 706 | 10 | staff 193 | 1408 | 1 |
| `/scm/consignment-notes` | 699 | 10 | notifications 186 | 1169 | 1 |
| `/scm/stock-adjustments` | 698 | 11 | staff 186 | 1199 | 1 |
| `/scm/warehouses` | 676 | 9 | notifications 189 | 1154 | 8 |
| `/scm/accounting` | 655 | 9 | notifications 446 | 1209 | 6 |
| `/fleet-health` | 655 | 9 | notifications 176 | 1533 | 27 |
| `/scm/purchase-returns` | 651 | 9 | notifications 183 | 1241 | 1 |
| `/scm/fabric-tracking` | 646 | 9 | notifications 180 | 2083 | 47 |
| `/scm/payment-vouchers` | 628 | 9 | notifications 183 | 1017 | 1 |
| `/scm/delivery-zones` | 617 | 9 | notifications 184 | 1009 | 1 |
| `/scm/stock-takes` | 615 | 9 | stock-takes 129 | 1192 | 1 |
| `/scm/categories` | 615 | 9 | notifications 189 | 1095 | 0 |
| `/scm/finance` | 527 | 8 | announcements/banner 297 | 926 | 0 |
| `/scm/procurement` | 448 | 8 | notifications 185 | 963 | 0 |
| `/` (Overview) | 1085 | 11 | auth/me 381 | 997 | 0 |

### Interactions — SPA navigation does NOT pay the shell tax

Important correction to how the table above reads: those are FULL PAGE LOADS.
In normal use staff navigate inside the SPA, which skips the 6-8 shell requests
entirely. Measured on the SO list:

| interaction | new API calls | block | dom |
|---|---|---|---|
| expand a row's chevron | 0 (line items ride the list payload) | 0ms | +9 |
| click a row -> quick view drawer | 1, `mfg-sales-orders/:docNo` **741ms** | 0ms | +97 |
| drawer -> "Open full page" | 3, 540ms total; **0 lazy chunks** (hover prefetch had it) | 0ms | rebuild |

So the felt cost of a click is ONE endpoint's latency, nothing else. The hover
route-prefetch is doing its job — a detail page fetches no JS at all.
Small waste: the drawer and the full page fetch the SAME document under
different cache keys, so opening one then the other requests it twice.

**Coverage honesty:** 49 of ~90 routes measured plus the three interactions
above. NOT measured: `/new` create forms, most `/:id` detail pages, dropdown
menus and modals, and the four `/scm/reports/*` pages.

---

## 0. Shipped this campaign (verified live)

- [x] **mig 0104** — pg_trgm GIN + partial indexes on `scm.mfg_products` + fabric tables.
- [x] **SO-list read parallelization** (#416) — 6 serial enrichment reads → one wave. **388ms → ~40ms warm.** Backs desktop + mobile Orders.
- [x] **Presence dedupe** (#415) — 2× poll+heartbeat per page → one shared singleton.
- [x] **Branding cache, bounded** (#414 + #419) — 30s/nav refetch → 10-min self-healing (NOT Infinity, see G1).
- [x] **Mobile FabricPicker render cap** (interim; superseded by W4 windowing).

---

## 1. The two root causes + full per-module work list

Almost every HIGH item is one of: **(A) no row windowing** or **(B) list fetch with
no `limit`**. Fixing the shared pieces cascades across many pages.

### 1A. Windowing (render-only-what's-scrolled)

- [x] **W1 (P0) — DONE (PR #430, owner chose option b: keep page-scroll).**
  DataTable now window-scrolls past 30 flat rows: capturing window scroll listener
  (catches any ancestor's scroll), spacer `<tr>`s reserving off-screen height,
  row-height measured from a real row (no getTotalSize drift). Gated so grouped/
  expandable/short tables are byte-identical (no UX change anywhere). VERIFIED on
  /team (86 members): 46 rendered + 1800px spacer, real distinct rows, no-op safe.
  Caveat: live scroll-recycle couldn't be exercised (the CDP test tab is background-
  throttled → rAF starved), but the measure() logic produced a correct window and
  rAF fires normally in any foreground tab. Original scoping notes kept below.
  ~~NEEDS A UX DECISION~~ — resolved: option b.
  `DataGrid` virtualizes because it has its OWN fixed-height inner scroll container;
  `DataTable` is PAGE-scrolled (no inner scroll pane). To window it we must either
  (a) give every DataTable page an inner fixed-height scroll pane — a visible
  UX/feel change (inner scroll vs page scroll, sticky header sticks to the pane), or
  (b) implement window-scroll windowing (the react-virtual-shim only reads a
  container's scrollTop, so this needs extending — more code). ALSO: no current page
  exceeds the 25-row threshold (the big lists all use the already-virtual DataGrid;
  DataTable pages currently hold small data), so there is ZERO payoff today AND no way
  to verify against real data. Recommendation: keep page-scroll (option b) so the feel
  is unchanged, implement behind a threshold so it's a no-op below N rows, and verify
  with synthetic data before shipping. Deferred pending that decision — it's the only
  P0 that isn't a safe immediate ship. Reuse the DataGrid playbook (spacer rows,
  total = length × ROW_HEIGHT not getTotalSize (HOOKKA 4a), portal row dropdowns (4b)).
- [ ] **W2 (P0) — Stop building the hidden mobile CardsGrid on desktop.**
  ListV2 pages keep the `md:hidden` `CardsGrid` mounted (CSS-hidden) on desktop →
  ~2× row nodes. Gate by viewport so only one branch mounts.
- [~] **W3 (P1) — Mobile card lists.** Reusable `mobile/MobileVirtualList.tsx`
  built (window-scroll, spacer divs, measured card height, gated >40 items).
  - [x] `MobileModuleList` (PR #433) — VERIFIED: products list 1326 records →
    **28 cards in DOM** + 105k px spacer. Covers products/inventory + all doc modules.
  - [x] `MobileServiceCase` (PR #434) — VERIFIED: 200 cases → **23 cards in DOM** +
    26k px spacer (estimateHeight 132 for the taller stepper cards).
  - [ ] Remaining, adopt the same component: `MobilePMS.tsx:476` (200 project cards),
    `MobileMailCenter.tsx:337` (threads), `MobileDeliveryPlanning.tsx:614` (full
    history), `MobileSalesOrders.tsx:419` (small today — future-proof).
- [ ] **W4 (P1) — `StockTakeDetail.tsx:490`** — ~1141 rows of **live controlled
  inputs**; heaviest per-row. Window, keep edited row realized.
- [ ] **W5 (P1) — `MailCenter/Inbox.tsx:308`** + **`Team.tsx:1381/1366`** —
  thread list + member grid/table unwindowed.

### 1B. Cap the unbounded list fetches

- [ ] **B1 (P0) — `Projects.tsx:999`** — status pill fetches **`per_page:1000`** to
  filter client-side (status has no server param). Add server-side `status` filter.
  Worst hot-path scaling in the app.
- [ ] **B2 (P0) — `ServiceCases.tsx:1135` + `:1352`** — Board and Calendar each
  fetch **`per_page:500`** full rows, **not shared** (same data pulled twice on the
  hot triage tab). Share one query / lower cap / select card columns only.
- [ ] **B3 (P0) — `Sales.tsx:200`** — `/api/sales/entries` sends **no limit**;
  refetches full slice on every filter/tab change → non-virtual table (`:565`).
  Add `per_page` + pagination.
- [ ] **B4 (P1) — `Team.tsx:315`** — `/api/users` no limit **+ 7 queries on mount**
  (users/invitations/roles/departments/positions/presence/companies) all block first
  paint. Cap users; lazy-load roles/companies/presence.
- [ ] **B5 (P1) — `MailCenter/Inbox.tsx:760` + `MobileMailCenter.tsx:199`** — thread
  list unbounded (desktop + mobile). Paginate.
- [ ] **B6 (P1) — `MyCases.tsx:79`** — `/api/assr/my-cases` no limit, all cards
  unwindowed. Server limit + "load more".
- [ ] **B7 (P1) — `Projects.tsx:4581/4595`** — every ProjectDetail open fires **two**
  unbounded `/api/users` fetches. Fetch one scoped list, derive PIC client-side.
- [ ] **B8 (P1) — `ProjectChat.tsx:95`** — self-fetch + post-send refetch pull the
  project's **entire** activity history (no `?limit`). Add limit + scroll-up paging.
- [ ] **B9 (P1) — mobile no-limit fetches**: `MobileDeliveryPlanning.tsx:283`
  (`region=ALL&state=ALL`, all past stops), `MobilePOD.tsx:72` (`/delivery-orders-mfg`
  full list to pick one DO — add `limit`+`fields=minimal`).

### 1C. Mobile code-splitting (the measured load-time long task)

- [x] **C1 (P0) — `mobile/MobileApp.tsx`** — DONE (PR #426, verified on prod). All
  heavy screens → `React.lazy`; two Suspense boundaries (overlay + tab-content, so the
  tab bar never flashes); MobileModuleList stays eager (MODULE_CONFIGS used sync).
  Build: MobileApp chunk 64kB, big screens now on-demand. Verified: landing loads only
  MobileApp+SalesOrders; tapping Service lazy-loads MobileServiceCase on demand, tab bar
  stays mounted. This was the load-time long task the trace caught.

### 1D. O(n²) / per-render hotspots (cheap, targeted)

- [ ] **D1 (P1) — `ProjectMaintenance.tsx:1089`** — `findIndex` inside `items.map` =
  O(n²) per render, re-fired on every drag-hover. Precompute id→index Map in useMemo.
- [ ] **D2 (P1) — `ProjectMaintenance.tsx:1008`** — `blocks` rebuilt via inline
  `items.filter` per section every render. Group by `section_id` once in useMemo.
- [x] **D3 (P1) — `ProjectGantt.tsx:320`** — DONE (PR #429). Holiday-day list hoisted
  to a `useMemo` keyed on `range`; O(lanes×days) → O(days).
- [ ] **D4 (P2) — `Projects.tsx:1040`** — `columns` rebuilt every render → invalidates
  DataTable memos on each keystroke. useMemo.
- [ ] **D5 (P2) — `Announcements.tsx:705`** — `audienceLabel` rebuilds user/dept/pos
  Maps inside each row = O(rows×members). Build maps once in parent.

---

## 2. "Off, not hide" (cut-clean gating) — audit result: COMPLIANT

Full audit across shared components, mobile, SCM pages, and non-SCM pages found
**no fetch-then-hide / render-then-hide / fetch-then-filter violations.** Gated nav
returns `null` (absent, not greyed); permission-gated queries use `enabled:false`;
tabbed pages lazy-mount only the active tab. The established correct patterns:
`Sidebar.filterTab` (`:551`), `Gate.tsx` (`:42`), `useQuery` `enabled` (`:22`),
`Overview.tsx:57` (`enabled: can(...)`), `Team.tsx:276` (conditional tab mount).

Three MICRO items only (not violations, optional):
- [ ] **M1 (P2)** `TopNavbar.tsx:147` — `CompanySwitcher` fetches `/api/companies` for
  every user, renders `null` when ≤1 company (today's reality). Skip the fetch until a
  multi-company signal exists.
- [ ] **M2 (P2)** `Announcements.tsx:170` — read-only viewers fetch the full org
  directory (`/api/users`+`/api/departments`+`/api/positions`) to feed a Composer they
  can't use (partly used by the "To:" pill). Gate `enabled: canWrite` if the pill may
  show raw ids for non-writers.
- [ ] **M3 (P2)** `team/MemberOrgPerformance.tsx:113` — 3 ungated queries per member
  card; fine now, a perf note if cards grow.

---

## 3. Guardrails — HOOKKA pitfalls, with Houzs status

| # | Pitfall (HOOKKA) | Houzs status |
|---|------------------|--------------|
| G1 | `staleTime` gating refetch → stale after server change | SAFE-ish: invalidation beats staleTime + epoch guard. Rule: never `staleTime: Infinity` (fixed #419). |
| G2 | Client cache serving stale SHAPE; `ids ?? []` collapses absent→empty | AUDIT — treat absent as "not loaded → refetch", not empty default. |
| G3 | Mutation didn't broadcast invalidation | MOSTLY SAFE (MutationCache broadcast). `postBinary` doesn't auto-invalidate. Recurring sweep. |
| G4 | URL-keyed cache: control changes param but not key | AUDIT multi-tab date/filter controls. |
| G5 | SW shell cache not build-id-keyed → white screen after redeploy | TODO (D-below): `VERSION` is a manual constant (`sw.js:298` v170). Auto-derive from build hash. Mitigated by network-first HTML. |
| G6 | `respondWith(undefined)` → white screen | SAFE — both handlers always return a Response. |
| G7 | version-check only in one layout | AUDIT — `NewVersionBanner` at `App.tsx:236`; verify mobile reaches it. |
| G8 | `_headers` no-cache on `/` not `/*` → chunks 404 after deploy | SAFE — verified `/scm/*` returns `max-age=0, must-revalidate`; `/assets/*` immutable. |
| G9 | Snapshot freshness: Date≥string NaN; mark-stale race; serialize drops fields | FUTURE guardrail (if we build server snapshots, e.g. AR aging). Normalize timestamps to `getTime()`; DELETE-on-write; single-flight; declare fields; fail-toward-recompute. |
| G10 | trgm `CONCURRENTLY` in txn fails; extension dropped on staging clone | NOTE — 0104 non-concurrent (small tables OK). Large tables → out-of-band CONCURRENTLY. |
| G11 | Client filter/counts over server-paginated list = wrong | AUDIT — ties to B1/B2 (status filter client-side over a page). |
| G12 | Background refetch re-seeds a form, wipes edits | AUDIT (now caching is on) — edit forms hydrating from a fetch must seed-once-per-id + `!dirty` guard + nav-guard. |
| G13 | Debounce search; don't over-debounce saves | Mostly OK (`GlobalSearch` 180ms debounce). Spot-check. |

Good news already in place: heavy libs (`jspdf`/`xlsx`) are all `await import(...)`
lazy; polling is singleton + visibility-aware (presence/notifications/announcements);
no context re-render storms. `leaflet` is a dead dependency (imported nowhere) — drop
from `package.json`.

---

## 4. Deploy-staleness hardening

- [ ] **D-SW (P1)** — Derive `sw.js` `VERSION` from the Vite build hash so it auto-bumps
  every deploy (removes the manual-bump failure mode, G5).
- [ ] **D-MOB (P2)** — Confirm the mobile surface sits under `NewVersionBanner` (G7).
- [x] `_headers` deep-route no-cache (G8) — verified SAFE.
- [x] SW always returns a Response (G6) — SAFE.

---

## 5. Caching / search (as data grows — do NOT pre-optimize)

- [x] Reference dropdowns already TanStack-cached (vendored SCM).
- [ ] **C-DASH (P2)** — heavy dashboard/overview aggregations: longer bounded staleTime.
- [ ] **C-AR (P2, data-gated)** — AR aging `/api/scm/outstanding/summary` (~333ms):
  server snapshot candidate as debtor data grows — follow ALL of G9.
- [ ] **S-IDX (P2)** — trgm GIN on other searched columns (customer/supplier names).
- [ ] **S-STATS (P1)** — push search + tab counts to the server where lists paginate (G11).

---

## Delegation map (suggested sections)

| Section | Items | Owner | Independent? |
|---------|-------|-------|--------------|
| **A — DataTable windowing** | W1, W2, W5 | 1 frontend dev | Yes — biggest cascade |
| **B — Mobile perf** | C1 (lazy split), W3, W4, B9 | frontend (mobile) | Yes |
| **C — Cap list fetches** | B1, B2, B3, B4, B5, B6, B7, B8 | frontend | Yes — mostly independent per page |
| **D — Render hotspots** | D1, D2, D3, D4, D5 | frontend | Yes — small surgical fixes |
| **E — Cache-safety audits** | G2, G4, G11, G12, G13, M1, M2 | frontend | Yes — read-heavy |
| **F — Deploy hardening** | D-SW, D-MOB, drop leaflet | frontend/build | Yes — small |
| **G — Backend (data-gated)** | C-AR, S-IDX, S-STATS | backend | Later |

P0 = biggest felt win (windowing + mobile split + capping the 3 worst fetches).
P1 = next. P2 = as data grows.
