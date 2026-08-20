## The SO edit-lease token was forgotten client-side while the server still held it [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Potential: an operator told "This order is being saved on another
screen" about themselves, for up to five minutes.

**Root cause (traced).** The page-Save catch released the line-write lease with
`updateHeader.mutateAsync({ completeLineWrites: true, ... }).finally(() => {
activeLineLeaseRef.current = null; })`. `.finally` clears the client's token
whether or not the release succeeded. The server's release predicate is
`.eq('version', clientVersion).eq('edit_lease_token', requestedLeaseToken)`
(`mfg-sales-orders.ts:6810-6812`) and answers 409 when it matches nothing, so a
refused or failed release left the server holding a lease the client could no
longer name; the next Save minted a fresh token, tripped `activeLeaseToken !==
requestedLeaseToken` (`:6782`) and 409'd `so_edit_lease_conflict` until the
5-minute TTL (`:7274`, never renewed) expired.

**Honest scope.** The trigger originally proposed for this — a version that goes
stale between the reserve and the release — could NOT be evidenced: the cron
declines while the lease is held (`so-generation.ts` `leaseActive`) and the item
routes never touch `version` (no `version` write anywhere in the
`POST/PATCH/DELETE /:docNo/items` handlers). So the reachable trigger is a
release that fails for another reason (transient network, 5xx), not a stale
version. Fixed as robustness, and recorded here rather than claimed as the
owner's symptom.

**Fix.** `.finally(...)` -> `.then(clear, keep)`: the token is dropped only when
the server CONFIRMS the release.

**Ref.** feat/so-multi-add-lines, 2026-08-16.
