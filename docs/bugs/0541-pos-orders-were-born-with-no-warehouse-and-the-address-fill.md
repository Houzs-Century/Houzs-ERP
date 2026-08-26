## POS orders were born with no warehouse and the address fill then hit the warehouse-conflict gate [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** 2990-SO-2608-045 (POS walk-in, 2026-08-25, no state, no
location): all four goods lines were written with `warehouse_id NULL`. A NULL
line matches no allocation bucket, so it sits PENDING with no incoming PO
while its goods sit in the warehouse; the `do-link-orphan-sentinel` counts
exactly this class and went red on it the same afternoon — after four days
red on the SAME class from the SO-2607-019 rebuild (docs/bugs/0501 residue).
The owner's ruling: an order sold at a store should be born belonging to that
store ("POS 开单默认落操作员门店").

**Root cause (traced).** Two halves. (1) The create default derived from the
customer State ALONE (`deriveWarehouseIdFromState` at the old line ~4180), so
an order with no address — the normal POS walk-in shape — wrote every goods
line NULL, and the line-ADD path repeated the same State-only derive. (2) The
fix could not be "just default the store", because the 2026-07-22 State-change
conflict gate 409'd whenever ANY bound line differed from the State's
warehouse — and no state maps to a showroom, so a store-bound order would have
409'd on every later address fill, trading a silent NULL for a daily block.

**Fix.** Write-time now applies the read-time rule
(`resolveLineWarehouseId`: Location, then State) plus one final fallback: the
creating operator's own store (`scm.staff.showroom_warehouse_id`, verified in
the ACTIVE company's warehouse master — the staff table is shared across
companies). The decision is pure (`chooseCreateWarehouseDefault`,
lib/so-warehouse.ts): a resolved Location or State always wins, and an
explicit Location that resolves to nothing blocks the store too. The header
`sales_location` falls back to the same store label so header and lines
cannot disagree. The line-ADD path inherits the order's warehouse through
`resolveSoWarehouseId` instead of the State-only derive. And the conflict
gate is narrowed to its own stated reason
(lib/so-state-warehouse-rebind.ts): a line anchored by a live downstream
PO/DO still 409s; an un-anchored bound line moves with its order inside the
header CAS transaction (mig 0330 adds `p_rebind_line_ids uuid[]` to
`apply_so_header_cas`; anchor lookup fails CLOSED). Pinned by
`tests/soCreateOperatorStoreDefault.test.ts` and
`tests/soStateWarehouseRebind.test.ts`.

**Ref.** fix/pos-so-default-operator-location, 2026-08-25.
