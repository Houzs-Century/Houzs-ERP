## The Personal KPI tile answered for the caller, whoever you picked [medium]

<!-- area: Sales orders + pricing -->

**白话.** 销售平板「我的订单」上面那两个数字卡片有两个毛病。第一，选了某个销售之后，
下面的订单列表换了人，上面的卡片没换 —— 名字是她的，数字还是你自己的，所以选谁看到
的都一样。第二，卡片写着「Showroom」，但对没有绑定展厅的人（总监 / 老板 / 协调员）
其实统计的是**整间公司**，所以两个人看同一个月会看到完全不同的总额，还以为系统坏了。
现在卡片会跟着选的人走，而且会说清楚统计的是展厅还是整间公司。

**Symptom.** Two, on the same two tiles.

1. Picking a salesperson in the My-orders toolbar re-filtered the BOARD but not
   the Personal tile: it kept the caller's own figures under the chosen person's
   name. A director checking two different salespeople saw the same
   `RM 2,990 · 2 orders` for both, because both were really his own.
2. The Showroom tile is scoped to the caller's showroom mates, or to the WHOLE
   COMPANY when the caller has no `showroom_id` (director / owner / coordinator).
   Both rendered under the word "Showroom", so the same month read RM 83,505 to
   one person and RM 22,870 to another and neither could tell why.

**Root cause (traced).** `/pos/sales-stats` read `?salesperson` and dropped it —
the route said so in its own docblock ("not yet honoured — the personal card
always follows the caller"). The board honoured it, so the two halves of one
screen answered different questions. The showroom half was never a defect in the
numbers, only in the word: `showroomWhere` degrades to `"true"` (the whole
company) when `me.showroom_id` is null, and nothing said so.

**Fix.** The route resolves `?salesperson` to a staff row and aggregates the
Personal card for THEM, and returns `staffName` for whoever it actually used, so
the name and the number cannot disagree again. It also returns
`showroomScope: 'showroom' | 'company'`, and the POS labels the tile from it —
"Company · August 2026" for a caller with no showroom.

🔑 **The gate is server-side, and that is the point.** The POS only offers the
picker to `canSeeAll`, but the param arrives from a browser: a salesperson could
send `?salesperson=<colleague>` by hand. So targeting is gated on
`canViewAllSales(c)` HERE. An unauthorised or unknown name falls back to the
CALLER's own id — never to "no filter", which would silently widen the tile to
the whole company and leak more than the original bug did.

**Nobody's numbers moved for the showroom half.** The mates query and its
whole-company default are untouched; only the label changed. A test asserts both,
so a later "tidy" cannot quietly turn the relabel into a rescope.

**Ref.** fix/sales-stats-salesperson-scope, 2026-08-19. The POS half is 2990's
PR (label + type).
