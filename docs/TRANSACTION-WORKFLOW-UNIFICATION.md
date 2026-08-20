# Transaction-Workflow Unification — CTO spec + phased plan

Owner directive 2026-08-20: unify the ENTIRE transaction workflow — one state
machine, one action-component set (edit / confirm / cancel / reopen / convert /
print), one conversion engine, one save-validation surface — so every document
behaves identically. This doc defines the target, the audit evidence behind it,
the phased plan, and the QA gate. It is the reference the work is measured against.

The three owner requirements that are FIRST-CLASS, not nice-to-have:
1. QA to a CTO/global bar — verified across ALL documents, not per-page; the
   "consistency" itself becomes an `audit:` check so a page that drifts fails CI.
2. PO→GR and PO→GI (GRN→PI) conversions "randomly get stuck" — this is the
   systemic confirm/convert freeze; root-fix it, do not patch one page.
3. When a save is blocked, show the operator EVERY reason at once — never
   fix-one-retry-fix-one. A single collect-all save-validation surface, workflow-wide.

---

## 1. The documents and their shared reality (why one fix generalises)

Sales chain: `Sales Order (SO)` -> `Delivery Order (DO)` -> `Sales Invoice (SI)`
(+ `Delivery Return`). Purchase chain: `Purchase Order (PO)` -> `Goods Receipt
(GRN)` -> `Purchase Invoice (PI)` (+ `Purchase Return`). Plus Consignment
(order/note/return, sales + purchase sides), Amendments (SO/PO), and the
stock-movement docs (Stock Adjustment, Stock Take).

They already SHARE more than they diverge: the list-perf pattern
(`*-list-enrichment.ts`), commit conventions, BUG-HISTORY discipline, and the
convert link/label layer (`frontend/src/lib/convertScope.tsx` `CONVERT_LINKS`,
`shared/transfer-vocabulary.ts`). So a fix to a truly-shared layer covers every
document at once. The divergences below are where "one workflow" is not yet "one
implementation".

## 2. Audit findings (traced, with evidence)

### 2.1 Detail-page actions are two generations + uneven
- SO/DO/SI = modern read-only "V2" pages (edit on `?edit=1`); PO/GRN/PI = older
  single-file editors; **PO has BOTH a legacy editor and a V2 that disagree**
  (`PurchaseOrderDetail.tsx:1002` has "Raise Return"; `PurchaseOrderDetailV2.tsx`
  does not).
- Convert-to-downstream uneven: DO->SI (`DeliveryOrderDetailV2.tsx:1127`),
  PO->GRN (both PO pages), GRN->PI (`GoodsReceivedDetailV2.tsx:589`), consignment
  order->note->return — but **SO->DO is list-only** (`MfgSalesOrdersListV2.tsx:1183`,
  not the SO page), SI/PI terminal, legacy GRN page has none.
- Cancel/Reopen uneven: `ConsignmentOrderDetail.tsx` has **no Cancel at all**;
  Reopen exists on SI/PO/Consignment-Note but not DO/GRN/PI.
- Status-transition style differs: DO uses one label-morphing "advance" button
  (`do-next-step.ts:170`); SO/PO/GRN/PI use explicit per-status buttons.

### 2.2 The confirm dialog is TWO mechanisms (root of owner req #2)
- Shared in-app `useConfirm` (`ConfirmDialog.tsx`): SO, PO-legacy, GRN, PI, SI-V2,
  Consignment.
- Native `window.confirm` (blocks the main thread): **`DeliveryOrderDetailV2.tsx:774`**,
  **`PurchaseOrderDetailV2.tsx:603,609,615`** — PO-V2 even mixes both (shared for
  "Send", native for Cancel/Confirm/Reopen).
