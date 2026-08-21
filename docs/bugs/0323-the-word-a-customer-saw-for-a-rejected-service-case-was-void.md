## The word a customer saw for a rejected service case was `voided` — and it was a step label on every sales-portal page [high]

<!-- area: Service cases (ASSR) -->

**Symptom.** The customer tracking portal rendered the raw database slug
`voided` where a stage name belongs. The printed service report, for the same
case, said "Voided — Not Valid".

**Not one page. Every sales-portal page.** `portal.ts:120-135` builds the
salesperson stepper by mapping `ALL_STAGES` through `customerStatusFor`, and
`voided` is in `ALL_STAGES` (`backend/src/services/assr.ts:100-109`). So the
slug appeared as a STEP LABEL on every sales view of every case, whatever stage
that case was on — not only on the voided ones. The obvious refutation, that a
voided case never reaches the portal, does not hold either: `resolveTrackToken`
(`caseTracking.ts:204-234`) gates on token existence, `revoked_at` and
`expires_at`, and `caseTrack.ts:19-29` adds nothing. No code path consults the
case's stage.

**Root cause — one rule, five hand-written homes, and the customer-facing one
was the copy that never learned.** `customerStatusFor`
(`caseTracking.ts:277-304`) was a switch over nine stages plus six legacy
aliases ending `default: return { label: stage || "Unknown" }`. It had no
`voided` arm — `grep -n voided backend/src/services/caseTracking.ts` returned
rc=1, zero hits. The other four copies:

| Copy | `voided` |
|---|---|
| `caseTracking.ts` `customerStatusFor` — THE CUSTOMER'S | absent → raw slug |
| `assr_print.ts:95-110` `STAGE_LABEL` | "Voided — Not Valid" |
| `assrFormIntake.ts:360-369` `SHEET_STATUS` | "Voided" |
| `vendor/scm/lib/assr/stages.ts` `ASSR_STAGES.long` | absent (correctly) |
| `MobileServiceCase.tsx` `prettyStage` | a literal bolted on top of the above |

Three different answers for one stage, and the one the customer read was not
English. Nobody was careless. `customerStatusFor` predates `voided`; the ordered
stepper legitimately has no row for a terminal alt-outcome yet also owned the
WORDS, so every surface that needed a word for a non-step had to invent one.
`assr_print.ts:111-115` states the lesson in the file itself — "the document and
the app showing the same case different words is what sent us looking in the
first place" — and it was written over `RESOLUTION_LABEL` and never applied to
`STAGE_LABEL`, the map immediately above it in the same file.

**Fix.** `backend/src/scm/shared/assr-stage-labels.ts`, mirrored byte-identically
to `frontend/src/vendor/scm/lib/assr-stage-labels.ts`. That pair of paths is the
point: `check-shared-mirrors.mjs` enumerates `backend/src/scm/shared` with
`readdirSync` (non-recursive) and looks the basename up in
`frontend/src/vendor/shared` and `frontend/src/vendor/scm/lib`, so landing the
table there puts the EXISTING `--strict` CI gate in front of any future drift
with no new script — and is why the file sits at the top level of `scm/lib` and
not in the `assr/` subdirectory. Seven surfaces now read it: `caseTracking.ts`,
`assr_print.ts`, `assrFormIntake.ts`, `assr/stages.ts` (`long` is read, never
retyped), `MobileServiceCase.tsx`, `ServiceCases.tsx`, `MyCases.tsx`,
`PortalSupplierCase.tsx`.

**A sixth instance, found while wiring.** `MobileServiceCase.tsx`'s stage-change
confirm read `STAGES[STAGE_INDEX[target]]?.long ?? target` — the same
missing-row hole, in the same file that had already patched around it once, so
moving a case to voided on mobile asked "Move to voided?". It calls
`prettyStage` now.

**Which answer was chosen, and why.** The copies had drifted, so this is a
choice and not a no-op. `voided` → "Voided — Not Valid": five of the six
app-side literals already said exactly that, and a raw slug is nobody's intended
copy. The pill colour stays grey — what `voided` already resolved to through the
missing-arm default — so only the word changes. Every other stage's label and
colour is asserted byte-for-byte against the pre-change switch.

**Two things deliberately NOT swept up.**
1. `SHEET_STATUS` overlaps but is not the same map. `assrFormIntake.ts:355-359`
   records that the ops sheet's stats block counts these EXACT strings and that
   "Pending Delivery/Service" has no spaces around the slash. It moved into the
   shared file as its own named export, explicitly the SHEET's vocabulary, with
   its strings pinned byte-identical to what shipped. Folding it into the app's
   words would silently break a spreadsheet's counters.
2. `pending_supplier_pickup` has two owner-visible wordings — "Supplier Pickup /
   Return" in the app and on paper, "Pending Supplier Pickup" in the portal — and
   both look deliberate. That is a wording decision, not a bug, so both are
   preserved exactly and the difference is reduced to a two-line
   `ASSR_CUSTOMER_STAGE_LABEL` override map that is a question for the owner. If
   he unifies them, the map is deleted.

**What stops the sixth copy.** `backend/tests/assrStageLabelOneHome.test.ts`
scans the three backend files that own the question and fails on any re-typed
stage label, on any of them dropping the import, and on `portal.ts` answering
any of its three questions another way;
`frontend/src/vendor/scm/lib/assr-stage-labels.canonical.test.ts` does the same
for the four frontend surfaces and asserts the two copies are byte-identical.
Both were proven by un-wiring: deleting the `voided` row failed 5 assertions with
`voided has no customer wording: expected 'voided' not to be 'voided'` — the
original bug, reproduced; re-growing a local map in `assr_print.ts` failed with
`src/routes/assr_print.ts:323`, naming the file and line.
