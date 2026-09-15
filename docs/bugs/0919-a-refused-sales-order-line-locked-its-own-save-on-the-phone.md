## A refused sales-order line locked its own Save on the phone, even after the operator corrected it [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-15, Edit Sales Order on the phone (HC-SO-011153): after the first
Save was refused, he changed the line and pressed Save again, and got 「Could not save DIVAN
ONLY-(SS): An earlier submission with different details already finished under this request
key. Refresh and check what was recorded before sending it again.. Your edits are still on
screen. Saving again will not help until this is resolved.」 — 「force key可是key了又不行」.
Every further Save gave the same sentence; only a reload, which discards the edit, got out.

**Root cause (traced).** The phone mints one Idempotency-Key per unsaved line
(`frontend/src/mobile/MobileNewSO.tsx`, `addIdempotencyKey`) and reuses it for every Save of
that line, which is correct. The middleware (`backend/src/middleware/idempotency.ts`) stores
EVERY terminal response against the key unless the route proves it wrote nothing
(`refuseWithoutWriting` / `markIdempotencyNoWrite`). `POST /api/scm/mfg-sales-orders/:docNo/items`
never did: of its nineteen exits before its first write, eighteen answered with a bare `c.json`
and the nineteenth passed on the lease guard's refusal, bare as well. So the
first Save's 400 (docs/bugs/0918-a-divan-only-line-was-refused-for-its-total-height-so-a-gap.md)
was kept as the key's outcome, and the corrected line — a different payload hash under the same
key — was answered `idempotency_key_reused`. Read from production, read-only, 2026-09-15:
`idempotency_keys` has one row for that line add, 04:18:59Z, status 400, body
`variant_not_allowed`; HC-SO-011153 still had no DIVAN ONLY line at 04:54Z. The same dead end
was found and fixed for Goods Receipt (`backend/tests/grnPreWriteRefusalsReleaseKey.test.ts`);
this handler never adopted it. The lease guard it calls, `requireSoLineWriteLease`, was a
second instance: its "being saved on another screen, try Save again" refusal was stored too, so
the identical retry it asks for would replay the refusal.

**Fix.** Every refusal from the handler's first line down to its first write (the PWP voucher
claim) answers through `refuseWithoutWriting`, and so do the three refusals of
`requireSoLineWriteLease`, which only reads the lease row. Refusals after the PWP claim are
unchanged — a claim was taken there, so the stored outcome stays. Pinned by
`backend/tests/soLineAddPreWriteRefusalsReleaseKey.test.ts` (added to `MUST_GATE_MERGE`): no
pre-write refusal on a bare `c.json`, the owner's allowed-options exit among them, nothing at
or past the first write releasing, and the lease guard writing nothing and releasing all three
refusals. Proved RED three ways on a mutated tree: the allowed-options exit put back on `c.json`,
one lease refusal put back, and a release added after the PWP claim — each fails its test.

Not changed here, same shape: `POST /api/scm/mfg-sales-orders` (create) also answers its
pre-write refusals with a bare `c.json`; no stored 4xx for it in the 24 hours before this fix
(`idempotency_keys`, read 2026-09-15), so it is recorded rather than guessed at.

**Ref.** fix/divan-only-total-height-line-add-retry, 2026-09-15.
