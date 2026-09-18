# Salesperson Handover

Moves a salesperson's Sales Orders to another salesperson, and separately lets several salespeople share access to one order. `salesperson_id` is the key SO row-visibility filters on, so an order left on a departed rep is invisible to whoever now answers that customer — this module exists to fix that in bulk. Read `sales-order.md` first.

## Statuses and flow

Two separate operations, both bulk (up to 25 orders per call, `HANDOVER_BATCH_MAX`), both re-verifying each order at write time rather than trusting a stale list:

- **Hand them to** (`POST /apply`, `{fromStaffId, toStaffId, docNos[]}`) — moves attribution: one new owner, writes `salesperson_id` + `agent` + an AutoCount edit. Three-step UI: pick who's leaving, review the exact orders, pick who takes them.
- **Also give access to** (`POST /share`, `{staffIds[], docNos[], mode: add|remove}`) — grants or withdraws read/write access without moving attribution: any number of people, writes only `collaborator_staff_ids`. No primary among collaborators (owner ruling: equal access).

Both answer per-order (`{moved, skipped}` / `{changed, skipped}`), never a bare count — a partial application must be visible.

## Permissions

- `scm.so.attribute_other` gates `holders`, `preview`, `apply`, and `share` alike, plus the per-order `salespersonId` header PATCH on SO Detail.
- Signing/using either endpoint requires this one key; there is no separate key for sharing vs. reassigning.

## Rules that must not break

- `salesperson_id` is deliberately excluded from the SO identity lock; every other locked column stays frozen once a non-cancelled DO/SI exists.
- The `agent` (AutoCount rep name) field IS identity-locked, but a handover is allowed to change it *only* when it changed by following the salesperson (`agentFollowedSalesperson` flag) — a client-authored `agent` change stays locked. If this carve-out breaks, the symptom is a 409 naming `agent` on an otherwise legitimate handover.
- `/apply` re-reads each order at write time and skips any whose `salesperson_id` no longer matches `fromStaffId` — never move an order based solely on the preview snapshot.
- `access_staff_ids` (what every scoped SO read filters on) is DERIVED by a DB trigger from `salesperson_id` + `collaborator_staff_ids` — only ever write `collaborator_staff_ids`; never write the derived column directly.
- The two migrations that added collaborator support (the table alter and the view that carries it) must ship together — the table alone breaks the SO list with a 500 for every user.
- Sharing's reach is Sales Orders only, by owner ruling — Delivery Orders, Sales Invoices, Delivery Returns, Consignment Orders, quotes, reports and AR still filter on `salesperson_id` alone, because those documents snapshot the rep who sold it for commission.
- `/apply` checks the migrated-SO lock (it writes `agent`, an AutoCount field) and refuses per-order into `skipped[]` rather than 409ing the whole batch; `/share` deliberately does NOT check that lock (nothing it writes syncs to AutoCount).

## Gotchas

- Use `GET /so-handover/holders` for the "From" picker, not `GET /staff` — the roster buckets an AutoCount-imported rep with no ERP login onto the 2990 mirror company, hiding them even though their orders are in the active company; switching company doesn't help since the person and the orders then live in different company scopes.
- A migrated order inside a batch lands in `skipped[]` with its own reason instead of failing the whole request — always check `skipped[]`, a 200 does not mean every order moved.
- Sharing alone does not fix the AutoCount book or the SO list's displayed rep — if a departed rep must stop being named there, run "Hand them to" as well, not just "Also give access to".
- There is no "replace" mode on `/share`, only `add` / `remove` — an unrecognised mode falls back to `add`. A replace was rejected on purpose: it would silently drop a grant someone else made.
- A share that already exists reports as `skipped`, not `changed` — a second identical grant is a no-op and the response says so.
- The "Shared with" field is absent (not blank) on an unshared order — most orders have no collaborators, and rendering blank rows everywhere would train people to stop reading the field.

## Where the code is

- `backend/src/scm/routes/so-handover.ts` — holders/preview/apply/share routes.
- `backend/src/scm/shared/so-identity-lock.ts` — identity lock + the `agent` carve-out.
- `backend/src/scm/lib/so-agent.ts` — `followSalespersonToAgent`.
- `backend/src/db/migrations-pg/20260909T1000_scm_so_collaborator_staff_ids.sql`, `20260909T1001_scm_so_payment_totals_view_carries_collaborators.sql` — collaborator columns + trigger + view.
- `frontend/src/pages/scm-v2/SalespersonHandover.tsx` — the panel on SO Maintenance.
- `frontend/src/vendor/scm/lib/so-collaborators.ts` — id-to-name resolution shared by desktop/mobile.
- `backend/scripts/check-so-holders.mjs` — read-only diagnostic for who actually holds orders.
