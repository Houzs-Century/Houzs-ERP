## "Convert to" navigated with a source document and the picker threw it away [high]

<!-- area: Frontend + mobile -->

**Symptom.** Owner 2026-08-16: *"Every place should have both 'Convert from' and
'Convert to' — that is how the work actually flows."* Several of the "Convert to"
buttons that DO exist did nothing useful: pressing **Convert to SI** on a
Delivery Order, **Convert to PI** on a GRN, or **Deliver** on a Sales Order
opened the destination picker listing every open document in the company, with
no sign of the one just left. **Convert to PR** on a GRN opened a blank
free-form Purchase Return with no note attached.

**Root cause (traced, three separate defects on one path).**

1. *The scope was constructed and discarded.* Five call sites appended a source
   parameter — `?do=`, `?grn=`, `?so=` — and the three destination pickers
   (`SalesInvoiceFromDo`, `PurchaseInvoiceFromGrn`, `DeliveryOrderFromSo`)
   contained no `useSearchParams` / `useLocation` / `useParams` at all, so the
   parameter was never read. Verified by counting the hooks in each of the ten
   picker files: eight had ZERO; only `PurchaseOrderFromSo` (3) and `GrnFromPo`
   (2) read anything. Of those eight, **three receive a parameter from a live
   caller** — the other five have no "Convert to" button pointing at them yet,
   so they had nothing to drop.
2. *The two sides spelled it differently.* `GoodsReceivedDetailV2` and
   `GoodsReceivedListV2` navigated to `/scm/purchase-returns/new?fromGrn=<id>`
   while `PurchaseReturnNew` read `params.get('grnId')`. The page then took its
   free-form branch (`isManual = !grnId && !poId`) and rendered a normal empty
   form, which is why it never looked like a failure. Enumerated every other
   `/new` destination's parameters against its callers: **no sibling mismatch**
   — every other pair already agreed.
3. *A dead route.* `SalesInvoicesListV2`'s "New from Sales Order" navigated to
   `/scm/sales-invoices/from-so`, which is registered nowhere in `App.tsx`
   (`/new`, `/from-do`, `/:id` only), so it fell through to the detail route
   with `id="from-so"`.

The common cause under all three is that **every call site invented its own
string.** Nothing typed the relationship, so neither a dropped parameter nor a
mismatched one could fail at compile time, in a test, or on screen.

**Fix.** `frontend/src/lib/convertScope.tsx` names each conversion's parameter
ONCE, keyed by pair; the caller builds with `convertToLink()` and the
destination reads with `readConvertScope()`, so a typo is a type error. The
three pickers now filter and pre-tick to the scoped source, with a "Show all"
escape and a scoped empty-state that does not claim the whole system is empty.
An unrecognised parameter is rendered to the operator
(`<UnrecognisedScopeNotice>`) instead of dropped — that silence is what let (2)
survive. The dead SO→SI button is REMOVED, not repointed: the only SI converter
the backend exposes is `POST /sales-invoices/from-dos`, so SO → SI does not
exist in either direction.

**The guard, because a convention is not a fix.** `convertScope.test.tsx` scans
the tree and fails on any site hand-writing a query onto a convert path, so the
next hand-built link cannot be silent. `convert-scope-pickers.test.tsx` mounts
each repaired picker under a real router at the real URL its real caller builds
and asserts the operator sees the document they came from and not the one beside
it. Proven to bite: reverting each of the three scope filters in turn fails 2
tests each (23 -> 21 passed), reverting the parameter name fails 2, and
re-introducing one hand-built link fails the tree scan naming
`GoodsReceivedListV2.tsx:606`.

**Ref.** PR #TBD, 2026-08-16. Contract written up in
`docs/modules/document-conversion.md`.
