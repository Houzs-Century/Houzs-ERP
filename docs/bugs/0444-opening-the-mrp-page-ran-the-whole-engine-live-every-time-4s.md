## Opening the MRP page ran the whole engine live every time (~4s) [high]

<!-- area: Inventory, costing, FIFO -->

**白话.** 打开 MRP(库存状态)页面每次都要现算一整套引擎,约 4 秒。老板 2026-08-19
定了改成「算一次存起来」—— 就是 SAP / Oracle 那种做法:默认页面直接读存好的、**秒开**,
顶上标「截至几点」,旁边一个「重新计算」按钮,后台每 15 分钟自动刷新一次。一有筛选(分类/
仓库)或看未排期的,就照旧现算 —— **零风险**:表还没填之前等于没改,页面照旧现算。

**Symptom.** `GET /api/scm/mrp` ran `computeMrp` — the global cross-table demand-
vs-supply engine — LIVE on every open. Measured previously at **5,162 ms** for
company 1 (`docs/modules/mrp.md` §5 / the SO-list serialization entry).

**Root cause (traced).** The MRP GET handler (`mrp.ts`) called `computeMrp` with
NO stored result and no cache, so every page open recomputed the whole plan. The
cost is real engine work (stock / PO / SO / DO / allocation reads), not fan-out —
so the durable fix is to stop recomputing it on every open, which is how large
ERPs run MRP (a scheduled / on-demand "planning run", read from a stored result).

**Fix (option B, owner-chosen 2026-08-19: store + schedule(~15min) + manual).**
- `scm.mrp_snapshots` (mig `0313`) — one jsonb row per company. CACHE, not a book
  of record; `DROP TABLE` reverses it.
- `GET /mrp` serves the stored snapshot for the DEFAULT view (`isDefaultMrpView`:
  no category/warehouse filter, undated hidden) — **instant**; any filtered/undated
  view, or a company with no snapshot yet, computes live exactly as before. Served
  only for the default view because `catFilter`/`whFilter` change the ALLOCATION
  inputs (not just output rows), so a stored full result cannot be post-filtered.
- `POST /mrp/regenerate` (manual Regenerate) + a `*/15` Worker cron
  (`refreshAllMrpSnapshots`) keep it fresh. FE shows "as of &lt;computedAt&gt;" and
  a Regenerate button (`mrp-queries.ts` `useRegenerateMrp`, `Mrp.tsx`).
- **Additive / zero-risk:** no snapshot row -> live compute (today's behaviour),
  so this is inert until first populated.

**Measurement.** Before: ~5,162 ms (recorded above). After (snapshot read): the
GET becomes a single `mrp_snapshots` row read — **UNMEASURED on prod until deploy**
(the branch is not deployed; prod is behind login). The `*/15` cron and
`POST /regenerate` runtime behaviour are likewise **UNTESTED until the first
deploy** — the cron slot's log line `[cron mrp-snapshot] company=… computedAt=…`
is the check to read (`gh api .../runs` + Worker logs), and the fingerprint of the
stored result vs a live `computeMrp` is the byte-identical proof to run before
trusting the snapshot.
