## The notification bell polled every 30s; presence was already tuned [low]

<!-- area: Mail, search, notifications -->

**白话.** 通知铃每 30 秒去后台问一次，`GET /api/notifications` 在「慢调用」遥测里出现过。
铃不是即时聊天，放慢到 60 秒，后台负载减半，人看不出差别。

**Symptom (measured).** The Client Errors telemetry (`GET /api/notifications` in the
`[slow 800ms+]` slice) plus `[slow 800ms+] GET /api/presence` (5 signatures). Both
poll on a timer from every tab.

**What was RULED OUT — presence was already optimised, twice.** `usePresence.ts`
is a 60s module-level SINGLETON (one poll for all consumers, burst-collapsed,
visibility-gated), and `routes/presence.ts` added a per-colo EDGE cache (15s TTL)
specifically to kill the earlier `GET /api/presence` 500s. So presence has no
"poll slower" win left — its residual >800ms is the systemic Hyperdrive-connection
floor (the same ~360ms baseline every endpoint pays), not over-polling. Left as-is.

**Fix.** Only the notification bell had headroom: `useNotifications.tsx`
`POLL_INTERVAL_MS` 30s -> 60s (a single-poller-per-app hook that already backs off
on hidden tabs and suppresses no-op renders via a payload-signature guard). Halves
its standing per-tab cost; a bell is not real-time chat, so 60s freshness is fine.

**Verified against.** frontend `tsc -b` clean; no test asserts the interval.

**Ref.** perf/presence-notifications-poll, 2026-08-20.
