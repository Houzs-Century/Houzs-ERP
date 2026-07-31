# Houzs ERP — Performance & Rendering Optimization Plan

System-wide status doc / work checklist. Built from: (a) live Chrome
Performance traces on prod (long-task / main-thread profiling, not just network),
(b) a full mining of HOOKKA's `docs/BUG-HISTORY.md` for caching/version/render
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
- Techniques confirmed ALREADY PRESENT (do not re-propose): route hover prefetch
  (`Sidebar.tsx` -> `lib/prefetch-routes`), `content-visibility: auto`
  (`DataTable.tsx:2359`), route + mobile `React.lazy`, modulePreload filtering,
  Rolldown chunk groups, staleTime/gcTime, localStorage query snapshot,
  cross-tab invalidation, 623 Postgres indexes incl. trigram GIN.
  NOT present, still available: `queryClient.prefetchQuery` on hover (today the
  hover prefetches the CHUNK but not the DATA), `useDeferredValue`/
  `startTransition` for filter input, a Web Worker for xlsx/jspdf export, edge
  caching for `branding`/`companies`.

**Coverage honesty:** 10 of ~90 routes were measured, and one interaction
(expanding an SO row — which costs 0 new requests and 0 long tasks; line items
already ride the list payload). Detail pages, `/new` forms, dropdowns, modals and
the other ~80 routes are NOT yet measured.

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
