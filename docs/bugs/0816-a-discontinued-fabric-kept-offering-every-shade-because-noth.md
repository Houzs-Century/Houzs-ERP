## A discontinued fabric kept offering every shade, because nothing on the selling path read the series flag [high]

**Symptom.** None reported — this was found by answering the owner's question.
After docs/bugs/0814 opened the fabric picker up from 3 of 851 colours to 820,
he asked about the remainder: 「没开的应该是因为inactive了？就是discon了？」 and
then ruled 「inactive的就不需要了」.

He was right about the 31, and the check exposed the real defect behind them:

**Root cause (PROVEN, live read 2026-09-11).** `GET /fabric-colours` filters on
`fabric_colours.active` — the COLOUR's own flag — and nothing on the selling path
read `fabric_library.active`, the SERIES' flag. So a fabric switched off in the
library went on offering every one of its shades.

MEASURED, company 1: **32** active colours belong to a discontinued series —
`FG66151` (17), `J9226` (14), `GARFIELD ` (1). Company 2: none.

They were invisible in the picker only because no sofa Model happened to list
those series in its `allowed_options.fabrics`. That is LUCK, not a rule: ticking
a new Model, or clearing a pool to "open everything", would have leaked all 32
straight back in. The owner asked for exactly that clearing earlier the same day,
which is how close this came to shipping.

**Fix.** `GET /fabric-colours` loads the retired series
(`fabric_library.active = false`) and drops any colour whose series is in it.

- A SEPARATE small query, not a PostgREST `!inner` embed. The embed would be
  fewer round trips, but its shape cannot be verified from a developer machine
  (PostgREST needs the Worker's credentials) and getting it wrong EMPTIES the
  fabric picker — worse than the defect. One extra read on a debounced,
  50-capped typeahead is the cheaper risk.
- An unreadable library **degrades to the old behaviour** (every active colour),
  never to an empty picker: the colour list is the product, the series filter is
  a refinement.
- The trim lives in a BUILDER (`retiredSeriesSet`), not in the caller, so neither
  side of the comparison can be forgotten. An earlier draft trimmed only the
  value and left the Set to the caller — the "discipline the caller must
  remember" shape this repo keeps paying for. 9 cases pinned in
  `fabricColoursRetiredSeries.test.ts`.
- A SAVED line is unaffected: the picker renders its stored colour verbatim and
  never blanks a selection, and the allowed-options gate reads the Model's pool,
  not this flag. **26** live sales-order lines already carry a discontinued
  series and keep displaying it.

**And the repair this fix MADE NECESSARY.** Filtering on the series flag would
have hidden `GARFIELD-03` — a live shade of the live fabric `GARFIELD` — because
it sits on a DIFFERENT library row: `GARFIELD ` with a trailing space, whose own
label reads

> `GARFIELD  [MERGED into GARFIELD on 2026-08-11 - superseded, not deleted]`

Somebody merged that series on 2026-08-11, marked the old row superseded, and
left its one colour pointing at the dead row. Exactly two padded ids exist in the
library and both have a clean twin — `GARFIELD ` (retired, 1 colour) and
`TARONI ` (active, 2 colours, beside `TARONI`'s 13). So three colours sit on the
wrong row. `scripts/repair-fabric-colour-padded-series.mjs` moves them and
refuses any whose target already exists (a real duplicate is a catalogue
decision, not a repair's). Plan against production:

```
Colours on a padded series id that has a clean twin: 3
   company 1  GARFIELD-03: "GARFIELD " -> "GARFIELD"  (the padded row is RETIRED)
   company 1  TARONI - CREAM: "TARONI " -> "TARONI"  (the padded row is active)
   company 1  TARONI - NAVY BLUE: "TARONI " -> "TARONI"  (the padded row is active)
```

**The lesson worth keeping.** A flag that exists and nothing reads is worse than
no flag: everybody assumes it works. `fabric_library.active` had been the
"discontinued" switch for months while the only thing actually hiding those
fabrics was 79 unrelated per-Model lists. **When a fix removes an accidental
guard, look for what the guard was accidentally doing** — here, keeping one
mis-pointed colour alive.

**Ref.** `fix/discontinued-fabric-not-offered`, 2026-09-11. Follows
docs/bugs/0814-one-option-field-two-vocabularies-the-fabric-pool-held-serie.md.
