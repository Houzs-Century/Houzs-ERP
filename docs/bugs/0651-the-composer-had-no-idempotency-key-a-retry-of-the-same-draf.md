## The composer had no idempotency key — a retry of the same draft after a hang or a reload posted a second copy [high]

<!-- area: Mail, search, notifications -->

**Symptom.** The other half of `docs/bugs/0650`. The owner (2026-09-06):
"为什么 Announcement schedule post 卡很久" — the first request hung, he
clicked Schedule post again, closed and reopened the composer, reloaded,
came back an hour and a half later and clicked again. Production held nine
active copies of one notice, each scheduled for 07/09/2026 09:00. #3016
took the hang away; nothing stopped the next retry from posting twice.

**Root cause (traced).** `POST /api/announcements`
(`backend/src/routes/announcements.ts`) had no notion of "the same post
again": each request minted a fresh `genId()` and INSERTed. The desktop
composer (`frontend/src/pages/announcements/ComposerModal.tsx`) disables
the button while `posting` is true, which covers a double click inside one
request and nothing else — the draft autosaves to localStorage and is
restored on the next open or reload with no memory of having been sent, so
each retry was a brand-new post carrying the same words. The phone
composer (`frontend/src/mobile/MobileAnnouncements.tsx`) had only the
`saving` flag and no re-entry guard in `publish`. The house pattern for
this — `frontend/src/lib/idempotency.ts` — was in use for payments and SO
create and never wired to announcements.

**Fix.** Migration `20260907T0010_announcement_client_key.sql`: nullable
`announcements.client_key` plus a partial unique index on
`(created_by, client_key)`. The desktop draft (`ComposerDraft.clientKey`)
mints a key with `newIdempotencyKey()` when it is first written, keeps it
across edits and reloads, sends it as `clientKey`, and it dies with the
draft on success; a draft saved before keys existed is given one on read.
The phone composer keys its mount with `useIdempotencyKey()` and `publish`
returns while `saving`. The route reads the key (shape-checked,
`readClientKey`), looks up `(created_by, client_key)` first and answers a
repeat with the existing row and `duplicate: true` (201, no second INSERT);
the INSERT appends the column only when a key came, so a keyless client and
the D1 test mirrors without the column post exactly as before; two requests
racing past the lookup hit the index and the loser is answered with the
winner's row. The desktop composer's `post` also carries a ref guard and
tells the author "This notice was already posted — no second copy was
made" on a `duplicate` reply. Pinned by
`backend/tests/announcementsClientKey.test.ts` — RED on the unfixed tree:
"a repeat with the same key gets the first row back" counted 2 rows, and the
race case 2 — and by `frontend/src/pages/announcements/ComposerModal.test.tsx`
(same key on the retry after a failed post and after a restore; the
duplicate toast).

**Ref.** fix/announcement-post-idempotency-0907, 2026-09-07.
