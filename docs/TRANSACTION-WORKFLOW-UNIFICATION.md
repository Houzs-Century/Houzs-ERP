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
- **Sales Invoice lines: READ-ONLY, header editable (owner 2026-08-20).** SI lines
  inherit from the DO (what actually shipped); the "Edit" button is wired to a
  DEAD `?edit=1` today. Fix: Edit becomes a HEADER-only edit (date / notes / payment);
  lines + variants stay read-only (they already render the variant summary). Do NOT
  add a line/variant editor to SI (industry standard: an invoice's lines are locked
  to the delivery).

## 7. Variant SEE + EDIT — findings (traced 2026-08-20) and fixes

Two modes, per the owner's model, confirmed:
- **Read-only** shows the variant summary, computed LIVE by the shared
  `buildVariantSummary` (`vendor/shared/variant-summary.ts:140`) with `description2`
  as fallback. **Every document already shows it — consistent.**
- **Edit** mounts a variant PICKER. Two shared editors exist and are already used by
  most docs: `SoLineCard` (customer side: SO, DO-new, SI-new, consignment) and
  `PoLineCard` (supplier side: PO-detail, PI). GAPS:
  1. **SI-detail mounts NO editor** — the dead Edit button above. Fix per the
     decision (header-only edit; lines stay read-only).
  2. **GRN variant editor — CORRECTED 2026-08-20.** Earlier plan was to mount the
     full shared `PoLineCard` on GRN so it could edit variants like PO. **That was
     wrong.** Per the owner's editability ruling (§8): the GRN variant is INHERITED
     from the PO and must be **read-only** at the GRN. To change a variant after a
     PO is received you cancel the GRN and edit the PO (§8 cancel-to-source). So the
     fix is the opposite: GRN shows the variant SUMMARY (read-only, same as every
     other doc), and the weak hand-rolled `VariantSelect` (`GoodsReceivedDetail.tsx:93`)
     is REMOVED, not upgraded. GRN keeps editing only its own-stage fields (received
     qty, batch, rack, unit cost). The line-PATCH back door that today lets a GRN
     line's `item_code`/variant be rewritten (§8 GAP-2) must be closed at the same time.
  3. DO edits via a different route (`/delivery-orders/new?edit=`) not inline —
     behaviour matches, entry path differs; align in Phase 2 (note, not a defect).
- **Unification lever:** point GRN + SI at the EXISTING shared editors; do not invent
  new components. Optionally replace the per-page `buildVariantSummary || description2`
  render wrappers with the shared `VariantDescription` component (exists, currently
  used only on convert pickers) for one display path.

## 8. Editability + lock + cancel-to-source model (traced 2026-08-20)

The owner's rule, in his words: "如果 PO 开成 GR,那我不可以在 GR 里改那个 variant —
我应该把 GR cancel 掉,再去 PO 里改。" This is exactly the SAP / AutoCount
**document-flow** model: a downstream document inherits the source's identity/spec
fields as READ-ONLY; to change an inherited field you cancel the downstream (which
reverses its stock/GL), edit the source, and re-convert. A parent cannot be
cancelled while a live child exists.

### 8.1 The target model (three lock scopes)

1. **Own-stage fields — always editable** at a document's own stage: the fields THIS
   document creates (GRN received qty/batch/cost; DO dispatch/POD; SI/PI payment
   dates). Editable even after children exist, as long as they are not inherited.
2. **Inherited fields — read-only on every downstream** (item, variant, ordered qty).
   To change: cancel downstream → edit source → re-convert. Never edited in place.
3. **Cancel ordering — child before parent, always;** cancelling a stock-moving
   downstream (GRN, DO) must reverse the stock in the same action.

### 8.2 What is ALREADY correct (do not rebuild)

