# The interface asserts an outcome it did not verify — sweep, 2026-08-21

Written after three instances of one class turned up in a single day without
anyone looking for them. This is the sweep of the CLASS, not the instances.

**This is a TRIAGE record, and the *cleared* column is the point.** An entry
under §5 means somebody opened the code and decided, so the next sweep does not
re-chase it. §4 is the tail: found, traced, and NOT fixed — with the reason.

---

## 1. The class, in four shapes

A control, label, toast, dialog or status tells a person something happened, or
is true, when the code never established it. The person then acts on a false
belief and nobody is told. It is worse than a crash: a crash gets reported.

1. **Fire-and-forget success.** A write is fired without awaiting, or its
   rejection is swallowed, and a SUCCESS state is set anyway.
2. **A promise the code cannot keep.** Copy that says "you can X afterwards"
   where that path does not exist, or is unreachable in the state the person
   lands in.
3. **A failed READ rendered as a state.** An error path that produces a
   plausible value — `0`, `[]`, `false`, "none", "not enabled" — instead of an
   error or an explicit unknown. This is the nastiest: an error renders as a
   confident, wrong answer.
4. **A label that outruns the payload.** Button text names a scope or a field
   the request body does not carry.

---

## 2. What the existing checkers structurally cannot see

Measured 2026-08-21 on `frontend/src`.