- The observed 2-minute freeze on cancel/convert (owner req #2) is on the shared
  `useConfirm` path, on a heavy detail page — root cause NOT yet pinned (needs a
  runtime profiler; the confirm code itself is trivial, so the cost is a hidden
  re-render/layout the profiler must reveal). Tracked separately.

### 2.3 Conversion engine: link layer shared, CREATE logic hand-rolled per pair
- Shared: `convertScope.tsx CONVERT_LINKS` (`:46`) + `transfer-vocabulary.ts`.
- Hand-rolled per destination: each convert has its own picker page AND its own
  backend create handler re-implementing the SAME guards (over-convert cap,
  unlinked-line, cross-company, migrated-source). The code says so:
  `purchase-invoices.ts:760` "Five sibling chains close exactly this door";
  `:789` "mirrors /from-grn-items line ~432". A guard fix must be re-applied 6x.

### 2.4 Over-quantity / negative-stock: uniform mechanism, split posture
- GR-over-receipt and DO-over-ship both use pre-insert cap + post-insert race
  verifier (`grns.ts:1690` `verifyGrnOverReceipt`; `delivery-orders-mfg.ts:3538`).
- **Posture diverges:** DO fails CLOSED; GR-over-receipt + GRN->PI-over-invoice
  fail OPEN (best-effort — a read blip commits an over-qty row). BUG-HISTORY
  (~15781) flags 8 fail-open verifier sites as an owner policy decision.
- Negative stock is a different class: soft, operator-waivable (`confirmShortStock`).
- Open holes: the 8 fail-open verifiers; unlinked DO lines (`so_item_id = NULL`)
  never counting against ordered qty (`do-over-delivery.ts:10`).
- No DB-layer backstop for any of the three — route-level only.

### 2.5 Variants: correct; one gap
- Stock IS per-variant `(warehouse, SKU, variant_key, company)`
  (`0084_multicompany_views.sql:180`); Stock Adjustment + Stock Take ARE
  variant-aware. The feared corruption does not exist (and a past one was fixed,
  mig 0035). GAP: PO form shows the variant editor but has no hard save-time
  variant-required gate (SO gates it once a Processing Date is set).

### 2.6 Amount = 0: mostly already allowed
- PI/GRN totals are never gated `> 0` at any layer; a zero-price line saves. The
  ONE hard block is the GRN `zero_cost_receipt` guard (`zero-cost-receipt-guard.ts`),
  conditional (previously-priced SKU) with a "Received free" ack.

### 2.7 GR->PI failure (owner req, "won't convert / crashes")
- Path: `GoodsReceivedDetailV2.tsx:357 goConvertToPi` -> picker
  `PurchaseInvoiceFromGrn.tsx` -> `PurchaseInvoiceNew.tsx:450 onSave` -> POST `/`
  then PATCH `/:id/post`.
- PROVEN silent-failure point: `purchase-invoices.ts:1037-1043` — a failed
  `postPiAccounting` (GL/AP post) is only `console.error`'d and the route returns
  200; the UI says "AP liability recorded" even on failure. This is the repo's
  "failure reaches nobody" class.
- Other failures (unlinked/cross-company/over-qty 409s) DO surface as "Save
  failed". The EXACT crash the owner hit is UNKNOWN without the console/network
  body — to be reproduced with the console open.

## 3. Target architecture

1. **`doc-lifecycle` config (one source of truth).** A data-driven map: per
   document type -> statuses -> allowed transitions -> which actions
   (edit/confirm/cancel/reopen/convert-targets/print) are legal in each status.
   No per-page if/else. Backend + frontend read the SAME config (shared module,
   mirrored like `transfer-vocabulary`).

2. **`<DocActionBar document>` (one component).** Renders the action buttons from
   the lifecycle config for the document's type+status. Every detail page mounts
   it; per-page action divergence becomes impossible.

3. **One confirm mechanism.** `useConfirm` everywhere; delete the two
   `window.confirm` sites. Fix the shared ConfirmDialog freeze (owner req #2) so
   every cancel/convert is instant.

4. **One conversion engine.** A single parametrised backend `convertDocument(kind,
   picks, ctx)` that owns the shared guards (over-convert cap fail-CLOSED,
   unlinked-line, cross-company, migrated-source) in ONE place; per-pair handlers
   become thin adapters. Frontend keeps the already-shared `convertScope` links.

5. **One save-validation framework (owner req #3).** `collectSaveErrors(doc): string[]`
   per document — returns EVERY blocking reason; the UI shows them together in one
   dialog. Generalises the SO-create collect-all (already shipped, PR #2509) to
   every create/edit/convert/confirm. No fix-one-retry.

6. **No silent failures.** Every mutation (esp. the GL/AP post) surfaces its
   failure to the operator; the `postPiAccounting` swallow (`:1037`) is closed.

## 4. Phased plan (one PR per row; each with its QA gate)

| Phase | PR | Content | Risk |
|---|---|---|---|
| 1a | confirm-unify | Replace the 2 `window.confirm` sites with `useConfirm`; close the GL-post silent-failure surfacing | low |
| 1b | freeze-fix | Root-fix the shared ConfirmDialog freeze (owner #2) — profiler-pinned | med |
| 1c | save-validation | `collectSaveErrors` framework + show-all-reasons dialog, wired on SO/PO/GRN/PI create/convert (owner #3) | med |
| 1d | amount-zero | Relax the zero-cost-receipt guard to a clear one-tick "free" path | low |
| 2 | action-bar | `doc-lifecycle` config + `<DocActionBar>`; migrate each detail page; retire legacy PO/GRN/PI editors | high |
| 3 | convert-engine | Consolidate per-pair create handlers into one engine; over-qty fail-CLOSED everywhere; unlinked-line hole closed | high |
| — | consistency-audit | `npm run audit:workflow-consistency` — fails CI if a document lacks an action the lifecycle says it should have, or uses `window.confirm`, or a convert handler bypasses the engine | — |

## 5. QA gate (every PR)
- `npm run typecheck` (backend `-p .`; frontend `tsc -b`) clean.
- Affected unit tests + a new test for the changed rule.
- Browser: exercise the actual action on the actual document(s); paste console +
  network evidence (no silent failures).
- For perf rows: before/after numbers with the tool named.
- The consistency `audit:` check green.
- BUG-HISTORY entry; module-guide update where a surface moves.

## 6. Owner decisions — DECIDED 2026-08-20 (locked)
- **Over-qty posture: FAIL-CLOSED, all 8 verifiers.** Owner note: reads almost
  always succeed and over-qty is structurally impossible (the cap is the remaining
  qty); fail-open only matters in a rare transient DB read error, and there we
  REFUSE the save rather than commit an unverified over-qty row.
- **PO variant gate: REQUIRED (owner overruled the "defer" proposal).** Rationale:
  the supplier cannot make the item without the spec. On PO create/confirm the CORE
  variant axes (fabric / gaps / divan+leg+seat height per group) are REQUIRED for
  sofa/bedframe; **Special Orders stays OPTIONAL** (it is optional by design). SO
  stays gated on Processing Date (unchanged); PO is now gated at confirm.
- **Legacy detail pages: RETIRE.** The V2 read-only surface is the single target for
  every document; legacy PO/GRN/PI editors are removed in Phase 2.
- **Amount = 0: KEEP the zero-cost-receipt protection, make "Received free" a clean
  one-tick path.** Do not remove the guard (it prevents valuation corruption from a
  previously-priced SKU booked at 0); make the intentional-free path frictionless.
