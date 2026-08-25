## The QR printed for the driver opened a page only the office could reach [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** In business terms: the code printed on the delivery order was
useless to the two people it was printed for. The storekeeper at the lorry and
the driver on the road both scan the paper that travels with the goods — neither
of them has an ERP account. The QR sent them to `/scm/do-load?id=<id>`, which is
behind the staff sign-in AND behind the `scm.sales.delivery` page guard, so the
phone showed a login screen. The three-scan ladder the owner asked for
(storekeeper loads, driver departs, driver delivers) therefore existed only for
somebody sitting at a desk.

The caption made the second half of the same mistake. It read `SCAN · MARK
LOADED`, which named ONE of the four rungs — so on three papers out of four it
told the person holding it to do something that was not the next step, and the
rung it did name is the one most delivery orders skip (a delivery order is born
LOADED unless it was raised as a draft).

**Root cause (traced).** `frontend/src/vendor/scm/lib/delivery-order-pdf.ts`
built the QR from `header.loadScanId` — the delivery order's row **id** — into
`${window.location.origin}/scm/do-load?id=…`, and `App.tsx` routes
`/scm/do-load` inside the authenticated tree with `area="scm.sales.delivery"`.
There was no unauthenticated route to point it at, and no credential a printed
page could carry: a row id is not one, because it is already visible to anyone
who can see the document and it identifies the row without proving anything.

The caption is the same line of that file, `doc.text('SCAN · MARK LOADED', …)`,
written on 2026-08-21 when the page did exactly one thing (`DRAFT → LOADED`).
The ladder grew to four rungs on 2026-08-26 (#2719) and the caption did not move
with it — a string describing behaviour that has since changed, which is the
class CLAUDE.md calls a fact with an expiry date.

**Fix.** The owner was shown the risk of a public, no-login scan twice and chose
it: 「就跟hookka一样」 — a public QR exactly like Hookka's, where the unguessable
token printed on the paper IS the credential. He accepted one addition on top of
Hookka's shape, a kill switch for a leaked paper, because Hookka's token has
neither an expiry nor a revocation while Houzs already runs that pattern.

- **Migration `0328_scm_do_public_scan_token.sql`** adds
  `scm.delivery_orders.qr_token` (64 hex, nullable, minted lazily) with a
  **UNIQUE partial index**, and `qr_revoked_at` (nullable, no index, read only
  after the row is found — mig 0126's pattern, whose header calls it "that kill
  switch"). The unique index is a tenancy control, not a performance one: see
  below.
- **`backend/src/scm/lib/do-scan-token.ts`** mints (two `crypto.randomUUID()`s,
  hyphens stripped) and resolves. Minting is reachable ONLY from the
  authenticated `GET /api/scm/delivery-orders-mfg/:id/scan-token`; the claim is
  atomic (`UPDATE … WHERE id = ? AND company_id = ? AND qr_token IS NULL`), so
  two simultaneous prints cannot mint two diverging tokens and leave one paper
  dead.
- **`backend/src/routes/publicDoScan.ts`** is the public surface, mounted before
  the `/api/*` auth gate: a minimal read and a forward-only one-rung advance.
  The advance runs `patchDeliveryOrderStatusHandler` — the office's own writer —
  through a synthetic context, so there is deliberately no second write path to
  drift.
- **`frontend/src/pages/PublicDoScan.tsx`** at `/d/<token>`, outside `AuthGate`,
  and the print now encodes that URL. The caption reads **`SCAN AT EACH STEP`**,
  which is true of all four rungs and tells the reader the thing the old one did
  not: that this code is scanned more than once.

**One ladder, not two.** The rungs, the button words, the line under each button
and the confirmation sentences moved out of `do-next-step.ts` into
`backend/src/scm/shared/do-scan-ladder.ts`, mirrored byte-identically at
`frontend/src/vendor/shared/do-scan-ladder.ts` and held there by
`check-shared-mirrors --strict`. The server has to decide the target status
itself — a rung named in a request body is a rung an attacker picks — and a
second copy of the ladder in `backend/` is exactly the duplicated-decision class
this repo gates on. `do-next-step.ts` re-exports it, so no existing import moved.

**The tenant boundary, which is the part that mattered.** A public route DOES
have a company; it just does not come from a session. The token resolves to
exactly ONE row (mig 0328's unique index is what makes that a database guarantee
rather than a 256-bit probability argument), and `company_id` on that row is NOT
NULL (mig 0083). That value is the scope for every statement afterwards — the
line count here, and every read and write inside the status handler — and
nothing in the request can name a company. **Bug 0497 is why this is asserted
per STATEMENT**: `check-company-scope.mjs` acquits a whole handler on one scoped
call (0542), which is how a rack write went unscoped inside a scoped handler.

**Proved RED on the unfixed tree**, guard by guard, by deleting each one and
re-running:

| guard deleted | test that went red |
| --- | --- |
| the 64-hex shape gate | `a malformed token never reaches the database` — the tripwire recorded a `delivery_orders` query |
| `if (row.qr_revoked_at) return null` | `a REVOKED token gets the identical answer an unknown token gets` — 200 instead of 404 |
| the already-done branch | `a repeat scan says already-done and does NOT take the next rung` — the second press advanced the document |
| the company predicate on the line count | `the five fields, the next rung, and nothing else` — the count read the other company's line |
| the company taken from the resolved row | `the company comes from the resolved ROW` — the write missed our row |
| a rung pointed backwards | `every rung lands strictly further along than where it started` |

Pinned by `backend/tests/publicDoScanRoute.test.ts` (behaviour, through the real
handler), `backend/tests/publicDoScanSurface.test.ts` (mount order, per-statement
scope, banned field names, rate limits), `backend/tests/doScanLadder.test.ts`
(forward-only as a property, plus the mirror) and
`frontend/src/pages/PublicDoScan.test.tsx` (the mounted page).

**What this does NOT do, said plainly.** `Confirm Delivered` still writes
DELIVERED and captures no signature, no photo and no location — bugs 0480 and
0481. This is now the SIXTH way to close a delivery and the only one with nobody
logged in behind it, so the note beside the button names that loss before it is
pressed and points at Proof of Delivery, rather than growing a second capture
path (which is what 0480 was written about). The note travels with the rung, so
a rung cannot be rendered without it.

**Ref.** feat/the-driver-scans-without-logging-in, 2026-08-26.
