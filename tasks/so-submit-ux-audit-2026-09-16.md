# SO "can't submit" UX audit — 2026-09-16

Goal (owner, verbatim intent): perfect the entire "can't submit a Sales Order"
experience so staff/customers NEVER complain "I filled everything in but it
won't save / I don't know what's wrong." One popup listing EVERY blocking reason
at once; offending fields red inline; a persistent "Can't save — N to fix · tap
to see" indicator by Save; the list clears live as fields are fixed; each item
jumps to its field; phone = desktop = backend wording; no false alarms.

Scope of this audit: every SO create/update submit path and the shared client +
backend evaluators.

## The pieces in play (all PROVEN present on origin/main @ d5a422312)

- Client evaluator: `frontend/src/vendor/scm/lib/so-save-problems-client.ts`
  `collectSoSaveProblems` / `collectSoEditSaveProblems` — pure, accumulates every
  client-checkable blocker into one flat `SaveProblem[]`.
- Backend gate: `backend/src/scm/shared/so-save-problems.ts`
  `collectProcessingGateProblems` → `validationFailedBody(problems)` (422 with
  `{error:'validation_failed', message, problems[]}`), plus the proceed refusal
  `collectProceedGateProblems` / `proceedGateUnmetBody`.
- Renderer: `frontend/src/vendor/scm/components/SaveProblemsList.tsx`
  (`SaveProblemsList`, `saveProblemsTitle`, `notifySaveProblems`).
- Parse contract: `frontend/src/vendor/scm/lib/authed-fetch.ts` `parseSaveProblems`
  (`SaveProblem = {code,message,line?,field?}`).
- Submit surfaces (all import + call the shared evaluator, PROVEN by grep):
  `SalesOrderNew.tsx` (desktop full), `SalesOrderNewGuided.tsx`,
  `SalesOrderNewFromProducts.tsx`, `mobile/MobileNewSO.tsx`,
  `SalesOrderDetail.tsx` (header save + amendment).
- Backend routes: `mfg-sales-orders.ts` (create @2384/2393, confirm @2613),
  `consignment-orders.ts` (create @622/636, edit @1236/1244),
  `so-amendments.ts` (approve @812/830) — all funnel gate failures through
  `collectProcessingGateProblems` → `problems[]`.

## Deploy-status finding on the #4007 banner (PROVEN)

- #4007 "stop the SO delivery-address banner firing on a complete address"
  merged 2026-09-15T17:42:22Z, merge commit `2c57495ad`.
- The current MobileNewSO source IS the fixed conditional
  (`{addressRequired && missingAddress.length > 0 && (...)}`, line 2380), naming
  only the missing parts; `missingAddress` is derived with `.trim()` (line 1351).
- The Deploy run for `2c57495ad` (run 35002930553) concluded **success**, and
  within it the **`frontend` job ran and succeeded** (`backend` correctly skipped
  — frontend-only change). So the fix was **deployed live on 2026-09-15**.

VERDICT: the fix is on main AND deployed. The owner seeing the old banner on
2026-09-16 is therefore **NOT a not-deployed gap**. Remaining explanation is
either (a) a **stale cached frontend bundle** in the owner's browser (service
worker / CDN edge), fixed by a hard refresh / cache-bust, or (b) the owner
looked at an order whose address was genuinely incomplete (the banner then
*correctly* shows). Distinguishing (a) from (b) needs the owner's actual screen.
Live-DOM confirmation on the running site is **UNTESTED** here (auth-gated).

## Submit surfaces, by platform (the parity set)

| Surface | Platform | Flow | Client pre-flight (collectSo*SaveProblems) | All-at-once render |
|---|---|---|---|---|
| SalesOrderNew.tsx | Desktop | create (full) | YES | SaveProblemsList popup |
| SalesOrderNewGuided.tsx | Desktop | create (guided) | YES | SaveProblemsList popup |
| SalesOrderNewFromProducts.tsx | Desktop | create (from cart) | YES | SaveProblemsList popup |
| SalesOrderDetail.tsx | Desktop | edit + amendment | YES (collectSoEditSaveProblems) | SaveProblemsList popup |
| mobile/MobileNewSO.tsx | Phone | create | YES | SaveProblemsList popup |
| mobile/MobileSODetail.tsx | Phone | edit | **NO** (server-only) | bulleted text via humanApiError |

## Phone / Desktop parity matrix

Legend: OK = present + parity-correct on that platform; TO-FIX = missing or diverges.

