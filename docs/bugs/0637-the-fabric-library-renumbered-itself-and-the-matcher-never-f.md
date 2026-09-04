## The fabric library renumbered itself and the matcher never followed - a colour the book plainly names was left blank [high]

**Symptom.** The owner, 2026-09-04, holding four migrated lines up against the
Fabrics library: 「同类问题也解决」. In each one the AutoCount book and the ERP's
own library name the same cloth, and the ERP line is empty.

```
book: COL: PC151-01     library: PC151-01        identical - a bad extraction, not a bad code
book: Col:PC-151-01     library: PC151-01        one extra dash
book: CH141-8 army      library: CH141-08 ARMY   one missing zero
book: BO315-21 pearl    library: BO315-21 PEARL  case only
```

**Root cause (traced).** Three separate mechanisms, measured against production
on 2026-09-04 with the read-only `claude_ro` DSN over 4,305 migrated sofa and
bedframe lines of company 1, of which 2,009 carry no colour.

1. **The library renumbered itself and nothing told the matcher.** On 2026-08-11
   every 1-digit tail was rewritten to two digits and each predecessor was KEPT
   as an `active = false` row that says so in its own label - `CH141-8
   [superseded by CH141-08 on 2026-08-11]`. `SELECT ... FROM scm.fabric_colours
   WHERE company_id = 1` returns 949 rows, **849 active and 100 superseded**.
   The documents were never rewritten, so the book still says `CH141-8 army`
   while the live row is `CH141-08 ARMY`, and `fabric-colour-match.mjs` had no
   spelling that crosses that gap. Where it did resolve, it resolved to the
   DEAD row - `findColour('CH141-8')` returned the superseded one, a colour the
   Fabrics picker no longer offers.

2. **The colour never reached the matcher at all** - the owner's own note on his
   first example, "a bad extraction". Two decoders drop it:
   - `parse-sofa.mjs` reads an unlabelled colour only when the caller passes
     `opts.knownColour`, and **`refresh-sofa-colours.mjs:115` - the script whose
     entire job is to stamp colours - did not pass it**, nor did
     `probe-sofa-colour-misses.mjs:54` or `probe-write-persistence.mjs:132`.
     That is BUG CLASS optional-param-noop
     (`docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`)
     recurring: the argument that decides the answer was optional, so the three
     callers that forgot it silently kept the old behaviour. Its pre-filter also
     demanded a letter IMMEDIATELY before a digit, which excludes every series
     whose name is a word numbered with a dash - MODENZA-05, CHINO-06,
     GARFIELD-01, GUARDIAN-05.
   - `parse-bedframe.mjs` required a word boundary after the number and allowed
     no separator inside the series, so `PC151-02Divan8+4` and `PC:151-01`
     were walked past.

3. **The exact index was FIRST-WINS, so an ambiguous key was answered anyway.**
   `if (!exact.has(k)) exact.set(k, r)`. `CREAM` is the whole label of BOTH
   `CASSNYE-04` and `TARONI-01`, both live, and the bedframe decoder reads a
   bare `Cream/Divan10/Gap13` as a colour - so `findColour('CREAM')` answered
   CASSNYE-04 with a coin toss's confidence and nothing said so. That is the
   opposite failure to the other two and the more expensive one: a wrongly bound
   line is upholstered in the wrong cloth, while a blank one is fixed by a human.

**Fix.** A zero-padded index beside the exact one, both built by a shared
`claimIndex` that REFUSES any key two different rows claim - with one exception
the library states about itself, that an `active` row and its own `active =
false` predecessor are one identity, not two. Absence of the `active` field is
the STRICTER direction: a caller that does not select it gets the refusal.
`live()` follows a superseded answer to its replacement. `colourForms` gains a
padded spelling last, behind the same 3-character floor pass 1 uses. The three
callers now pass `knownColour`; the sofa pre-filter accepts a dash between the
letters and the number; the bedframe bare-code rules accept a colon inside the
series and no longer need a word boundary after the number. `isPendingColour` is
BYTE-IDENTICAL - the new `pendingColourKind(text, find)` only NAMES the 16 lines
that write a real code beside a TBC marker, and fills nothing.

Pinned by `backend/tests/fabricColourMatch.test.ts` (+12 tests, including the
real `CREAM` collision and the "no `active` field means refuse" direction) and
`backend/tests/fabricColourExtraction.test.ts` (8 tests). **Proved RED on the
unfixed tree**: with `origin/main`'s three modules checked back in, 13 of the 48
fail; with the fix, 48 pass.

Measured before / after with `backend/scripts/probe-fabric-colour-classes.mjs`
against production, same query, one variable changed - the matcher answers
**108 -> 169** of those 2,009 lines and refuses 109 -> 93. Nothing was written:
the probe has no APPLY path and the backfill is the owner's to run.

**Ref.** fix/fabric-colour-normalisation-classes, 2026-09-04.
