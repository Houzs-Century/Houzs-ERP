## The side-drawer fix stopped at the parser: the phrase map still filed an unstated side as Front [high]

**Symptom.** None visible yet — this was caught by a tool's own self-test on
2026-09-12, hours after `docs/bugs/0824` was fixed and merged, and BEFORE it
could write anything. That is the only reason it is a near miss and not a second
round of wrong delivery orders.

**What 0824 fixed, and what it did not.** `scripts/lib/parse-bedframe.mjs` was
corrected the same morning so that `Sidedrawer`, `2SIDE DRAWER`, `drawer at the
side` stop falling through to `Front Drawer` and instead emit the marked phrase
**`Side Drawer (side unknown)`**, so a human can answer it. That half works.

The decoder has a SECOND stage. `scripts/lib/special-order-phrase-mapper.mjs`
takes the parser's phrase and maps it to a live catalogue code, using
`data/special-order-phrase-map.json`. The `Front Drawer` family there read:

```json
"yes": "\\bfront drawer\\b|\\bdrawer (at )?front\\b|\\bdrawer\\b|\\bpull ?out\\b|\\bput out\\b",
"no":  "\\bleft drawer\\b|\\bright drawer\\b|\\bdrawer (at )?(left|right)\\b"
```

The `yes` carries a bare `\bdrawer\b`, and the `no` vetoes only a LEFT or RIGHT.
The parser's new marker phrase contains the word "drawer" and names neither
hand — so **`Side Drawer (side unknown)` matched the Front family and came back
out as `Front Drawer`**, which is precisely the value 0824 exists to stop
writing. Reproduced directly on the real production wording:

```
TEXT : sidedrawer/PC151-01/divan10/gap12
  phrases : ["Side Drawer (side unknown)"]
  GAINED  : ["Front Drawer"]          <- the defect
```

The left and right families had the mirror-image half of the same gap: their
patterns were space-bound (`\bleft drawer\b`), so they could not read the
spellings the book actually uses — `Leftside Drawer`, `add on right side
drawer`, `Add left hand side drawer`.

**Why it was not caught by 0824's tests.** Those tests are on the PARSER
(`tests/bedframeDrawerSide.test.mjs`) and they pass: the parser really does emit
the marked phrase. Nothing tested what the MAP then does with it. Two stages,
one fixed, one not — the same shape as `docs/bugs/0818`, where correcting
`item_code` was mistaken for correcting the document.

**Blast radius.** `mapPhrase` is shared by
`backfill-specials-into-variants.mjs` (already applied to production: run
33517835461, 442 lines stamped), `record-priced-specials-on-migrated-lines.mjs`,
`audit-special-addon-prices.mjs` and `plan-priced-specials-money.mjs`. The Front
Drawers those runs stamped on side-drawer lines are part of the 41 lines 0824
measured; they are repaired by the data round, not here.

**Fix.** The `Front Drawer` family gains a SIDE veto
(`\bside ?drawer\b|\bdrawer (at )?(the )?side\b|\bside unknown\b|…`) so an
unstated hand decodes to **no drawer code at all** and is reported as UNMAPPED,
which is what sends it to the photo, the supplier export or the salesperson. The
left and right families gain the no-space and after-the-word spellings. Every
wording pinned in `backend/scripts/lib/special-order-phrase-mapper.test.mjs` is
transcribed from a real production line, in both directions: a genuine front
drawer, an unqualified drawer and a pull-out must STILL decode as Front.

**The lesson worth keeping.** A decode pipeline is only as fixed as its last
stage. When a parser is corrected, grep for who consumes its output before
calling the class closed — and give the consuming tool a self-test that asserts
the NEGATIVE case, because a wrong value looks exactly like a right one to a
test that only checks the positives.

**Ref.** fix/supplier-specials, 2026-09-12. Related: `docs/bugs/0824` (the
parser half), `docs/bugs/0818` (one correction, two stages).
