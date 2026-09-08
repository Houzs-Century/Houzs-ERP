## The reconcile could not see a ruling addressed by the account book's line key [medium]

**Symptom.** `HC-SO-012827` kept reporting as **"sofa build not verifiable — your
drawing decides this"** on the sales-order tally *after* the owner's answer for it had
already been written to production and verified. Measured on tally run **`34236971666`**,
with apply run **`34236161221`** having written and re-read both of that document's builds
on a fresh connection minutes earlier. This is the report handing him back work he has
already done — the same class as `docs/bugs/0720`, which had just been fixed for
text-addressed rulings.

**Root cause (traced).** `scripts/lib/sofa-rulings.mjs`, in the lookup returned by
`makeSofaRulingLookup`, chose a ruling **only** by `desc2Match`:

```js
const hit = cands.find((c) => c.desc2Match && desc2Contains(text, c.desc2Match));
const only = cands.length === 1 && !cands[0].desc2Match ? cands[0] : null;
```

The same round added a second way to address a build — `lineKeys`, the account book's own
`DtlKey` — because `HC-SO-012827`'s two sofas have Desc2 the book wrote so that one is a
**substring** of the other, and no needle reaches the shorter line alone. The applier
learned that address; **this lookup did not**, so a line-key ruling was invisible to it and
its line went on reading unverifiable for ever.

The `only` branch carried a second, sharper fault in the same expression. A `lineKeys`
entry has no `desc2Match`, so on a document holding exactly one ruling it satisfied
`!cands[0].desc2Match` and was returned **for any line of that document** — including lines
whose key it does not name. That is blessing the wrong furniture, which is the failure the
whole lane exists to prevent. It was latent only because `HC-SO-012827` happens to carry
three candidate entries.

**Fix.** The lookup now consults `lineKeys` **first** — identity beats resemblance —
matching them against the ERP lines' `ac_dtlkey`, which `lib/ac-reconcile-erp-sql.mjs`
already selects. A ruling is returned only when **every** key it names is present on the
line group in hand, so it can never reach a line it did not name. And `only` now requires
an entry with **no address of any kind**: needle-less is not the same as unaddressed.

Four tests in `scripts/lib/sofa-rulings.test.mjs`, **proved RED on the unfixed tree** —
three of the four failed, and two of those three were the "must not bless the wrong line"
pair, so the safety hole was demonstrated before it was closed. `node --test
scripts/lib/*.test.mjs` is 203 pass / 0 fail after.

**Ref.** `fix/sofa-owner-rulings-16`, 2026-09-08.