- **Cancel-child-first is enforced on all 8 parents** (SO, PO, DO, GRN, CO, CN, PCO,
  PC-Receive) via the shared `backend/src/scm/lib/downstream-lock.ts`
  (`downstreamVerdict`, `soHasDownstream`/`poHasDownstream`/`doHasDownstream`/
  `grnHasDownstream`). Cancelled children do not lock (every count filters
  `status <> 'CANCELLED'`); a failed read fails CLOSED. PROVEN.
- **Cancel reverses stock where stock moved:** GRN cancel (`grns.ts` reversing OUT +
  `reconcileUncostedOuts`), DO cancel (`fn_reverse_do_out`). PO/SO cancel reverse
  nothing (they hold no stock) — correct. PROVEN.
- **SO already models field-level inheritance correctly:** `SO_IDENTITY_LOCK_COLS`
  (`shared/so-identity-lock.ts`) freezes the 34 identity/value columns once a DO/SI
  exists but keeps payment/remarks/scheduling editable. This is the pattern every
  other document should copy.

### 8.3 The gaps to close (from the traced audit)

| # | Gap | Direction |
|---|---|---|
| GAP-1 | PO/DO/GRN/consignment freeze the WHOLE document once a child exists (document-level 409). Only SO is field-level. Result: a PO whose GRN exists cannot edit even a PO-own field (supplier remark, expected date). | **Loosen** — give each parent an identity-lock column set like SO's; own-stage fields stay editable. |
| GAP-2 | Line-PATCH back door: a downstream line's `item_code`/variant (inherited) can be rewritten by adding a free line then editing its code. Only the guard on CREATE/convert exists; the per-line PATCH calls no unlinked-line guard. Open on GRN, purchase-returns, delivery-returns; SI closed 2026-08-17. **This is the "editing GRN variant" hole.** | **Tighten (integrity)** — run the unlinked-line guard on the line-PATCH path too, so an inherited line cannot be re-pointed. |
| GAP-8 | Stock reversal on GRN/DO cancel is BEST-EFFORT (log-and-continue on RPC error): a failed reversal leaves the doc CANCELLED with stock un-returned. And terminal-doc REOPEN (SI/PI CANCELLED→SENT) has no check that the parent DO/GRN is still live. | **Tighten (integrity)** — make cancel+reversal atomic (fail the cancel if the reversal RPC fails); block reopen when the source is cancelled. |

GAP-3..7 (unlinked-line guard missing on 5 chains, non-atomic converts, drifted
`received_qty` cache, split DRAFT-consumption policy, no per-transfer audit row) are
documented in `docs/modules/document-conversion.md` §10.4 and folded into the Phase-2
state-machine work; they are integrity items, not restriction-loosening.

### 8.4 Per-document editability matrix (target)

| Doc | Own-stage (always editable) | Inherited (read-only once child/converted) | Cancel needs child cancelled first | Cancel reverses |
|---|---|---|---|---|
| SO | payment, remarks, scheduling, salesperson | debtor, addresses, venue, branding, currency, lines/variants (once DO/SI) | DO/SI | nothing (deposit→credit) |
| PO | supplier remark, expected date, non-received lines | supplier, item, variant, ordered qty (once GRN) | GRN | nothing |
| GRN | received qty, batch, rack, unit cost | item, **variant**, source PO link | PI/PR | stock IN |
| DO | dispatch, POD, driver/vehicle | item, variant, ordered qty (from SO) | DR/SI | stock OUT |
| SI | invoice/payment dates, allocation | lines + variants (from DO) — HEADER-only edit | (terminal) | revenue/AR |
| PI | invoice/payment dates, allocation | lines (from GRN) | (terminal) | AP |

Consignment mirrors follow the same rows as their siblings.

## 9. Field-restriction model — "loosen as much as possible" (owner 2026-08-20)

**Governing principle (owner):** "我们公司也小,所以限制越松动、越容易、越不影响
workflow 是最好的." Block as little as possible; where a block is truly needed, prefer
a one-tick acknowledge over a hard wall. Only rules that keep stock/money/document-
chain math correct stay hard.

