## A probe copied the SO join onto the PO table and crashed on a column that is not there [low]

**Symptom** — `probe-sofa-colour-misses.mjs`, dispatched read-only against prod
the moment it merged, printed the fabric-library line and then died:
`PostgresError: column h.doc_no does not exist` (SQLSTATE 42703), run
31406187136. It reported nothing at all.

**Root cause (traced, not guessed)** — the two document headers number their
documents differently and the join hides it. `scm.mfg_sales_orders` carries
`doc_no` and its items join ON that column, so `h.doc_no` is right there in the
SO query being copied. `scm.purchase_orders` numbers its documents `po_number`
and its items join on the surrogate `h.id = i.purchase_order_id` — so the PO
query it was copied from never had to name the column, and the copy carried the
SO's name across into a table that has no such column.

**Fix** — `SELECT h.po_number AS doc_no` on the PO arm, aliased so the report
keeps one shape for both. PR #1910.

**The class, for next time** — copying a query between the SO and PO arms is
safe for the item columns and unsafe for the header ones. `item_code` vs
`material_code` differs loudly enough that it gets noticed; `doc_no` vs
`po_number` is hidden behind a join that never spells it out. Two arms of the
same sweep are two queries, not one query twice.

**Ref** — 2026-08-10, PR #1910 (fix/probe-po-number).
