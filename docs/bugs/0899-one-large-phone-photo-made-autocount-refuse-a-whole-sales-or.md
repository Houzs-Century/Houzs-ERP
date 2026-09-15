## One large phone photo made AutoCount refuse a whole sales-order edit as body too large [medium]

**Symptom.** The AutoCount outbox health check of 2026-09-14 (run 34834055311)
listed three sales orders whose edits failed on the first attempt with
`body too large`: HC-SO-2609-063, HC-SO-012388 and HC-SO-013496. A 4xx is not
retried, so nothing about those edits reached the account book — including, on
HC-SO-2609-063, a payment's new balance (docs/bugs/0896).

**Root cause (traced).** AcSyncService's HTTP listener refuses any request over
`const int MaxBody = 2 * 1024 * 1024` with 413 `body too large`
(`AcSyncService.cs`, checked on `ContentLength64` and again after reading). The
drain (`dispatchOne` in `backend/src/scm/lib/autocount-outbox.ts`) attached
every line photograph of an edit to the body as base64, and the SO photo upload
accepts 10 MB with no resize. Measured with the R2 list API on 2026-09-14: each
of the three orders carries exactly ONE photograph, of 2.19, 2.30 and 4.20 MB —
2.9 to 5.6 MB once encoded, over the limit on its own. The number of pictures
was never the problem; one picture was.

**Fix.** The photo step moved to `backend/src/scm/lib/autocount-photo-attach.ts`.
`planPhotoBudget` sizes the encoded body and attaches lines in payload order
while it stays under the host's limit (with 64 KB headroom); a line that would
cross it sends no `Photos` key, so the book keeps that line's existing pictures
— the same per-line all-or-none rule an unreadable picture already followed.
The sent row's `last_error` carries `PHOTOS NOT SENT: …` naming the line and
size, and `check-autocount-outbox-health.mjs` lists those rows apart from
line-identity gaps. Tests: `autocount-photo-attach.test.ts` (6) and a drain case
in `autocount-drain.test.ts`, proved RED against `main`'s drain (1 failed).

**Not fixed here.** The large picture itself still does not reach AutoCount;
that needs it shrunk at upload or by the host (with `MaxBody` raised). The three
orders' refused edits need re-queueing to send what they carried.

**Ref.** fix/ac-photo-body-budget, 2026-09-14.
