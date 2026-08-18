# COE — the legacy AutoCount read relay answers the public internet with no key

**Date:** 2026-08-12 · **Status:** OPEN, needs an owner action at Cloudflare ·
**Severity:** high — customer and supplier data readable by anyone who knows the
hostname

---

## Trigger

Nobody reported this. It was found while answering an ordinary question — *"can
people look at AutoCount data through the tunnel?"* — by probing which routes
the legacy relay still serves. The answer to the owner's question was "not
through the write tunnel, but there is an older read relay", and checking that
claim is what surfaced this.

## What is exposed

`https://it-houzs.dev` is the pre-cutover read middleware. It is still running.
Measured 2026-08-12 from an ordinary workstation, **with no credential of any
kind**:

```
GET https://it-houzs.dev/PurchaseOrder/getAll  -> 200   52,555,844 bytes
GET https://it-houzs.dev/Debtor/getAll         -> 200        65,087 bytes
GET https://it-houzs.dev/SalesOrder/getAll     -> 401
GET https://it-houzs.dev/Item/getAll           -> 404
GET https://it-houzs.dev/Stock/getAll          -> 404
GET https://it-houzs.dev/definitely-not-a-route-> 404
```

**Two endpoints answer 200 without authentication.** One returns roughly 52 MB —
the shape and size of the entire purchase history. The other returns the debtor
master, which is the customer list. `/SalesOrder/getAll` requires a key, which
is what makes this a gap rather than a design: **the auth was applied per route
and two routes were missed.**

Only the status code, the content type and the byte count were read during this
investigation. **The response bodies were not downloaded and are not recorded
anywhere**, because reading them would be doing the thing this document is
about.

## Root cause

Not yet traced to the line — the relay's source is not in this repository, and
that is itself part of the finding. What is established:

- the hostname is public, on Cloudflare, and resolves from anywhere;
- authentication exists on the relay (a 401 proves the middleware runs and can
  refuse), so this is **per-route auth with two routes uncovered**, not an
  absent gate;
- it predates the cutover, so it has been reachable for as long as the hostname
  has, and nothing in the repository named it as a live exposure.

## Why this is the second time

The API key for the write service was previously downloadable over a file server
on **the same host**. That was closed.

