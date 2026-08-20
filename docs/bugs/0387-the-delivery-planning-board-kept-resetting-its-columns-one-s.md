## The Delivery Planning board "kept resetting" its columns — one shared queue forked into per-company layout slots [medium]

<!-- area: Frontend + mobile -->

**白话.** 8 月 19 号老板报障:「Delivery Planning 的 layout 老是被重置,去看了一下 sales order 倒回去就没了,Service Cases 就不会」。查实布局其实一直有存,没有谁去删它——问题是这块板是 Houzs + 2990 **共用一条队列**,但布局却按「当前窗口的公司」分成两个槽存(本地 `dg-delivery-planning::c1` / `::c2`,服务器同样一公司一行)。窗口在哪家公司,板就读哪个槽:去看单据换了公司窗口再回来,读到的是**另一个槽里的旧布局**,看起来就像被重置了;在这边重排一次,又只存进这边的槽,两个槽永远各自为政。Service Cases 虽然也按公司分槽,但处理 case 从来不用切公司,所以永远撞不到。修法:四块共享队列板(Delivery Planning / Date & Time Arrangement / Last Mile)的布局改成**全公司共用一份**——本地一个不分公司的 key,服务器钉在一个固定槽上,读取时取最新的一份,保存时顺手把旧分叉清掉,老布局无缝带过来,不用重排。

**Symptom.** Owner 2026-08-19: the Delivery Planning board's column layout
"keeps resetting" — reproducibly after visiting a Sales Order and coming back.
Service Cases (DataTable) never does this. Storage forensics on the owner's
browser showed the layout was never lost: `dg-delivery-planning::c1` held an
arrangement frozen in time (it still ordered by `sched_date`, a column REMOVED
in the 2026-08-04 column pass) while `::c2` held the current one saved that
morning.

**Root cause.** Per-company layout scoping (owner 2026-07-24, right for the
per-tenant lists: "在 2990 sales order list 点选 column 会影响我在 Houzs 的
column") was also applied to the Delivery/TMS queue boards — but those render
ONE cross-company queue. The same physical board therefore kept one layout slot
per company, locally (`<storageKey>::c<id>`) and on the server
(`table_layouts` rows keyed by company), and the window's active company picked
the slot. Opening a document of the other company means switching to that
company's window; returning to the board then reads the OTHER slot — a stale
arrangement that reads as "reset". Re-arranging writes only that slot, so the
two forks diverge forever. Service Cases has the same scoping but no reason to
flip companies mid-flow, which is why it felt stable.

**Fix.** The four shared queue boards (`dg-delivery-planning`,
`dg-date-arrangement-v2`, `dg-trips-time-arrangement-v2`, `dg-last-mile`) are
now company-AGNOSTIC for the user's LIVE arrangement: one unscoped localStorage
key (the current company's slot demoted to a read-only seed so existing
arrangements carry over), and on the server (`routes/tableLayouts.ts`) their
rows pin to the caller's lowest visible company — GET serves the NEWEST row
whichever slot the fork left it in, and every save deletes the same-key live
rows under other companies, so the fork self-heals on first use with no data
migration. Company DEFAULTS and named layouts stay per-company on purpose.
Key list lives once per side: `SHARED_DATA_GRID_STORAGE_KEYS`
(dataGridLayoutStorage.ts) and `SHARED_TABLE_KEYS` (routes/tableLayouts.ts).

**Ref.** `fix/dg-shared-board-layout-0819`, 2026-08-19.
