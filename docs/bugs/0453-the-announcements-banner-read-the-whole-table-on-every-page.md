## The announcements banner read the WHOLE table on every page, every minute [medium]

<!-- area: Mail, search, notifications -->

**Symptom.** The browser console logged `[perf] slow GET /api/announcements/banner
~900ms` on prod, repeating from every page every ~60s. Measured 2026-08-20 on
erp.houzscentury.com (console open) — no JS error, but the banner poll was the
one call consistently over the slow threshold.

**Root cause (traced, not guessed).** `GET /banner` is cached per-user in KV for
60s, but on a cache MISS the handler ran `SELECT * FROM announcements ORDER BY
created_at DESC` — the ENTIRE table, no `WHERE`, no `LIMIT` — then filtered
active / not-expired / company / user in JS. Migration 0058 had already created
the index `announcements (is_active, created_at DESC)`, but with no `WHERE` the
planner could not use it, so every miss was a full sequential scan. The banner is
polled from every desktop page (`NotificationBell`, `useAnnouncementBanner`) and
every mobile page (`MobileAnnouncements`), all hitting the same endpoint, so the
scan ran constantly as caches expired across users.

**Fix.** Push the active filter into SQL: `SELECT * FROM announcements WHERE
is_active = 1 ORDER BY created_at DESC`. `is_active` is `integer NOT NULL DEFAULT
1`, so the column holds only 0/1 and `is_active = 1` selects EXACTLY the rows the
JS `isActiveFlag` filter already kept — behaviour-identical, no announcement that
used to show is lost. The query now matches the `(is_active, created_at DESC)`
index as a range scan instead of a full-table read. The JS filters (expired /
company / user targeting) are unchanged. One backend endpoint feeds both desktop
and mobile, so this fixes both surfaces at once.

**Verified against.** `announcementsBannerFilter.test.ts` +
`announcementsListAccess.test.ts` (5 tests) green; backend typecheck clean.

Ref: 2026-08-20.