> **`docs/autocount-writeback-exposure-coe.md` DOES NOT EXIST** — corrected
> 2026-08-13. It is not in `docs/`, not anywhere in the tree, and no other
> document or `BUG-HISTORY.md` entry records that exposure; searching for the
> key, "downloadable", "file server" and every `autocount-*` doc turns up only
> `docs/autocount-migration-record.md:621` ("an orphaned listener registration
> from the cutover file server").
>
> **The missing COE is itself the finding.** This section is titled "why this is
> the second time" and its whole argument rests on a document nobody wrote — so
> the first incident is remembered only as a sentence inside the second one's
> write-up, which is exactly the failure both incidents are about.

This is the same class on the same machine: *something stood up for internal
convenience, published to the internet, and remembered by nobody.*

**The pattern to take from both: a host that fronts anything publicly needs its
whole surface enumerated, not just the part being worked on.** Both were found
by probing rather than by reading, because no document listed what that machine
serves. `docs/autocount-integration-map.md` section 2 now enumerates all four
channels for exactly this reason.

## What must happen — owner decision

| Option | Effect |
|---|---|
| **Take `it-houzs.dev` down** | Cleanest. Nothing in the ERP depends on it — the write path is a different hostname and the fidelity snapshots come from direct SQL |
| **Put the same `X-API-KEY` gate in front of every route** | Keeps it usable, matches what the write service already does |
| **Leave it** | Not acceptable while two routes serve customer and supplier data unauthenticated |

Until one of the first two is done, **treat the purchase history and the debtor
master as publicly readable** and do not add anything else to that relay.

## What this rules out

- **It is not the write path.** `autocount.houzscentury.com` is a different
  hostname fronting `AcSyncService`, whose every route requires `X-API-KEY` and
  which refuses everything with 503 if the key file is missing (fail-closed,
  `#2025`).

  > **Corrected 2026-08-13: `/health` is NOT open, and this document said it
  > was.** The original text read *"`/health` there is deliberately open and
  > returns only `{"ok":true,"book":"AED_HOUZS","service":"AcSyncService"}`."*
  > Read the source: `backend/scripts/autocount-service/AcSyncService.cs:160-168`
  > runs the empty-key 503 and the `X-API-KEY` comparison **before** the
  > `/health` dispatch, with its own comment — *"AFTER the key, deliberately:
  > which account book this is connected to is not something to hand an
  > anonymous caller on a public hostname."* That gating landed in `54769163`,
  > **the same PR #2025 this bullet cites for the fail-closed 503**, on
  > 2026-08-11 — the day before this COE was written. The service has no
  > unauthenticated surface at all, which strengthens the bullet's conclusion
  > and refutes its stated fact.
- **It is not new.** No recent change opened it; it has been up since before the
  cutover.
- **It is not a Cloudflare misconfiguration.** The relay itself answers — the
  401 on the third route is the relay's own middleware, not the edge.

## Lessons

1. **Per-route auth is a list, and lists go stale.** A gate applied route by
   route will always have the route somebody added later. Default-deny at the
   edge, then open what must be open.
2. **An answer you give the owner is a claim, and claims get checked.** "There
   is an older read relay" was a throwaway sentence; probing it is what found
   this. Check the sentence before you say it, and the finding comes with the
   answer instead of a week later.
3. **Enumerate the whole surface of any host you publish.** Both exposures on
   this machine were invisible because no document said what it serves.

---

## What breaks if you close them — measured 2026-08-18

**Nothing in the ERP.** This section exists because the remediation has been
sitting OPEN, and the reason it sits open is that nobody could say what closing
the hole would cost. The answer is: on the ERP side, nothing at all.

Everything the ERP sends to `it-houzs.dev` goes through ONE client,
`AutoCountClient` in `backend/src/services/autocount.ts`, and every call it makes
carries the key:

```
$ grep -c "await fetch(" backend/src/services/autocount.ts     -> 15
$ grep -c "headers(this.env" backend/src/services/autocount.ts -> 15
```

`headers()` sets `X-API-KEY: env.AUTOCOUNT_API_KEY` on all fifteen. There is no
keyless path in the client and no second client — the whole surface is these
fifteen endpoints:

| | |
|---|---|
| SalesOrder | `getAll` `getSince` `getSingle` `getDetail` `getOverdue` `updateFromSheet` |
| PurchaseOrder | `getAll` `getOutstanding` `getDetail` `update` |
| DeliveryOrder | `getAll` `getSince` |
| Creditor | `getAll` `getSingle` |
| StockItem | `getSingle` |

Now put the two exposed endpoints against that list:

| exposed endpoint | does the ERP call it | what requiring a key costs |
|---|---|---|
| `/Debtor/getAll` (200, ~65 KB, the customer master) | **NO — it appears nowhere in the client.** The ERP reads `Creditor`, never `Debtor` | **nothing** |
| `/PurchaseOrder/getAll` (200, ~52 MB, the purchase history) | yes | **nothing** — the call already sends `X-API-KEY` |

**So the fix is safe to apply to both.** One of them the ERP does not use, and
the other it already authenticates. What would break is any OTHER consumer that
has been relying on the keyless path, and this repository is not one — a
consumer nobody can name is not a reason to leave the customer list on the
public internet.

### Two things that are true at the same time and must not be confused

- **The relay is LIVE.** `AUTOCOUNT_SYNC_DISABLED = "false"` in production
  (`backend/wrangler.toml:24`; the staging block at `:302` says `"true"`), so the
  inbound pull is running. Closing the AUTH hole is not the same as switching the
  relay off, and this section is only about the first.
- **The relay's WRITE half is already dead** — `AUTOCOUNT_WRITES_DISABLED = true`,
  a hard-coded constant in `services/autocount.ts`, so `updateFromSheet` and
  `PurchaseOrder/update` send nothing regardless.

### Still the owner's, and still not done

The change is on the relay host / Cloudflare, which this repository cannot reach.
What is removed by this section is the excuse: the blast radius was the open
question, and it has been measured.