| # | Scenario | Desktop | Phone | Verdict |
|---|---|---|---|---|
| 1 | No false alarm on a complete order | OK | OK (banner #4007 fixed+deployed) | OK |
| 2 | All-at-once list (every reason, one place) | OK (popup, all 4 surfaces) | OK — create=popup; **edit=bulleted text, not the popup** | OK for content; edit presentation differs (see 2b) |
| 2b | Same *presentation* of the list on edit | popup | text list | **TO-FIX (minor)**: give MobileSODetail the SaveProblemsList popup for parity |
| 3 | Structured backend contract, never a bare error | OK | OK (server 422 problems[] both) | OK |
| 4 | Persistent "Can't save — N to fix · tap" indicator | **TO-FIX (absent all 4)** | **TO-FIX (absent both)** | **TO-FIX both platforms** |
| 5 | Line-level named, plain language | OK | OK | OK |
| 6 | Identical wording + verdict, matches backend | OK (parity test) | OK (parity test) | OK |
| 7 | Wording = what + where/how, 白话文 | OK | OK | OK |
| 8 | Inline red fields | OK | OK | OK |
| 8b | List/count clears LIVE as fixed | **TO-FIX** (problems computed only on submit) | **TO-FIX** (create); edit is server-only | **TO-FIX both**, falls out of #4 |

Net to-fix, both platforms: #4 persistent indicator, #8b live count. Plus minor
#2b (mobile edit popup) and closing the mobile-edit client-pre-flight gap so the
phone edit gives the SAME instant verdict the desktop edit does.

## Scenario-by-scenario

### 1. Form complete but still warned ("明明填好了") — false alarms
PROVEN: banner fixed + deployed (above). `collectSoSaveProblems` uses `.trim()`
on every string field (customer name, address1, postcode, delivery date,
processing date); no numeric parse of postcode/phone that could trip on format;
the completeness/variant/date gates only fire when a Processing Date is set. No
client rule is stricter than the backend on the three shared gates — the
`parity.test.ts` asserts byte-equal messages against the live backend function.
VERDICT: **OK** (no residual false-positive found).

### 2. One-error-at-a-time anywhere
PROVEN: every one of the 5 surfaces builds the FULL `problems` array via the
shared evaluator and renders the whole `SaveProblemsList` in one popup; the
evaluator only accumulates, never early-returns. Backend routes likewise collect
all gate failures before responding.
VERDICT: **OK**.

### 3. Generic failure with no reason
PROVEN: backend gate refusals return `validationFailedBody(problems)` /
`proceedGateUnmetBody(problems)` with the full `problems[]`; the frontend
`notifySaveProblems` renders `problems[]` as the list and only falls back to a
single message when the body carries none. Pre-gate single-message 400s exist
(`customer_name_required`, `phone_required`, `invalid_json`, qty/extra 422s) but
customer name + phone + named line are all in the CLIENT pre-flight, so a normal
operator sees them client-side first; the server ones are backstops.
VERDICT: **OK** (backend always emits the structured list for gate refusals).
Minor note: those pre-gate 400s are not part of `problems[]`; they are
belt-and-braces and client-pre-flighted, so no user-facing gap.

### 4. Save looks dead — no persistent affordance near Save
PROVEN ABSENT: grep for "Can't save" / "to fix" / any persistent indicator finds
nothing in any of the 5 surfaces. The blocked-save list only appears AFTER the
operator presses Save (a `notify` popup). There is no always-visible "Can't save
— N to fix · tap to see" control by the Save button.
VERDICT: **TO-FIX** — the one genuinely missing UI addition. Add a shared,
persistent indicator near Save on every SO form (desktop + mobile) that opens the
same `SaveProblemsList` popup.

### 5. Line-level problems name the specific line, plain language
PROVEN: variant/KIV/blank-line problems carry `line` = item code and messages
like "<itemCode> — <Leg Height> is required" / "<itemCode> — fabric colour is
still KIV … Confirm the colour before setting the Processing Date." The item code
is used (not always a friendly name) because it is the parity contract with the
backend.
VERDICT: **OK** (line named + plain; friendlier display-name is optional polish,
out of scope).

### 6. Phone vs desktop divergence
PROVEN: `so-save-problems-client.parity.test.ts` imports the live backend
`collectProcessingGateProblems` and asserts the client emits byte-equal
code/message/line/field for the three shared gates; both surfaces call the same
`collectSoSaveProblems`.
VERDICT: **OK** (guarded by a test that fails on drift).

### 7. Wording — what is wrong AND where/how to fix, plain language
PROVEN: completeness messages name the field + the act ("… before a Processing
Date can be set"); required-field bullets read "<Label> is required."; payment
gaps read "Payment N (Method) needs a <sub-field>." All 白话文.
VERDICT: **OK**.

### 8. Live clearing — error + count update without pressing Save again
PARTIAL: inline field highlighting already updates live on mobile
(`touched && addressRequired && !addr1.trim()` etc.) and desktop has its own
inline required markers. BUT the aggregated list is a one-shot popup and there is
no live count, because there is no persistent indicator (scenario 4). Today the
`problems` array is computed only inside the submit handler, not in render.
VERDICT: **TO-FIX**, coupled to #4 — lift the `collectSoSaveProblems({...})` call
into a render-scope `useMemo` so the persistent indicator's count updates live as
fields are fixed, and have the submit handler reuse the same memo.

## Data-source decision (owner 2026-09-16: 「跟 backend 串通, frontend 只是显示问题」)

The problem set AND wording must be backend-authored; the frontend only displays.
Grounding facts (PROVEN by reading the code):

- `collectProcessingGateProblems` is **PURE** — no DB. Variant completeness reads
  the STATIC `REQUIRED_VARIANT_AXES_BY_CATEGORY` rule against groups carried in
  the payload (`findIncompleteVariantLines`); completeness/date/KIV are all from
  the payload. So a dry-run that runs it costs ~one pure function call.
- BUT the FULL blocker set is two tiers. Tier 1 = the Processing-Date gate above
  (already problems[], parity-locked). Tier 2 = always-required identity (customer
  name, phone, a named line), venue, salesperson, stock-location mapping, sofa-mix,
  payment sub-fields — today these are scattered route-level single-message 400s
  (backend) AND independent rules in the client evaluator (frontend). Tier 2 is
  the part that can drift, and it is NOT parity-locked.

RECOMMENDED — Option A+ (backend is the full authority; frontend holds zero rules):
1. New shared backend `collectSoSubmitProblems(facts)` = tier 1 + tier 2, every
   blocker as problems[] with the wording moved from the client to the backend.
2. Real create/edit/consignment/amendment routes use it — folding the scattered
   tier-2 400s into one 422 problems[] (a strict UX improvement: a missing phone
   becomes a listed reason, not a bare 400).
3. New POST validate endpoint(s) that run the SAME collector on the draft and
   return problems[] WITHOUT writing (no doc-no, no idempotency, company-scoped,
   same permission gate). Pure/cheap; latency measured (R43).
4. Frontend DELETES collectSoSaveProblems/collectSoEditSaveProblems and calls the
   validate endpoint debounced ~400ms (R103 polling/debounce, no websockets),
   rendering problems[] as the live list + the persistent "Can't save — N to fix"
   indicator + jump-to-field. Submit renders the 422 verbatim. Zero client rules.
   COST: real rearchitecture — new endpoint, backend collector extension, 6-surface
   frontend refactor, remove client evaluator + tests, add endpoint tests. Multi-PR.

ALTERNATIVE — Option B (smaller, presentation-only + parity hardening): keep the
client mirror but extend the parity test to lock tier-2 wording too, keep the
backend 422 as the always-winning authority rendered verbatim, and document the
client copy as an instant mirror only. Faster, but the frontend still "holds
rules" (provably-locked) — not exactly what the owner asked.

DECISION: reported to main for owner scope confirmation BEFORE building (Option A+
is a larger change than a presentation-only PR). Recommendation: A+.

## To-fix summary (what the follow-up PR(s) do)

1. New shared `SaveBlockedIndicator` component (renders nothing when 0 problems;
   otherwise "Can't save — N to fix · tap to see", opens the same
   `SaveProblemsList` popup). Desktop + mobile styling.
2. In each of the 6 surfaces (SalesOrderNew, SalesOrderNewGuided,
   SalesOrderNewFromProducts, SalesOrderDetail on desktop; MobileNewSO,
   MobileSODetail on phone): lift the existing `collectSoSaveProblems` /
   `collectSoEditSaveProblems` argument into a memoized `blockingProblems`;
   render the indicator by the Save button; the submit handler consumes the same
   memo (no behavior change to what blocks — presentation only).
3. MobileSODetail: add the same `collectSoEditSaveProblems` client pre-flight the
   desktop SalesOrderDetail already has, and render blocked saves through the
   SaveProblemsList popup (matrix #2b), so the phone edit gives the SAME instant
   verdict + presentation as the desktop edit.
4. Live clearing falls out of (2) for free (memo recomputes on state change).
5. Everything else (scenarios 1,3,5,6,7) is already live; no rule weakened.

Verification plan for the fix (BOTH widths, owner hard requirement): `npm
--prefix frontend run typecheck`, the existing so-save-problems tests + a new
indicator test, and browser-verify the indicator + live clearing at DESKTOP
width AND ~400px PHONE width, pasting both. Live-DOM against the deployed site is
auth-gated from this session; if it stays UNTESTED that is stated plainly.
