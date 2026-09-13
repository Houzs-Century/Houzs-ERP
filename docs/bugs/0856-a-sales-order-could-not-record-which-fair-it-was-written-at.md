## A sales order could not record which fair it was written at [high]

**Symptom.** The owner asked, on 2026-09-13, which exhibition the order that had
just been created belonged to. The system could not say. Every Houzs Century
sales order carries a VENUE — free text — and nothing else, so "MID VALLEY" was
the whole answer while FOUR different fairs were running at MID VALLEY on those
same three days, one per brand (projects 340 AKEMI / 341 ZANOTTI / 342 ERGOTEX /
2250 ERGOTEX). Exhibition P&L and commission were being reconciled by hand.

**Root cause (traced).** Two separate things, both measured against production
(`anogrigyjbduyzclzjgn`) on 2026-09-13, not read off the source:

1. **The only automatic link never had data to work with.** `project_id` has
   existed on `scm.mfg_sales_orders` since #814, and
   `scm/lib/venue-binding.ts::resolveVenueBinding` stamps it when the salesperson
   is PIC or Sales Attending on a project whose period contains the order date.
   Live counts: `project_id` was non-NULL on **0 of 2,946** Houzs Century orders;
   `venue_id` on **0**; 67 orders carried `venue_source = 'MANUAL'` and 2,879
   carried NULL. The five fairs running that day had **0** rows in
   `public.project_sales_attendees`, and only **38 of 924** Houzs Century
   projects have any attendee at all — the newest dated 2026-08-29. The rule was
   correct and was never fed.
2. **There was no field that could have captured it.** The SO form offered a
   VENUE dropdown over the venue master, which records a place, not an event.
   25 recent orders, matched on venue + date against the running fairs: **1 of
   25** corresponded to a fair that was actually running. The newest order that
   day, `HC-SO-2609-065`, recorded SUNWAY PYRAMID CONVENTION CENTRE, where the
   previous fair had ended on 2026-09-06 and the next began 2026-10-16.

A third, smaller defect was found in the same read and is fixed here: the SO
form's unmastered-venue hint carried the comment *"projects reference ~60
distinct venues and the master holds ~38"*. Live, the master holds **92** and
every venue used by any 2026 fair is in it (`SELECT` over `public.projects` vs
`public.project_venues`, zero misses) — a stale number in a comment, which this
repo's own rule says is worse than no number.

**Fix.** The venue field becomes a FAIR picker (owner's design, 2026-09-13): one
row is a place plus an organizer, with no date unless two rows in one month would
read identically; nothing is typed, because "Others" is a second pick over the
92-row venue master; and the brand is never asked for — it is derived from the
order's SKUs and the server uses it to decide which brand booth at the picked
event the order belongs to. `fair_match` (mig `20260913T1900`) records WHY an
order has no link, because a NULL `project_id` cannot tell PENDING (the fair is
not in PMS yet — 23% of fairs arrive within a week of opening, 13 of 114 after
they had started) from AMBIGUOUS (two booths fit) from UNMATCHED (the brand has
no booth there). A daily Worker pass links the PENDING backlog once the fair
exists; `/scm/fair-pending` is where a person settles the rest.

Pinned by `src/scm/lib/fair-options.test.ts` (21 cases — the rule, including
every case where it must REFUSE to answer), `src/scm/lib/fair-reconcile.test.ts`
(7), `frontend/src/components/FairPicker.test.tsx` (9, including "offers no text
input anywhere") and `frontend/src/pages/scm-v2/FairPending.test.tsx` (4).

**Honest note on those tests:** they are NEW code, so none of them was ever run
against a broken tree — there is no RED run to cite and this entry does not claim
one. One rule did change while the tests were being written: `resolveFair`
originally collapsed every brand match to the lowest project id, which is right
for two records of ONE booth (production held 9 such duplicate groups) but is a
guess where two different ORGANIZERS share a venue on one day — MID VALLEY had
MLE and REX on 2026-03-20. The test asserting the collapse and the comment
forbidding it contradicted each other in the same file; the rule was changed to
answer AMBIGUOUS and `oneBoothOrNothing` now keys on organizer + brand.

**Ref.** `feat/so-fair-picker`, 2026-09-13.