| checker | its corpus | what it cannot see |
| --- | --- | --- |
| `frontend/scripts/check-silent-mutations.mjs` | 303 `useMutation(` sites | the **943** raw write calls (`api.post/put/patch/del`, `authedFetch` with a write method, `portalApi.*`) across **141** files — and its verdict is per HOOK, so ONE consumer awaiting `mutateAsync` clears every other consumer of the same hook |
| `frontend/scripts/check-silent-writes.mjs` (new, PR #2610) | 287 write-inside-`try` sites | a dropped promise with no `try`; a 200 that reports failure in its body; **shape 3 entirely** — there is no `catch` to look at |
| `frontend/scripts/check-inband-failures.mjs` | `movementErrors` / `cancelErrors` / `reversalErrors` producers vs readers | whether a reader RENDERS what it read |
| `backend/scripts/lib/swallowed-read-scan.mjs` | `.catch(() => ({}\|undefined\|null\|[]))` | `.catch(() => ({ users: [] }))` — a catch returning a plausible STRUCTURED value, which is most of shape 3 |
| `@typescript-eslint/no-floating-promises` | un-awaited promises | whether the awaited one's failure reaches a person |

The per-HOOK blind spot is not hypothetical. `usePostGrn` was marked CAUGHT on
the strength of `GrnNew.tsx`'s `await post.mutateAsync(...)`, while the call site
that confirms *"Inventory will be received into the warehouse"* passed no error
handler at all. See `docs/bugs/0495-post-grn-and-post-purchase-invoice-had-no-error-path-and-the.md`.

---

## 3. Fixed and shipped

| shape | what a person wrongly believed | PR |
| --- | --- | --- |
| 1 | Six Fleet Health writes: a breakdown dropdown reads "Resolved" while the lorry is still grounded (a controlled `<select>` keeps the picked option because no render happens on a refusal) | #2602 |
| 1 | Post GRN: "Inventory will be received into the warehouse", refused, screen says nothing — plus the 200-with-`movementErrors` in-band failure nothing read. Post Purchase Invoice: same, for the AP liability | #2605 |
| 3 | Trial Balance printed a GREEN **"RM 0.00 — books balance"** off a ledger it failed to read; Inventory > COGS printed **"Total COGS RM 0.00"** and "No COGS entries yet" | #2611 |
| 1 | Two PMS remark boxes saved on BLUR and swallowed the failure, leaving the typed text on screen so the box looked exactly like a saved one | #2610 |

Each carries a test proved RED on the unfixed tree first.

---

## 4. THE TAIL — traced, not fixed

Every row below was read on both sides: the line that makes the claim and the
line that does not verify it. None is fixed. Ordered by what it costs.

### 4.1 Money and stock

| # | site | the claim, and what is not verified | label |
| --- | --- | --- | --- |
| T1 | `frontend/src/pages/scm-v2/StockAdjustmentNew.tsx:346`, `:495` | `Current balance: 0 PCS` and `No open stock to take from.` come from `:132` (`if (!row) return breakdown.isLoading ? null : 0`) and `:118` (`bucketsQ.data ?? []`), neither of which consults `isError`. **Worse:** `:207` gates the "which batch does this come out of" requirement on `buckets.length > 0`, so a failed read SKIPS the gate and `:238` posts `variantKey: undefined` — a failed read corrupts a WRITE | PROVEN |
| T2 | `frontend/src/pages/scm-v2/StockCard.tsx:301`, `:305` | `Current Qty` and `Warehouses` fold over `(breakdownQ.data?.balances ?? [])`; only `isLoading` is consulted. The movements panel on the SAME page (`:416`) renders an honest `Failed to load` off `movementsQ.error` | PROVEN |
| T3 | `frontend/src/pages/scm-v2/PaymentVoucherNew.tsx:466` | *"This supplier has no outstanding purchase invoices."* off `piListQ.data?.purchaseInvoices ?? []`; the voucher then saves with no allocations and the supplier's invoices stay open. Same in the edit path, `PaymentVoucherDetail.tsx:225` → `:558` | PROVEN |
| T4 | `frontend/src/pages/scm-v2/Outstanding.tsx:110`, `:123` | Every module tile renders `{s?.count ?? 0}` and the header reads `0 SI rows (outstanding)`. A manager reviewing exposure sees zero POs, zero unbilled receipts, zero unpaid invoices | PROVEN |
| T5 | `frontend/src/pages/scm-v2/PurchaseInvoiceDetailV2.tsx:683` (label) vs `:461` (payload) | **Shape 4.** "Mark paid" sends `PATCH /purchase-invoices/:id/payment { amountSen: 0 }` — the button only renders when `outstanding === 0`, so the amount is always zero and the body carries no status. The SI page does the same action correctly as a status flip (`SalesInvoiceDetailV2.tsx:919`) | LIKELY — the frontend mismatch is proven; whether the backend re-derives PAID from a zero-amount PATCH is unread |
| T6 | `frontend/src/pages/scm-v2/StockTransferNew.tsx:129` | *"No stock at source"* off `(bucketsQ.data ?? [])`, `isLoading` only. Lower cost than T1: it blocks a legitimate transfer rather than corrupting one | PROVEN |
| T7 | `frontend/src/pages/scm-v2/Inventory.tsx:1352` → `:1636` → `:1654` | The per-SKU COGS section (`COGS (0)`, *"No COGS entries yet for this SKU."*) is the same query family fixed on the tab in #2611, at a second render site that was left | PROVEN |

### 4.2 Customer-facing and safety

| # | site | the claim, and what is not verified | label |
| --- | --- | --- | --- |
| T8 | `frontend/src/mobile/MobileMileageCapture.tsx:159` | **Shape 2.** *"Marked critical — the lorry is grounded and the office has been notified."* `grounded` echoes the driver's own severity radio; it says nothing about a notice. Four independent links break it: the 201 body carries no notification outcome (`fleet-maintenance.ts:1521`); the `postPersonalNotice` call is in a `try` whose catch only `console.error`s (`:1503`); the helper swallows insert failures and returns silently on an empty target list or a dedupe hit (`personalNotice.ts:59`, `:84`, `:120`); and `uplineUserIds` seeds its set with the reporter, so **a driver with no `manager_id` notifies only himself** (`orgScope.ts:73`). A driver stranded on the roadside stops phoning it in | PROVEN |
| T9 | `frontend/src/mobile/MobileServiceCase.tsx:1603`, `:1622` | **Shape 4.** *"Portal link copied"* fires after `if (navigator.clipboard) await navigator.clipboard.writeText(url)` — on an insecure origin (the `http://192.168.x.x` warehouse tablet) the write is SKIPPED, throws nothing, and the toast still says copied. The catch on `:1604` is deliberately honest ("Portal link", no verb), which shows the author drew the distinction and the `if` defeats it. `MobileInvitations.tsx:99-113` is the correct pattern | PROVEN |
| T10 | `frontend/src/mobile/MobileProfile.tsx:633` | *"Biometric unlock off — saved session erased"* off `forgetNativeSession()`, which is `void p.deleteCredentials(…).catch(() => {})` (`lib/nativeSession.ts:178`) and returns early when the plugin is absent. Someone wiping a phone before handing it over is told the token is gone | PROVEN for the path; frequency of a real `deleteCredentials` rejection UNKNOWN |
| T11 | `frontend/src/pages/Sales.tsx:778`, `:787` → `:1232`, `:1242` | **Shape 3.** `.catch(() => ({ users: [] }))` and `.catch(() => ({ data: [] }))` resolve the promise, so `hooks/useQuery.ts:119` sets `error: null` and the component has no error to check. The salesperson picker renders with a single `— me —` option and Branding renders blank: an admin keying a sale for a rep leaves it credited to themselves. The comment at `:774` claims "the picker simply hides" — it never has; `:1230` renders it unconditionally. The 403 rationale in that comment justifies swallowing a 403, not every 500 | PROVEN |

### 4.3 Internal

| # | site | the claim | label |
| --- | --- | --- | --- |
| T12 | `frontend/src/components/LookupManager.tsx:218` | *"No entries yet — add one above."* off a query whose `.error` is never referenced. Shared, so it repeats on every maintenance screen. The failed read then feeds a WRITE: `:118` computes `sort_order: (q.data?.data.length ?? 0) * 10`, which is `0` after a failure and collides with the existing first row | PROVEN |
| T13 | `frontend/src/pages/ServiceMetrics.tsx:253` | *"No open cases right now."* The StatCards directly above it all render `x != null ? … : "—"` honestly; the funnel beneath asserts emptiness. The same empty state also absorbs "you are not allowed" (`:180`) | PROVEN |
| T14 | `frontend/src/pages/scm-v2/SupplierDetail.tsx:3927` | *"No products match."* off `useMfgProducts`; no `isError` in the file. The operator creates a duplicate product | PROVEN |
| T15 | `frontend/src/pages/scm-v2/LorryDetail.tsx:132` | *"No service records yet."* off a query whose `isError` is never consulted; a workshop visit gets entered twice, with its cost | PROVEN |
| T16 | `frontend/src/mobile/MobileModuleForm.tsx:342` (`:190` swallows the options fetch) | On EDIT, an empty options list makes the `<select>` fall back to its placeholder, so a colleague with a role and a department reads "Select role…" / "Unassigned". The saved payload is unharmed (`buildBody` re-reads React state), so it misinforms rather than corrupts | PROVEN for the path; the `<select>` fallback step is DOM semantics, reasoned not executed |
| T17 | three map pages — `AutoSchedule.tsx:436`, `FleetDay.tsx:712`, `Trips.tsx:807` | `serverConfigured={geo.data?.configured ?? true}` suppresses the "maps key is not configured" warning on a FAILED read, and `geoTotals([])` returns a truthy `{orders:0,sets:0,revenueSen:0}` so the header renders `0 orders · 0 sets · RM 0.00`. `geo.isError` is read at none of the three | PROVEN |

### 4.4 Owner decisions — deliberately NOT changed

Judgement calls, per the standing rule that a judgement gets asked and only a
provable defect gets fixed unilaterally.

- **The optimistic announcement acks.** `MobileAnnouncements.tsx` `ack`,
  `components/useAnnouncementBanner.ts` `ack`, `NotificationBell.tsx` `markRead`
  and `useAssistantChat.ts` `deleteConversation` all reflect the tap locally
  even when the server refused, so a failing server cannot strand a reader on a
  must-acknowledge notice. The banner reconciles on the next load. **The
  publisher's read-receipt list does not** — it is the record, and it will show
  the person as not having read a compulsory notice. Whether a compulsory notice
  should refuse to dismiss on a failed ack is the owner's call. Each site now
  carries that caveat in a `silent-write-ok:` marker.
- **`PaymentVoucherNew.tsx:260`** — *"Saved as a draft — open it to post to the
  GL"*. Post is gated on `scm.payment_voucher.post`, a DIFFERENT permission from
  the one that let the user create the draft, so a create-only user lands on a
  page with no Post button. Whether those two are ever granted apart could not
  be settled from `frontend/src`. **UNKNOWN**, cheap to settle from the role
  catalogue.

---

## 5. CLEARED — read, and not this defect

So nobody re-chases them.

- **`auth/AuthScreens.tsx` forgot-password** — `catch {}` is anti-enumeration,
  and the confirmation is conditional ("If an account exists for …"). Correct.
- **`portal/pages/PortalCaseDetail.tsx:80`** — only a 401 becomes `expired`;
  every other error becomes `err`. Correct.
- **`SalesInvoiceDetailV2.tsx` cancel → "You can reopen it later"** — `doReopen`
  exists and renders under the same permission that gated Cancel. Kept.
- **`SalesOrderDetail.tsx` cancel → "You can Reopen it later"** — true, but the
  Reopen lives in the SO LIST's quick-view drawer, not on the detail page the
  operator is standing on. Discoverability, not a false claim.
- **`SalesInvoiceDetailV2.flushPaymentDrafts`** — refuses to diff against
  `paymentsQ.data ?? []` and throws *"We couldn't check which payments are
  already saved, so nothing was changed"*. Best-in-class; do not touch.
- **`StockTakeDetail.tsx:287-345`**, **`useCancelGrn`**, **`MobileInbox.markAll`**,
  **`MobilePOD` confirm**, **`MobileGrnZeroCost`**, **`MobileNewSO.applyLineDiff`**
  (throws on N failed lines), **`MobileDeliveryPlanning` two-step field save**
  (*"Disposal change NOT submitted … The other fields were saved."*) — all
  correct, several exemplary.
- **`ProjectMaintenance.tsx:2022`**, **`HrSettings.tsx:525`**,
  **`HrCommission.tsx:415`**, **`SalesOrderMaintenance.tsx:1496`** — all guard
  the empty state on `isError` or render the error above it. Reference
  implementations for §4.
- **Deliberate best-effort no-ops** (a telemetry ping has no business surfacing
  an error): presence heartbeat, push registration during sign-in, read
  receipts, the R2 thumbnail fetch, the scan prompt-cache pre-warm, the
  dev-only test-mail injector, the 403-expected ASSR probe. All now carry a
  `silent-write-ok:` marker naming the reason.

---

## 6. Why shape 3 is NOT gated, with the numbers

A gate was attempted and declined. Shape 3 has no `catch` to look at: the
failure is an ordinary TanStack error state the component never asks about.
Every mechanical formulation tried was useless in one of two directions —
a regex over `?? []` / `data?.x` produced **1,277 candidates and no findings**,
and tightening it to something precise enough to act on produced **zero hits**.

**A noisy gate is worse than none.** Shape 3 stays a reader's job, and that is
written into the header of `check-silent-writes.mjs` so a clean run there is not
over-read. What DOES help mechanically already exists and should be reached for:
`StatCard`'s `pending` prop (its doc comment: *"A figure the app cannot vouch
for must never be rendered as a figure — least of all a money one"*) and the
`&& !isError` idiom in `HrSettings` / `HrCommission`.

The one cheap mechanical win not taken: widening
`backend/scripts/lib/swallowed-read-scan.mjs:127` to cover `\(\s*\{` — a
parenthesised object literal — would bring `Sales.tsx:778` and `:787` (T11)
under the ratchet that already exists. **UNTESTED**; that is a code-reading
claim about the scanner, not a run of it.
