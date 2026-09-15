## Delivery Planning's new Reference column was blank on every order: it read referral (the HC referral channel, NULL everywhere) instead of the order's ref [low]

<!-- area: Fleet, trips, TMS -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, minutes after #3961 deployed: 「为什么reference
number空？」 with the example `HC-SO-004574` → `pg0791`. The Reference column
showed a dash on every row.

**Root cause (traced).** #3961 (docs/bugs/0932) restored the board column that
the 2026-08-04 pass had removed, and that column had always read
`mfg_sales_orders.referral` — the "Referral source / channel" field of the HC
fields drawer. A read-only count on production (Supabase, 2026-09-15): of
3,129 non-draft, non-cancelled orders across both companies, **0** have
`referral` set. The value the owner calls the reference number lives in
`mfg_sales_orders.ref` — AutoCount's `Ref`, the field the delivery sheet feed
emits as `Ref` (`backend/src/lib/delivery-sheet-feed.ts`) and the write-back
sends as `Ref` (`services/autocount-writeback.ts`). `GET /delivery-planning`
did not select `ref` at all, and the row's existing `ref` slot is the
ASSR / DP / project human ref (`null` on SO rows by design), so nothing on the
board could have shown it.

**Fix.** `/delivery-planning` selects `ref` and stamps it on SO rows as
`so_ref` (a new field — the `ref` slot keeps its non-SO meaning). The board's
Reference column is keyed `so_ref` and reads it; the mobile stop detail's
"Reference" row reads the same field. `referral` is left alone: it is still
editable in the fields drawer and still emitted by the API, it just is not
"Reference". The route is now exactly at its file-size ceiling (2,907 lines).

**Ref.** fix/dp-reference-reads-ref, 2026-09-15.
