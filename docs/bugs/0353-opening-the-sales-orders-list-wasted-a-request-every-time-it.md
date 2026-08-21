## Opening the Sales Orders list wasted a request every time — it fetched, aborted itself, then fetched again [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Every open of the Sales Orders list (`MfgSalesOrdersListV2`) fired
`GET /api/scm/mfg-sales-orders` TWICE: the first request was immediately aborted
(`AbortError: signal is aborted without reason`), then a second one carrying a
`sort` param succeeded. One wasted round trip per open, for every operator who
has ever clicked a column header (their sort is persisted).

**Root cause traced — the sort-sync handshake raced the first fetch.** The page
mounts with `sort=undefined` and the list query (`useMfgSalesOrdersPaged`) fires
straight away = fetch #1, no sort param. Meanwhile `DataTable` restores its sort
from `localStorage` (`dt:sort:sales-orders-v2`) and in a one-shot mount effect
(`reportServerSort`) pushes it up via `onSortChange` → the page's
`setSortAndReset` → `setSort(...)`. That changes the React Query key, so fetch #2
starts and aborts the still-in-flight fetch #1. The handshake was correct; it
just landed one render too late.

**Fix.** Defer the first fetch by one render until the mount report lands.
`useMfgSalesOrdersPaged` gains an `enabled` param (default `true`, so its other
caller is unchanged). The page promotes the existing `sortSyncedRef` handshake to
state — `const [sortReady, setSortReady] = useState(false)`, set `true` inside the
first `setSortAndReset` call — and passes `enabled: sortReady`. The DataTable's
mount effect ALWAYS reports exactly once (even `null` when nothing is persisted,
because `serverSort` + `onSortChange` are both present), so the no-persisted-sort
case still enables and never hangs. Now the first and ONLY fetch already carries
the restored sort.

**Ref.** 2026-08-18, branch `fix/so-list-double-fetch`. Test:
`frontend/src/vendor/scm/lib/sales-order-queries.paged-enabled.test.tsx`.
