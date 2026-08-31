## The second photo upload in a batch was refused as somebody else's edit [high]

**Symptom.** Owner, 2026-08-31: 「但我 edit 了之后，我 upload 的一些照片好像都会出现
这样子的问题」 — uploading several photos to a sales order, the first went in and
the next answered *"Someone else updated this order while you were editing"*.
Nobody else was in the order.

**Root cause (traced).** Every standalone line write — a photo upload, a photo
delete, a price override — runs through `runSoVersionedMutation`, which RESERVES
the order first by PATCHing the header with the version it believes is current.
That reservation is itself a header write, so the compare-and-swap **bumps the
version**: the order is at 8 the moment the first upload starts, while every
screen still says 7.

Afterwards the coordinator calls `invalidateQueries` on the detail cache — and
invalidation MARKS the entry, it does not remove it. `getQueryData` keeps
returning the old object until a refetch lands, so the second upload read 7 back
out and reserved against a version the server had already left behind. The
server refused it, correctly, with the message it shows for a genuine concurrent
edit.

Reproduced before the fix, in `so-versioned-mutation.test.ts`, with one query
client and no second user:

```
× a second line mutation reserves from the version the first one advanced to
    AssertionError: expected { version: 7 } to match object { version: 8 }
```

**Fix.** The coordinator records the version the SERVER just told it about, on
the QueryClient under its own key (`mfg-sales-order-known-version`), and reserves
from the larger of that and the detail cache. Not a competing source of truth: a
version only ever increases and the value only ever comes from a server response
for that order, so a refetch returning a higher number wins immediately — and a
version another *person* has advanced past is still refused, which is the whole
point of the check. It lives on the client rather than in a module variable so
it cannot leak between tabs or tests.

Recorded BEFORE the action runs, not after: an upload that fails still leaves the
server advanced, and the retry must reserve from the new number.

**Ref.** fix/so-line-mutation-stale-version, 2026-08-31.
