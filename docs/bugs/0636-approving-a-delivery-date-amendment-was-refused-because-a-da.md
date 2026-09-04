## approving a Delivery Date amendment was refused because a Date object sorted as 'Fri Aug 28' [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Logistics (Bernard) pressed Approve & apply on
2990-SO-2606-011/A1 (DELIVERY lane, Delivery Date 13/09/2026 → 19/09/2026,
"Customer request change delivery day") on 2026-09-04 and got "Could not apply
this amendment — That clashes with something already in the system. Please
refresh and check." Nothing on the amendment or the SO was wrong: processing
date 2026-08-28, delivery 2026-09-13 → 2026-09-19, status REQUESTED, no stale
lease. The owner's question: 为什么不能 Approved deliveryDate.

**Root cause (traced).** Two defects stacked. (1) The approve-time date
re-check in `backend/src/scm/routes/so-amendments.ts` (added by #1363,
2026-07-28) read the SO's stored `processing_date` and normalised it with a
local `String(v).slice(0, 10)`. That handler runs inside `runScmPgCommand`,
whose postgres.js shim (`pg-supabase-transaction.ts`, built-in `date` parser
for OIDs 1082/1114/1184) returns a DATE column as a JS **Date object**, so the
string was `'Fri Aug 28'`, not `'2026-08-28'`. The order check
`nextProc > nextDeliv` then compared `'Fri Aug 28' > '2026-09-19'`, which is
TRUE ('F' sorts after '2'), and the gate returned 409
`amendment_dates_order_stale`. Reproduced in node:
`String(new Date('2026-08-28')).slice(0,10)` → `'Fri Aug 28'`. Only a
Delivery-Date-only header amendment hits it: an amendment that sets the
Processing Date takes that side from its own jsonb (a string), and the
delivery side `'2026-…' > 'Sat Sep 13'` is false. This was the FIRST such
amendment since #1363 — every approved DELIVERY-lane row before it carried
line-level dates (`header_changes` null) and never entered the block.
(2) The refusal's `reason` is 266 characters; `frontend/src/vendor/scm/lib/
authed-fetch.ts` only renders a server sentence under 200 characters, so the
real explanation was dropped and the generic 409 line shown instead — which is
why the dialog blamed a "clash" that did not exist. Traced by reading the
handler's every 409 site against the live row, confirming no PG error was
logged for the attempt, and reproducing the compare.

**Fix.** `soDateDay` in `backend/src/scm/shared/so-processing-date.ts` is now
the one normaliser for a stored SO date — a Date object becomes its UTC
calendar day, strings keep the old `.trim().slice(0, 10)`, invalid Date → '' —
and `soDateYmd` builds on it. The approve-so gate uses `soDateDay` instead of
its local helper. Both `amendment_dates_*_stale` refusals now carry a short
`message` the operator will actually see; the long `reason` stays for logs.
Pinned in `backend/src/scm/shared/so-date-pair.test.ts` ("a Date object is a
day, not 'Fri Aug 28'"): proved RED on the unfixed tree (`soDateYmd(new
Date('2026-08-28'))` returned null; the compare test asserted the true→false
flip). No data surgery: the SO was never changed (the transaction rolled
back), and the amendment sits at REQUESTED, so re-pressing Approve after
deploy is the whole recovery.

**Ref.** fix/amendment-approve-date-object-0904, 2026-09-04.
