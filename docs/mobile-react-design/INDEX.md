# Houzs ERP Mobile — React (TSX) port · component index

React 19 + TypeScript + Vite · function components only · presentational (local `useState` only).
Mobile screens render inside a `.hz-m` CSS scope; components reuse the shared classes
(`.hdr .card .card-h .card-t .card-b .row .row-l .row-v .badge .chip .btn .btn-ghost
.btn-danger .fld .fld-l .fld-i .fld-ro .searchbar .empty .money`) — put those in `mobile.css`,
every selector prefixed `.hz-m `. The engineer wires routing, auth, permissions and the real API.

## Delivered (this drop)
| Component | File | Prototype screen | Notes |
|---|---|---|---|
| `MobileLogin` | MobileLogin.tsx | Login (#login) | role picker; `onLogin(role)` |
| `MobileSoList` + `Badge` | MobileSoList.tsx | Sales Orders list (#so-list) | `Badge` shared |
| `MobileSoDetail` | MobileSoDetail.tsx | SO detail (#so-detail) | **Locked create-form** + KPI + Edit-in-place + status action bar |
| `MobileNewSO` | MobileNewSO.tsx | New/Edit SO (#so-new) | editable form; Save draft / Create / Save changes |
| `MobileDeliveryPlanning` | MobileDeliveryPlanning.tsx | Run-sheet list (#m-planning) | Today/Tomorrow/History, balance-only |
| `MobilePlanningStop` | MobilePlanningStop.tsx | Stop detail (#plan-detail) | 3 kinds Delivery/Service/Project-Fair, OTW→Arrived→POD |
| `MobileList` / `MobileDetail` | MobileList.tsx | generic list + detail engine | ALL read-only modules |
| `ConfirmDialog` / `useConfirm` | ConfirmDialog.tsx | in-app confirm | never window.confirm |
| types | types.ts | — | shared types + `money()` |

## Still to port (same patterns — follow-up drop)
_None — all screens delivered._

## Full component list (final)
- `MobileLogin` · `MobileSoList` · **`MobileSoDetail`** (locked form) · `MobileNewSO` · `MobileScan` · `MobileAmendments` (SO-revision inbox: status chips, tap card → SO detail's amendment flow; reuses `useAmendments` + `resolveStatusPill`, no backend)
- `MobileDeliveryPlanning` · `MobilePlanningStop` (Delivery/Service/Project-Fair) · `MobilePOD`
- `MobilePMS` (project detail; tasklist has a **List / Gantt** toggle) · `MobileGantt` (timeline: section swim-lanes, week axis, due-date diamonds, holiday bands, today line; ports desktop `ProjectGantt`, no backend) · `MobileServiceCase` + `MobileServiceCaseNew`
- `MobileMailCenter` (list/thread/compose) · `MobileAnnouncements` (list/detail) · `MobileInbox` · `MobileCalendar`
- `MobileProfile` (+ settings sub-pages via `onOpen`)
- `MobileStockCard` (per-SKU on-hand + per-warehouse split + movement ledger with running balance; opened from an Inventory row; reuses inventory-queries hooks) · `MobileStockTransferNew` (From≠To + date + notes + SKU-picker lines with live avail-at-source guard; reuses `useCreateStockTransfer`)
- `MobileList` / `MobileDetail` — generic engine for every read-only module
- `MobileShell` — role-based bottom tabs (Orders · Service · Menu · Calendar · Profile) + menu sheet
- `ConfirmDialog` / `useConfirm` · `types.ts` · `mobile.css` (all `.hz-m`-scoped classes)

## Fidelity rules baked in
1. Document detail = the create form rendered locked (`.fld-ro`); Edit unlocks in place. Never a summary.
2. Only Sales Order / Project / Service Case have rich/editable screens. Everything else = generic read-only list + detail (`MobileList`/`MobileDetail`).
3. Money fields end `_centi`, divided by 100 via `money()`. Dates DDMMYYYY. No emoji.
4. Destructive actions use `<ConfirmDialog>` / `useConfirm()`.
5. **Nav/tab gating = the shared source, never a hand-copy.** The mobile shell (`src/mobile/MobileApp.tsx`) has no react-router, so it filters the shared `NAV_TABS` through `components/navFilter.makeNavVisible` — the SAME per-node predicate the desktop Sidebar + MobileTabBar use — for its menu, its Profile org rows, and its bottom tabs. A bottom tab whose destination the user can't reach mounts a locked placeholder, not its screen; leaked screen queries are `enabled:`-gated on the exact desktop capability. OFF, not hide (no render, no fetch). The "+" FAB eligibility (`auth/salesAccess.quickActionAccess`) is shared with the desktop `QuickActionsFAB`. Never re-implement a gate locally.
