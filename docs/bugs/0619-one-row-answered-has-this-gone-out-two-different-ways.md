## One row answered "has this gone out" two different ways [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner, 2026-09-02: 「同一套资料，系统自己在打架」. On the Sales
Order list, one row's **Status** cell read *In Production* while the **Delivered**
cell immediately beside it read **5 / 5**. Both are on the same response, both
are about the same question, and nothing on screen said which to believe.

**Root cause (traced).** Two cells, two sources, no reconciliation.

- **Status** rendered `statusFor(r.status)` — the STORED
  `mfg_sales_orders.status` column (`MfgSalesOrdersListV2.tsx`, the `status`
  column's `render`).
- **Delivered** rendered `shipped_qty / deliverable_qty`, derived LIVE from
  delivery-order coverage by `soDeliverableRemaining`, stamped onto the same row
  at `mfg-sales-orders.ts:1802-1806` (§0.4b, #2864).

The backend also stamps `delivery_state` and `lifecycle_state` onto that row at
`:1800-1806` — the two fields the shared display rule needs — but the frontend
`SoRow` type **never declared them**, so the Status column could not have read
them even had it wanted to. The rule itself already existed and was already in
use: `soStatusDisplay` (`vendor/scm/lib/so-status.ts`) is what the SO detail's
inline editor renders.

**Why the stored column goes stale, and stays stale.** `mfg_sales_orders.status`
is a denormalised cache with exactly ONE writer, `syncSoDeliveredFromDo`
(`scm/lib/so-delivery-sync.ts`), and all nine of its call sites are event hooks
on a delivery-order write **through a route**. There is no read-path
re-derivation, no cron, and no database trigger. So a delivery order created by
an import script, a backfill or hand-run SQL never advances its sales order — and
nothing ever will. That is not a hypothetical: `create-migrated-documents.mjs`
inserts delivery orders at `'DELIVERED'` with raw SQL and never calls the sync
(see `docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md`, which
fixes that script's money and records this).

**The fix does not resolve the disagreement. It shows it.** That is deliberate,
and it is the part worth reading before "simplifying" this later.

The stored value still decides which **TAB** counts the row — the tab strip is a
server-side aggregate over that same column (`mfg-sales-orders.ts:1319`). So
silently rendering the derived answer in the pill would file a row visibly under
a tab its own pill contradicts, and replace one confusion with a quieter one. The
row now renders the derived label AND, when it differs, a small marker naming the
stored status the tabs are counting it under, with a tooltip explaining why the
two can differ.

`so-list-status.ts` gains `soRowStatus`, the one resolver, taking the derive
function as a **required argument** so the module stays free of a vendor import
and the test proves the wiring rather than re-implementing it. Missing
`delivery_state` / `lifecycle_state` (an older cached bundle) falls back to the
stored status with **no** marker — "the payload predates the field" must read as
*nothing derived to say*, never as *nothing has shipped*, which is the same
refusal `shipped-progress.ts` makes with its own `unknown`.

**Test.** `so-list-status.rowStatus.test.ts`, wired to the REAL `soStatusDisplay`
and the REAL `shippedProgressOf` — one row, both cells, both live functions, so
the assertion is that the two agree rather than that a stand-in was called.
Covers the fully-shipped case, the partial case, agreement (no marker), a payload
carrying neither field, a terminal status, and On Hold. Proved RED by reverting
`soRowStatus` to always return the stored status: 4 of 10 fail.

An earlier draft of that file asserted `shipped.delivery_state === "full"`, which
the linter correctly called out as always true — a tautology dressed as a
cross-check. It is now the real `shippedProgressOf` call.

**STILL OPEN, and named so nobody reads this entry as closing the class.**

1. **The SO detail page has its own third copy.** `SalesOrderDetailV2.tsx:260`
   defines a LOCAL `statusFor` over its own `STATUS_TONE` and renders
   `statusFor(header.status)` — the stored column again. It is not wired to
   `soRowStatus`. **The list and the detail can still disagree with each other.**
2. **There are twelve hand-written `statusFor` copies** across `pages/scm-v2/`
   (SO detail, DO, GRN, PI, PO, PR, SI, stock takes, stock transfers, delivery
   returns, plus the two shared list modules). This entry unifies the SO list's;
   the rest are untouched.
3. **The stored column is still a cache nothing repairs.** The durable fix is a
   recompute below the application — a database-level reconcile that owns the
   header status, plus a nightly convergent sweep. That is what SAP does (a
   system-maintained status table plus shipped repair reports, on the standing
   assumption the cache drifts) and what Odoo avoids entirely with computed
   fields. Until then, `resync-so-delivered-status` is manual-dispatch only and
   is not in `docs/ac-resync-runbook.md`.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
