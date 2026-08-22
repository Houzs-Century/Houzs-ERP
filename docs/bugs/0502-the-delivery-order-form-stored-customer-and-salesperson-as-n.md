## The Delivery Order form stored customer and salesperson as names, not codes [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** Owner, 2026-08-21: *"系统里又有收 Name 又有收 Code 的，全套系统都要统一收
Code."* Two visible tells on the Delivery Order side: the DO list's **Salesperson
column showed "—"** for delivery orders created straight on the DO form (never
from an SO), and a Sales Invoice raised **from** such a DO inherited a blank
debtor code / salesperson id. The DO carried the customer's and salesperson's
NAME only, while Sales Order and Sales Invoice carry the CODE.

**Root cause (traced).** `DeliveryOrderNewV2.tsx` captured the customer as a
free-text name (`customerName` → `debtorName`, no `debtorCode`) and the
salesperson as a free-text name string (`salesperson` → `agent`), where
`SalesOrderNew.tsx` captures `debtorCode` + `debtorName` and `salespersonId`. The
`scm.delivery_orders` table already has `debtor_code` and `salesperson_id`
columns and all three write endpoints (POST `/`, `/from-sos`, PATCH `/:id`)
already ACCEPT `debtorCode` + `salespersonId` — the form simply never sent them,
so they persisted as null. The DO-list Salesperson column reads ONLY
`salespersonNameOf(null, r.salesperson_id, …)` (not `.agent`), which is why an
ad-hoc DO showed "—". The free-text salesperson field also carried its own known
hazard: a raw UUID could leak into the name string and be saved to `agent` (the
re-resolve effect at the old lines 683-700 existed to patch that).

**Fix.** `feat/do-form-code` — a **frontend-only** change (no migration; the
columns and endpoints already existed). The DO form now captures Code like SO/SI:
the Customer field is the SO's debtor autocomplete (`useDebtorSearch` +
`DebtorSuggestList`, setting `debtorCode` on pick), and the Salesperson field is a
`SelectInput` over `usePickableStaff({ onlySales: true })` valued on
`salespersonId`. Both prefill paths (from-SO and edit-existing) seed `debtorCode`
+ `salespersonId`; `buildHeaderBody()` sends both, and derives the legacy `agent`
name from the picked staff rather than free text. The obsolete raw-UUID
re-resolve effect is removed (a SELECT cannot leak a uuid into a name).

Verified: `tsc -b --force` clean (full tree), frontend lint clean (no new
findings). **No dedicated test yet** — `DeliveryOrderNewV2.tsx` has no test file
(a pre-existing gap, unchanged by this PR); the behaviour was confirmed by
reading the endpoint contract (columns + accepted fields all present) rather than
by a red test. Live-data distribution of name-vs-code already stored in
`delivery_orders` was NOT measured (UNKNOWN) — a read-only check before any
backfill of historical rows is the follow-up.

**Ref.** feat/do-form-code, 2026-08-21.
