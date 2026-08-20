## The refusal that already knew the answer printed a sentence with none of it in — and half the bedframes it refused were a curly quote [high]

<!-- area: Sales orders + pricing -->

**Symptom.** A salesperson could not add a BEDFRAME line to an existing Sales
Order. The whole of what he was shown:

```
Save failed. Could not save <SKU>: Some of the details weren't accepted.
Please check what you entered and try again. Your 1 new line is still on
screen and not saved yet.
```

Nothing in that names a field, a value, or anything to change.

**The server had already sent the answer.** `checkAllowedOptions` refuses with
`{ error: 'variant_not_allowed', field, value, allowed }`
(`backend/src/scm/lib/allowed-options-check.ts:81-86`) — ten return sites, nine
distinct field names — and the add-line route forwards it verbatim at
`mfg-sales-orders.ts:7732`. The client threw all three keys away: the code is in
no curated map, and the body carries neither `reason` nor `message`, so
`humanApiError` fell to its 400 catch-all
(`frontend/src/vendor/scm/lib/authed-fetch.ts`). Grepping `variant_not_allowed`
across `frontend/src` returned ONE hit and it was a comment. This was never a
"go find out what is wrong" bug; it was a "stop discarding what we were already
told" bug.

**Root cause of the refusal itself — measured on prod, not inferred.** Probe run
`32048732641` (read-only, `probe-supplier-costing-state`) says 10 of 123 BEDFRAME
Models restrict `total_heights`, all active, and all ten share ONE 16-value pool
whose inch mark is typed two ways: the even values 10..28 use ASCII `U+0022`,
while 17/19/23/27 use `U+201C` and 21/25 use `U+201D`. The `gaps` pool on the
same Models splits the same way (7 ASCII, 10 curly). The line editor can only
ever emit ASCII — `SoLineCard.tsx:436` is the template literal `` `${d + l + g}"` ``
— and the gate compared with a raw `Array.includes`, i.e. `===` on strings. So
**every odd total was refused by a pool that visibly lists that number.**
Counting only the gaps the picker can actually offer, 94 of 280 divan x leg x gap
combinations refused ON THE QUOTE CHARACTER ALONE. `mfg-pricing.ts:165-192`
recorded this same prod measurement and added a fold for pricing; the
allowed-options gate never got one. One rule, two places that needed it, fixed
in one.

**Why a naive message would still have failed.** `total_height` is not typed by
anyone. It is divan + leg + gap, computed at `SoLineCard.tsx:430-437` and written
into the draft at `:439-445`, and the form has NO Total Height input — `:950-960`
renders it as read-only text. So "Total Height 17\" is not allowed. Allowed:
17“, 19“" names a field the salesperson cannot edit AND prints look-alike glyphs
beside the value he already has. `size_code` and `compartment` have the same
shape: both are decided by which SKU was picked
(`allowed-options-check.ts:122-137` reads `product.size_code`; `:170-171` slices
the compartment out of the code), so "pick a different value" points at a control
that does not exist.

**The fix, both halves.**

1. `inPool` in `allowed-options-check.ts` — EXACT FIRST, then quote-insensitive,
   reusing the pricing engine's exported `normaliseTypographicQuotes` rather than
   growing a second definition. The ordering is the safety argument: nothing that
   matches today can change meaning, and only a value that matches nothing today —
   and therefore already 400s — can start matching. Every membership test in the
   file now goes through it, so the file cannot drift against itself. WHICH values
   a Model permits is untouched.
2. `describeRefusal` (`frontend/src/vendor/scm/lib/refusal-detail.ts`), called
   from `humanApiError`. It renders any refusal that names the input, the value
   AND the pool, keying off the body's SHAPE and not a list of codes — so the next
   structured refusal renders without anyone remembering. Labels are the words
   already on the form (Divan Height, Leg Height, Gap, Size, Compartment, Fabric,
   Seat Height); an unmapped field name is DROPPED rather than printed, because a
   raw field name here is a column name. The pool is printed quote-folded and
   de-duplicated so one number never appears twice in two spellings. Anything it
   cannot say honestly returns null and the generic sentence stands.

The bedframe line now reads:

> Total Height works out to 30" (Divan Height 16" + Leg Height 4" + Gap 10"),
> which this model doesn't offer. There is no Total Height box on the line —
> change Divan Height, Leg Height or Gap so they add up to one of 10", 12", 14",
> 16", 17", 18", 19", 20", 21", 22", 23", 24", 25", 26", 27" or 28".

**Why the message had to be composed on the error path.** `err.body` does not
survive a line write. `so-add-lines.ts:115-116` keeps only `e.message`, and
`:186/:190` throw a bare `Error`, so by the time `SalesOrderDetail.tsx:1022/:1028`
look for `.body` it is `undefined`. (The same hole leaves the `problems` modal
and the version-conflict recovery banner DEAD for every add / update / delete —
recorded here, not fixed here.) A renderer at the page level could not have
worked; `humanApiError` is the only place the detail rides through.

**The additive key.** `AllowedCheckError.derivedFrom` — the inputs behind a
COMPUTED field, present only on `total_height`, always all three (value `''` when
unsent). Without it the client cannot decompose the sum and the only honest
message names a box that does not exist. No existing key changes meaning.

**Two comments corrected, because a comment that lies cost this repo a day
already.** `SoLineCard.tsx` and `mfg-products.ts` both claimed that filtering the
editor's pickers to `allowed_options` stops lines "failing on save with
variant_not_allowed". Filtering a picker can only help a field that HAS a picker;
`total_height`, `size_code` and `compartment` have none.

**Pinned.** `allowed-options-check.ts` had NO test file and
`grep variant_not_allowed` over every `*.test.ts` in the repo returned zero, so
nothing would have gone red. Both new suites were watched FAIL first (backend
4/12 failed on the prod pool fixture; frontend 11/17 failed asserting the message)
and re-failed on a negative control with the fix deleted.

**Deliberately not done.** `restrictP`/`restrictS` (`SoLineCard.tsx:539-542`) still
compare raw, so pool values spelled curly are silently missing from the dropdowns —
widening those CHANGES WHICH OPTIONS APPEAR, which is the owner's call. And nobody
has measured how many EXISTING SO lines already hold an out-of-pool variant; the
PATCH gate at `mfg-sales-orders.ts:8396-8406` re-validates the whole merged blob,
so such a line refuses an edit to an UNRELATED field.
