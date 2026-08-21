## Four relationship-map builders resolved the customer reference with three different fallback orders [low]

**Symptom.** The screening found it; the DATA audit confirmed why it matters.
On the document relationship maps, the "Customer PO" cell could show a different
value on the DO map than on the SI map for the same order.

**Root cause (traced).** Four builders each inlined their own fallback:
`buildDoChainNodes` read `po_doc_no || customer_so_no`, `buildSiChainNodes` read
`customer_so_no || po_doc_no`, `buildDrChainNodes` read `customer_so_no` only,
and `useSoRelationshipMap` read `po_doc_no || customer_so_no || ref`. An order
carrying both `customer_so_no` and `po_doc_no` therefore resolved differently per
surface. Audited against production 2026-08-18: `customer_so_no` is the filled
value (96%), `po_doc_no`/`customer_po` are 0%-filled dead columns, and `ref`
duplicates `customer_so_no` — so in practice `po_doc_no` never wins today, but
the code disagreed with itself.

**Fix.** One shared `customerRefOf(header)` in `frontend/src/lib/customer-ref.ts`,
reading `customer_so_no || po_doc_no || ref` (the data-correct order), routed
through all four builders. A unit test pins the order and the regression (a
header with both fields resolves to ONE value everywhere).

**Scope.** DISPLAY only. The dead columns are dropped in a separate migration
(they are projected by a view — the 0189 grant-loss hazard), and the vocabulary
guard for `po_doc_no`/`customer_po` waits for that drop because the backend
router still selects them until then. First concrete step of the batch-2
vocabulary unification (customer-reference concept).

**Ref.** 2026-08-18, branch `fix/unify-customer-ref-builders`.
