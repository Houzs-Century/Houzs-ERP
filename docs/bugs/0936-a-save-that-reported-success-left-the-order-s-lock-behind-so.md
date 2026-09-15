## a save that reported success left the order's lock behind, so the same person's next save was refused for a minute [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-15, on HC-SO-2609-071 (desktop editor). The console
carried ten `409`s on `PATCH /api/scm/mfg-sales-orders/HC-SO-2609-071` and one
`504` on the page itself (`HC-SO-2609-071?edit=1`).

> 「我第一次 save 的时候可以，可是不确定是不是在短时间内要多一两轮再 save 多一次却不行。」
> 「正常来说，我 save 了就 save 了啊，然后如果我要一瞬间再 edit 第二次也是可以的啊，为什么不可以呢？」

This is the complaint docs/bugs/0630-one-person-editing-alone-was-locked-out-of-their-own-order-f.md
fixed, back again: one person, one screen, locked out by their own save.

**Root cause (traced).** Three separate faults, each proved RED on the unfixed tree.

1. **The save that reported success never released its lock.** Production, read
   only, 2026-09-15 12:04Z and again 12:21Z: the order stood at `version` 15 with
   `edit_lease_token` `a2c1e98d-…` expiring `12:02:10.572Z` (so reserved
   `12:01:10.572Z`), holder user 4 — never released. The audit log shows that
   save's three `UPDATE_LINE` rows at `12:01:11` and no `UPDATE_DETAILS`.
   The order holds `venue` "MID VALLEY" with `venue_id` NULL, and
   `public.project_venues` has an active "MID VALLEY" with id `1`. The desktop
   editor's venue seeding adopts that option by name (`form.venueId = "1"`), so
   the header diff held one field. `SalesOrderDetail.tsx` sent
   `completeLineWrites` only when its diff was EMPTY, so the last request of the
   save carried the lease token, that one field, and no flag. The route drops a
   venue id that is not a uuid (`venueIdUuidOrNull`), found nothing to write, and
   took the "nothing changed" exit — `200 { ok: true, changed: 0 }`: lease still
   on the row, and no `version`, which the editor then adopted as `undefined`.
   The phone (`MobileNewSO.tsx`) had the identical conditional.
   RED: `expected { ok: true, changed: +0 } to match object { Object (ok, version, ...) }`
   (`tests/mfgSalesOrderHeaderCas.test.ts`, "a composite save whose header fields
   all normalise away still releases its lease").
2. **0630's "take your own lock back" never reached the save itself.** Mig 0348
   and `soEditLeaseTakeoverAllowed` were wired into line writes
   (`requireSoLineWriteLease`) and command transactions (`lockSoCommandLease`),
   but the first request of every Save — the reservation on the header PATCH —
   still refused ANY live lease that was not its own token, and so did a
   header-only save. So the leftover lock from fault 1 answered every Save for
   its full minute. The ten 409s fit five presses, each a refused reservation
   plus the refused release that follows it — LIKELY: the console does not show
   the request bodies, and no server log of them exists (`idempotency_keys` holds
   POSTs only). RED: `expected 409 to be 200` ("the same person takes back the
   lock their own earlier save left behind").
3. **A Save reported done before the order was re-read.** The header mutation
   fired the detail invalidation and did not wait for it, and the editor pins its
   version from the cache on open. Edit pressed in that window opened on the
   pre-save copy, whose version the save had already superseded, and the next
   Save was refused as "opened with an older screen" — nobody else involved.
   RED: `expected 14 to be 'not yet'`
   (`frontend/src/vendor/scm/lib/sales-order-queries.save-hands-back-fresh.test.tsx`).

**Fix.**

* `soHeaderLeaseIntent` (`backend/src/scm/lib/so-edit-lease.ts`) decides what a
  header PATCH means for the lock, and the route reads it:
  a token-bearing request that is not a reservation and has nothing left to
  write IS the end of the save, flag or no flag — it releases the lease and
  answers with the version; a reservation or a header-only save by the lease's
  own holder takes it back (the CAS call requires exactly that lease, so a
  racing change still loses); the end of a save the same person has since
  superseded is still refused. The "nothing changed" answer now carries
  `version`.
* `soSaveEndFields` / `soVersionAfter` (`frontend/src/vendor/scm/lib/so-save-lease.ts`),
  used by BOTH the desktop editor and the phone: a save that took a lease always
  ends with `completeLineWrites`, and no screen adopts a version the server did
  not name.
* `useUpdateMfgSalesOrderHeader` returns the detail invalidation from `onSuccess`,
  so the Save's own callback — and the return to the detail page — waits for the
  re-read. Reservation and the failure-path release still do not wait.

**Not changed, on purpose — and what is still open.**

* The venue seeding that made the diff non-empty belongs to the FAIR / venue fix
  running alongside this one (branch `fix/so-fair-others-venue`). This entry makes
  the lock safe whatever field a screen and the server disagree about.
* Status change (`PATCH /:docNo/status`), draft discard (`DELETE /:docNo`) and
  amendment apply still refuse any live lease, the caller's own included. After
  this fix a lock is only left behind by a save that crashed, for at most a
  minute. Their UPDATE predicates also exclude a live lease, so taking the lock
  back there is a larger change, and it is not made here.
* The deferred allocation recompute can advance the order's status — and its
  version — a moment after a save. An Edit pressed in that moment still meets a
  real version change. How often that happens is UNKNOWN; it was not measured.
* The `504` on the page load is not explained by any of the above. UNKNOWN.

**Verified.** Backend: 59 tests across the five lease/header suites and 22 in
`so-edit-lease.test.ts`, green after the fix; `tsc --noEmit -p .` exit 0
(a planted type error was caught first). Frontend: `so-save-lease.test.ts` (8),
`sales-order-queries.save-hands-back-fresh.test.tsx` (2),
`so-versioned-mutation.test.ts` (4), green. **UNTESTED against a live save** at
the time of writing: no production save has run on this code.

**Ref.** fix/so-consecutive-save, 2026-09-15.
