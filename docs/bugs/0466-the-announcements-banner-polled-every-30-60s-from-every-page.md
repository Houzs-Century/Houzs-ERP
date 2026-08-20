## The announcements banner polled every 30-60s from every page — 3x more often than it needs [medium]

<!-- area: Mail, search, notifications -->

**白话.** 公告横幅（还有通知铃）每 30~60 秒就去后台问一次「有没有新公告」，一个
session 打了 70 多次，每次约 0.36 秒（命中缓存）到 1 秒（没命中）。公告不是即时聊天，
不用问这么勤。放慢到每 3 分钟，请求量降到约三分之一，人看公告的体验没变。

**Symptom + what was RULED OUT (measured on prod 2026-08-20, not guessed).** The
`/banner` call was the single busiest endpoint in a session (76 calls). Probing
the app's own requests: a cache **hit** is ~360ms, a **miss** ~950ms, and the
backend cache **does work** — a natural poll was caught returning
`x-config-cache: hit`. So the earlier "691ms avg / 5.5s max" was cold-start +
pre-deploy outliers, NOT a broken cache. Also ruled out: the `announcement_acks`
query is indexed (`idx_announcement_acks_user`, mig 0058), and `SESSION_CACHE` is
bound — neither was the cause. The real waste was simply CALL VOLUME: three
pollers (desktop banner `POLL_MS`, `NotificationBell` scope=system, mobile
`useAnnouncementUnread`) all firing every 30-60s.

**Fix.** Slow all three pollers to 3 min. The backend already caches per-user for
5 min (`CONFIG_CACHE_TTL_SECONDS.banner = 300`), so a 3-min poll lands mostly on
hits and only re-pays the DB round trip about once per 5 min. Announcements are
not time-critical, so up-to-3-min freshness is fine. Also corrected the stale
`/banner` comment (it claimed "60s TTL … polls at 30s"; TTL is 300s, polls now
180s). The deeper ~360ms hit floor is app-wide per-request overhead (auth + edge
+ KV), not banner-specific, and is out of scope here.

**Verified against.** frontend `tsc -b` clean; no test asserts these intervals.

Ref: 2026-08-20.