### 9.1 Three layers

| Layer | Action | What it blocks |
|---|---|---|
| **Draft** | Save Draft | **Nothing.** One line is enough; doc date auto-today; amount blank/0 fine. |
| **Confirm / Post** | Confirm | **Only what makes downstream math wrong:** (1) required variant missing, (2) qty ≤ 0. Amount 0 → one-tick "set later", not a wall. Everything else allowed or warned. |
| **Convert / Edit-source** | Convert/Edit | Only the §8 integrity guard: cancel downstream before editing source; cancel reverses stock. |

### 9.2 Current required-field state (traced) and the decisions

Every doc's **document date already auto-defaults to today** (`dateOrNull(x) ?? todayMyt()`
or DB `now()`), so no doc is ever blocked on a blank doc date. Amount 0/blank is
allowed at create AND confirm on **every** document; the only money guard in the whole
workflow is the GRN-post zero-cost-line guard (with `zeroCostAck` one-tick escape).

Decisions locked 2026-08-20:

- **PO date: OK as-is** — `po_date` auto-today, never blocks. (Confirmed.)
- **PO amount: OK as-is** — 0/blank allowed at create and confirm; no guard. (Confirmed.
  A 0-value PO records a 0-value commitment; fill price later.)
- **PO `expected_at` (Expected Delivery = "when the supplier should deliver"): keep
  required-but-AUTO-DEFAULT-TODAY, never blocks (owner 2026-08-20).** This is a
  SEPARATE field from `po_date` (the doc/raise date): `po_date` = when you open the PO;
  `expected_at` = when you want the goods. Today `expected_at` hard-blocks create even
  for a draft (`mfg-purchase-orders.ts:1123` 400 `expected_at_required`; FE
  `PurchaseOrderNew.tsx:601`) — the ONE pure-field rule that can stop you opening a PO,
  and only PO + PCO enforce it (SO's delivery date is optional). Fix: give it the SAME
  treatment as `po_date` — if blank, default to today (`?? todayMyt()`) instead of
  returning 400. The column stays populated (still "required" in the data sense) but the
  save never blocks. Remove the FE hard-block too. Same for PCO.
- **Customer phone on SO / CO: KEEP REQUIRED (owner decided 2026-08-20).** Phone is the
  delivery contact; worth the one required field even though DO/CN don't ask for it.
- **PO variant: REQUIRED at confirm, and enforce in the BACKEND.** Today the PO variant
  gate is frontend-only (`PurchaseOrderNew.tsx:616`); a direct-API confirm bypasses it.
  Add `missingRequiredVariants` to `confirmMfgPurchaseOrderHandler`. (This is the one
  deliberate tightening; it is not a field-nicety, it is "supplier must know what to make.")
- **PC Receive zero-cost guard: ADD (match GRN).** PC Receive posts stock IN like GRN but
  runs no `checkReceiptCosts` — a previously-priced SKU received at 0 opens a silent
  zero-cost lot. Add the same guard + `zeroCostAck` escape. Integrity, not strictness.
- **Consignment docs have no draft (CO/CN/PCO/PC-Receive commit on create).** Lower
  priority: add `asDraft` to the consignment mirrors so they match their siblings.
- **≥1 line required on GRN/PI/PC-Receive:** keep (you cannot receive/invoice nothing);
  harmless.

### 9.3 Restriction changes summary (loosen vs keep-hard)

- **Loosen:** PO/PCO `expected_at` → optional; consignment drafts → add; document-level
  parent lock → field-level (§8 GAP-1). Everything pure-field defaults/allows/warns.
- **Keep hard (integrity only):** required variant at confirm (SO done, PO to add to
  backend), qty > 0, cancel-child-first + atomic stock reversal, GRN + PC-Receive
  zero-cost guard, the line-PATCH inherited-line guard (§8 GAP-2).
