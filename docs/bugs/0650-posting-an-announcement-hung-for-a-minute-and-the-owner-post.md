## Posting an announcement hung for a minute and the owner posted it nine times — the route awaited the four-language translation before answering [high]

<!-- area: Mail, search, notifications -->

**Symptom.** The owner (2026-09-06): "为什么 Announcement schedule post 卡很久" —
Schedule post on a rich "Notice of Policy Update" sat on "Posting…" for a
minute or more. He clicked again, and again. Production held NINE active
copies of that one notice (08:32, 08:33, 08:36, 08:37, 10:15, 14:38,
14:39, 14:40, 14:49), each scheduled for 07/09/2026 09:00 and each
translated — each click had in fact succeeded server-side; the browser
just never saw the answer. Eight were set inactive by hand the same
evening; the last one stands.

**Root cause (traced).** `POST /api/announcements`
(`backend/src/routes/announcements.ts`) ran
`await translateAnnouncement(...)` BEFORE the INSERT. That is one Claude
call that must return four languages of the whole notice. Since the rich
body landed on 2026-09-04 (#2959 / #2995) the model is sent the HTML and
asked to echo every tag back four times, `max_tokens` 4096, so a notice
with headings, a table and several paragraphs takes 40–100 s to generate;
429 / 529 are retried up to three times with a full regeneration each; the
fetch had no timeout and neither did the client. The comment on the await
— "Awaiting is fine (rare + short)" — was written for plain text. Same
await on the PATCH edit path. Schedule post and Post announcement are one
route; scheduling adds nothing, so any rich post hung the same way.

**Fix.** The routes write the row with `translations = NULL`, answer, and
run `translateAndStore()` (`backend/src/lib/translate-announcement.ts`)
under `waitUntil` (`queueTranslation` in the route, the same
floating-fallback shape as the banner cache fill). The fill is guarded on
the text itself — `WHERE id = ? AND title = ? AND body = ? AND
body_html = ?` — so a reply that lands after the notice was edited is
dropped ("stale") and the edit's own run stores the current text's
translation; PATCH clears the old translation in the same UPDATE as the
text so a reader never sees the old translation over the new original.
Each model attempt now carries `AbortSignal.timeout(30 s)`. Readers fall
back to the original text until the fill lands (the contract since #134).
Pinned by `backend/tests/announcementsTranslateAsync.test.ts` — RED on the
unfixed tree (the module has no `translateAndStore`, and the first case,
"POST answers before the model replies", waits on an await that never
returns) — and `tests/translateAnnouncementTimeout.test.ts`.

**Ref.** fix/announcement-translate-async-0906, 2026-09-06.
