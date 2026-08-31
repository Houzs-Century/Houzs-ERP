## Picking up a default venue wiped the venue the order already had [high]

**Symptom.** Owner, 2026-09-01: 「为什么我的 Venue 又不见了？」 — two 2990 sales
orders showing "—" in the Venue column where a venue had been. **"又"** is the
word that matters: this has come back before.

**Root cause (traced, and the audit log settled it).** Not a missing default — a
DESTROYED value. On 2990-SO-2608-070:

```
2026-08-31 07:50:31  UPDATE_DETAILS  venue:   "2990s PJ" -> ""
2026-08-31 07:50:31  UPDATE_DETAILS  venueId: null       -> "5cafa0a2-…"
```

One save wrote both. The Sales Order form's default-venue effect
(`SalesOrderDetail.tsx`) reads:

```ts
if (form.venueId) return;                 // one-shot: only when the form has no id
const resolvedId = picked?.venueId ?? '';
if (!resolvedId) return;                  // guarded
const resolvedName = (venuesQ.data ?? []).find(v => v.id === resolvedId)?.name ?? '';
setForm(s => ({ ...s, venueId: resolvedId, venue: resolvedName }));   // NOT guarded
```

The id has a guard; **the name has none**. When the venue master has not arrived
yet, `?? ''` writes an EMPTY venue over the one the order was loaded with — and
the effect cannot repair itself, because `if (form.venueId) return` above now
bails. **The guard that prevents an infinite loop is what makes the damage
permanent.**

Every MIRRORED 2990 order starts in exactly the state that triggers it: the
mirror forces `venue_id: null` (`so-mirror.ts`) and keeps the venue TEXT. So each
one loses its venue the first time somebody opens and saves it — which is why it
keeps coming back.

**Fix, in three parts.**

1. **The client waits instead of blanking** — `if (!resolvedName) return;`.
   Waiting costs nothing: `venuesQ.data` is already in the dependency list, so the
   effect runs again the moment the master lands, and `form.venueId` is still
   empty until then. Same guard added to `ConsignmentOrderDetail`, which carries
   the same effect.
2. **The server refuses to take a half-written pair literally.** An empty `venue`
   arriving beside a non-empty `venueId` is a client that resolved the id and not
   the name, so the header PATCH resolves the name from `scm.venues` — which is
   exactly what the CREATE path already does in that situation. No caller —
   desktop, mobile or API — can leave the pair half-written now. Clearing is still
   possible: send BOTH empty, which is what "this order has no venue" looks like.
3. **`repair-blanked-venue.mjs`** puts the name back on the rows already blanked,
   from the venue id those same saves wrote. It writes the NAME only, never
   `venue_source`, and it refuses a row with no venue id — that is the create
   path's deliberate NULL, and a guessed venue is a wrong exhibition P&L figure
   paid to a real person.

**Tests.** Two in `mfgSalesOrderHeaderCas.test.ts`, the first RED against the
unfixed tree (`expected '' to be 'PJ SHOWROOM'`): an empty venue beside a venue id
is resolved from the master; BOTH empty still clears it.

**The class, again.** This is the third time today one shape has bitten: a client
sends an empty value, and the server takes it as a deliberate clear.
`docs/bugs/0578-*` was the date pair (`null` read as "absent"), `0584-*` was the
payment row dropped in silence, and this is the venue. The common defence is the
one applied here: when a field arrives EMPTY beside the thing that can derive it,
derive it.

**Ref.** fix/venue-not-blanked, 2026-09-01.
