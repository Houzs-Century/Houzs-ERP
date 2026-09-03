## One person editing alone was locked out of their own order for five minutes [high]

<!-- area: Sales orders + pricing -->

**Symptom, in the owner's words.** He was the only person touching HC-SO-013361.
Every Save came back:

> Save failed. This order is being saved on another screen. Your changes are
> still here. Wait a moment, then try Save again.

There was no other screen. His console carried fourteen `409`s on
`/api/scm/mfg-sales-orders/HC-SO-013361` and one `504`.

> 「怎么一直说有人操控着呢？明明都没有人操控啊，我就是那个」
> 「我现在一个人只能 edit 一次，不可以呀。我一 save 了，我一 edit，关了就是关了？」
> 「为什么是 5 分钟呢？不是看 live 的吗？」

All three questions were right, and the third named the design fault.

**Root cause (traced).** A sales order carries a save lock — `edit_lease_token`
plus `edit_lease_expires_at`, from mig 0172. It exists for a real reason: a
composite save is several requests (reserve → line writes → header commit), and
version CAS alone cannot see a half-applied set of line writes.

Three things about it went wrong together:

1. **It lasted five minutes.** The lock is taken at SAVE time and released in a
   `finally` — `runSoVersionedMutation` in
   `frontend/src/vendor/scm/lib/so-versioned-mutation.ts`; opening an order takes
   no lock at all. So the expiry only ever had to outlast one save round trip.
   Everything past that was time a document spent locked for nothing after a save
   died — and his did, which is what the `504` was.
2. **It did not record WHO held it.** So a lock left behind by the caller's own
   crashed save was indistinguishable from a colleague's live one.
3. **One message covered four different states** — no token sent, token
   mismatched, lock expired, lock genuinely held by someone else — and it
   asserted the fourth. Three quarters of the time it sent the reader to look
   for a person who was not there.

**It is NOT a liveness check, and that is worth stating plainly** because the
message implied one. Nothing confirms the other screen exists. The row holds a
token and a timestamp; a lock left by a dead tab looks exactly like one a live
tab holds.

**What a normal ERP does.** Odoo, NetSuite and SAP lean on optimistic
concurrency — a version or ETag, no lock, and the loser is told to reload. Where
they do lock, the lock is held by an identified session and is always
re-acquirable by its own holder; you are never locked out of your own record.
This system already has the version half (`apply_so_header_cas`), so the lock was
only ever needed for the multi-request span.

**Fix — the owner chose A + B after being given three options.**

* **A. The lock records its holder** (mig 0348, `edit_lease_user_id`) and the
  same person takes their own lock back instead of waiting it out —
  `soEditLeaseTakeoverAllowed`. 「锁记住是谁上的 —— 同一个人直接拿回自己的锁」.
  A lock with no holder — written before 0348, or by a path with no
  authenticated user — is never taken over, because absence is the stricter
  answer.
* **B. Five minutes becomes one** (`SO_EDIT_LEASE_MS`), so any crash that is not
  covered by A frees the document in under a minute.
* And the message now says which of the three actually happened, each with the
  next action. Only `held` may speak of another person, and since A that is the
  one case where it is true.

**Option C was offered and NOT taken**: drop the lock entirely and rely on
version CAS alone. It is closest to the industry norm and the largest change on
a money path; it stays available.

**Verified.** `backend/src/scm/lib/so-edit-lease.test.ts` — 16 tests covering the
lifetime, the three messages, the takeover (including `bigint`-as-string, an
unknown holder, and another person), and `lockSoCommandLease` telling all three
states apart. 128 tests pass across the lease-related suites. Backend typecheck
exit 0.

**UNTESTED against a live save.** The lock's behaviour here is proven by unit
tests and by reading the save flow; no production save has been performed since
the change at the time of writing.

**Ref.** fix/so-lease-message-says-which, 2026-09-03.
