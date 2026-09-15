## Every saved venue opened as Others in the sales order Fair field, and Others could not open on a blank form [high]

**Symptom.** Owner, 2026-09-15, with a screenshot of a Sales Order in EDIT mode:
the FAIR dropdown read **"Others — pick a place instead"**, with a second box under
it reading **"MID VALLEY"** —

> 「这个 agent 过去看这一个东西，这个东西应该是我的 file 或者我的 value 吗？怎么会换这一个东西呢？查完之前的 Bug History 跟之前的 PR，找出管理这一个东西，解决回去这个问题？」

His ruling on what the field should be, the same day (2026-09-15), verbatim:
**「应该是venue的」** — the field shows the order's venue, and "Others" is the wrong
state.

**What is stored versus what was shown (PROVEN, production read-only, 2026-09-15
20:14 MYT).** The order is `HC-SO-2609-071` (company 1, `so_date` 2026-09-14).
`scm.mfg_sales_orders` holds `venue = 'MID VALLEY'`, `venue_source = 'MANUAL'`,
`project_id = NULL`, `fair_match = 'PENDING'`. MID VALLEY is a live venue-master
row for company 1 (`public.project_venues` id 1, active). Its 35 rows in
`scm.mfg_so_audit_log` contain **no** change to venue, fair or project — the
value has been MID VALLEY since the order was created on 2026-09-14 12:52 MYT.
Nothing was saved as "Others"; it is only how the edit form drew a value it could
not match. The read-only order page prints `salesOrder.venue` as text
(`SalesOrderDetailV2.tsx`), which is why the order looked right until Edit.

**Root cause (traced).** `frontend/src/components/FairPicker.tsx`, as merged in
#3778 (2026-09-13, `docs/bugs/0862-a-sales-order-could-not-record-which-fair-it-was-written-at.md`),
lines 87-88:

```ts
const onOthers = !picked && !!(value.venue ?? '').trim();
const selected = picked ? optionValue(picked) : onOthers ? OTHERS : '';
```

A dropdown row is a venue PLUS an organizer, and `matches()` needs both. No order
stores an organizer, so every caller that shows an existing or defaulted venue
hands the picker `{ venue, organizer: null }`:

- desktop edit — `SalesOrderDetail.tsx`: `value={{ venue: form.venue || null, organizer: null }}`;
- mobile edit — `MobileNewSO.tsx` seeds `{ venue: h.venue, organizer: null }` from the loaded header;
- both New-SO forms' venue auto-fill — `SalesOrderNew.tsx` and `MobileNewSO.tsx`.

No row can match `organizer: null` (every offered row has one — `isPickableFair`),
so line 87 read "a place with no organizer" as "the operator chose Others", and
EVERY order with a venue opened with the sentinel selected and its place pushed
into a second box. The same inference broke the opposite case: on a form with no
venue yet, choosing Others sends `{ venue: null, organizer: null }` — the value the
form already holds — so `onOthers` stayed false, the select fell back to "—", and
the venue master could not be opened at all. That path had no test.

The refuting observation, made before the fix: if production's list for the order's
date contained any row an organizer-less place could match, the picker would have
shown a row. Production's `public.projects` rows for company 1 were run through the
server's own `buildFairOptions` for 2026-09-14: **0** running, **12** in the month,
**0** rows with an empty organizer; the only MID VALLEY row is REX, 2026-09-11 to
2026-09-13 (projects 340/341/342/2250). Then the REAL component was mounted in a
browser with that payload and the edit form's exact props: `origin/main` rendered
`Fair=Others — pick a place instead` + `Place=MID VALLEY` (the owner's screen), and
choosing Others on a blank form left `Fair=—` with no place list.

**This is a recurrence of a class, not a new kind of bug.** On 2026-08-10 (#1780)
the owner said of this same field 「点 edit 的时候它不会不见掉」 and the edit form
was taught to show the saved venue; on 2026-09-01 「为什么我的 Venue 又不见了？」
(`docs/bugs/0591-picking-up-a-default-venue-wiped-the-venue-the-order-already.md`).
#3778 replaced that control with one whose resting state could not show a saved
venue as itself.

**How many orders (PROVEN, same read).** The edit form drew the sentinel for any
order with a venue, whatever its data: **2,841 of 2,959** company-1 orders and
**175 of 175** company-2 orders carry one (company 2 renders the same editor; not
observed in a browser — LIKELY). `project_id` is set on **0** orders in either
company. No stored venue was changed by this: since #3778 merged the audit log
holds **3** venue edits (`HC-SO-2609-074/075/076` to THE COMMUNE KULAI,
2026-09-14 14:48-14:53 MYT), deliberate edits whose connection to this display is
UNKNOWN.

**Fix.** Rule 5 in `FairPicker.tsx`: a place that matches no row is shown AS the
value, in its own group "Place on this order", and never re-read as a fair —
lighting up MID VALLEY / REX from the venue alone would name a fair that had ended
the day before this order. "Others — pick a place instead" is now an action held
in local state (`choosingPlace`) that opens the venue master; it is never inferred
from the value, which fixes both halves. What the picker sends is unchanged:
fair row -> `{venue, organizer}`, place -> `{venue, null}`, blank -> `{null, null}`.
One shared component, so desktop edit, mobile edit and both New-SO forms change
together; no call site was edited.

Also here: the month group was labelled "Later this month" while holding every
non-running fair in the month, the finished ones included (071's only MID VALLEY
row sat under it); it now reads "Other fairs this month". And a contradiction:
`fair-options-queries.ts` and `mfg-so-fairs.ts` both said the form pre-selects the
first running fair — no form does. The frontend comment is corrected; the backend
one is left for a backend change.

**Tests.** `frontend/src/components/FairPicker.test.tsx`, 14 cases. RED on the
unfixed component: 6 failed, including `expected '__others__' not to be
'__others__'` (071 in edit mode, with the production list for 2026-09-14) and
`expected '' to be '__others__'` (Others on a blank form). GREEN after. Mutation:
putting the old inference back inside the fixed file fails 5 of them. Three older
cases asserted or relied on the ruled-wrong resting state (the place list opening
by itself for a place with no organizer) and now open it through Others.

**Not changed here, needs a person.** All **14** orders stamped since #3778 are
`PENDING`, and for none of the 14 was any fair running at its venue on its order
date — six are MID VALLEY orders dated 2026-09-14/15, after the REX fair's recorded
end. The nightly reconcile cannot link them, and `POST /:docNo/fair` refuses a fair
whose period does not contain the order date. Whether the fair's end date or the
link is what is wrong is the owner's call. Mobile edit also passes `soDate={null}`,
so it offers today's fairs rather than the order date's; the display rule above
does not depend on it.

**Ref.** `fix/so-fair-others-venue`, 2026-09-15.
