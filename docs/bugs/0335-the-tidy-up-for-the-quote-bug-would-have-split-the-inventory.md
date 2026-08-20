## The tidy-up for the quote bug would have split the inventory buckets [medium]

**Symptom.** None — caught before it ran, which is the only reason it is a
paragraph and not an incident.

**Root cause.** #2358 shipped `normalise-maintenance-quotes.mjs` with a working
APPLY path, on my reasoning that straightening `17“` to `17"` in the maintenance
pools was cosmetic: the PRICING consequence was already closed in code (the
lookup matches exactly first, then quote-insensitively, so either spelling finds
the right tier).

That missed what those values ALSO are. `gaps` and `totalHeights` are
components of `variant_key` — the inventory bucket identity:

    fabriccode=bf-18|gap=12“|divanheight=8"|legheight=2"|totalheight=22"

Rewriting the POOL touches no stored document, which is exactly why it looks
safe. It changes what the PICKER offers from then on: new documents would get
`gap=12"` while existing stock sits in `gap=12“`. Measured on prod 2026-08-18
before anything was written: **12 inventory lots (11 units), 12 balances, 15
movements and 21 document lines** carry a typographic mark in their key. One
physical spec would have split into two buckets, and MRP would report a
shortage against stock on the shelf — the same defect class the 2026-08-17
investigation was about, recreated by its own tidy-up.

**Fix.** The script is REPORT-ONLY: the INSERT path is gone (0 write statements
remain), and `APPLY=true` exits 2 naming the reason. The header carries the
measurement and the ordering a real unification would need — migrate
`variant_key` across the five tables WITH a bucket-merge reconciliation first,
pools second, never the reverse.

**Owner decision 2026-08-18:** leave the pools mixed. The spelling costs nothing
now that the lookup handles both, and a tidier Maintenance screen does not buy a
rewrite of inventory identity.

**What the script is still for.** Conflicting duplicates — one tier spelled two
ways at two prices, where the answer depends on array order. That detection
found the two zero-priced curly duplicates under HOOKKA MANUFACTURING (`19"`
and `25"`, both shadowing a straight entry at RM40 and both sitting EARLIER in
the array, so a curly-typed document priced at 0). Owner ruled both are RM40;
the spurious entries were removed by hand as new config versions
(`mch-9a8c9a8e42b3`, `mch-7d096cc126d8`) with zero documents affected. The
report exits non-zero while any conflict remains.

**The lesson worth keeping.** "It only changes a label" is a claim about the
whole system, not about the column. The check is not "does this rewrite a
document" but "is this string an IDENTITY anywhere" — and here it was, two
joins away.

**Ref.** PR (branch `chore/quote-normalise-report-only`), 2026-08-18.
