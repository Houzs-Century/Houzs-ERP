## A retired whitespace twin trimmed onto its live sibling and switched a selling fabric off [high]

**Symptom.** GARFIELD — a fabric customers buy — vanished from the fabric picker
entirely. Nine active colours, gone. It reached production and was measured gone
**within minutes of the deploy**, by the verification run for the change that
caused it.

**Root cause (mine, and it is the inverse of the bug it was fixing).**
docs/bugs/0816 taught `GET /fabric-colours` to hide a colour whose SERIES is
switched off, and built the retired set from the INACTIVE library rows alone,
trimming each id:

```
retiredSeriesSet = rows.map(r => String(r.id).trim())     // WRONG
```

`fabric_library` holds BOTH `GARFIELD` (active) and `GARFIELD ` (retired, the
superseded twin from a 2026-08-11 merge). Trimming the retired row yields
`GARFIELD` — so the retired twin **switched off its own live sibling**.

The trim is not the mistake; without it the padded twin never resolves, which is
why 0816 added it. The mistake is that the question was asked PER ROW when it is
a question about a CODE: is there any ACTIVE row for this code?

**It had a test asserting the wrong thing.** 0816's suite contained

```ts
expect(seriesIsRetired(retiredSeriesSet([{ id: 'GARFIELD ' }]), 'GARFIELD')).toBe(true);
```

written as though that were the desired behaviour. A test can pin a defect as
firmly as it pins a fix, and a green suite is not evidence that the rule is
right — only that the code does what the author believed. That assertion is now
inverted and sits FIRST in the file, as the named regression case.

**Fix.** `retiredSeriesSet` takes every row plus its `active` flag and retires a
trimmed code only when NO active row trims to it. A live row wins over a retired
twin; a code whose every row is inactive is still retired, padded or not; and
anything other than `active === true` reads as inactive, so a missing flag cannot
silently un-retire a discontinued fabric. 13 cases pinned.

**What the near-miss actually cost, and what caught it.** Nothing a user
reported — the owner would have hit it the next time somebody sold GARFIELD. It
was caught because the change was followed by an independent re-measurement of
the live data rather than by trusting the deploy went green:

```
GARFIELD colours now on the clean row and on offer: 0   <- the finding
selectable on model 5527: 812 of 812 on-offer colours   <- the intended result
```

Both lines came from the same script. Had it printed only the second, this would
have shipped as a success.

**Ref.** `fix/retired-twin-poisons-live-series`, 2026-09-11. Regression from
docs/bugs/0816-a-discontinued-fabric-kept-offering-every-shade-because-noth.md,
shipped and corrected the same hour.
