## The fabric rename split the code away from its price tier, and cut six colour numbers in half [high]

**Symptom** - none visible, twice over. Staff saw the Fabric Converter still
showing `AM275-2-BEIGE` with an empty Series column after the library had been
tidied; the owner asked "两边一定要一样的啊". Nothing on screen said that 492
document lines had stopped resolving to a price tier, or that six colours were
now called things like `NOVENA-100` with a colour name of "3".

**Root cause (traced, not guessed)** - three faults, one shape: a rule written
twice, and a table edited on the wrong side.

1. `scm.fabric_trackings.fabric_code` and `scm.fabric_colours.colour_id` are THE
   SAME STRING by construction - `fabric-tracking.ts:74-82` mints a tracking row
   and mirrors it into the library. The Converter is the master. The 2026-08-11
   normalisation edited the library and repointed 494 live `variants.fabricCode`
   values onto the new strings, leaving the master untouched. That column is the
   join key for the price tier (`mfg-sales-orders`, `mfg-purchase-orders`,
   `consignment-orders`, `po-pricing`, `mfg-pricing-recompute`), and a miss does
   not error - `mfg-sales-orders` says so in its own comment: every fabric falls
   to the PRICE_2 default and "a failed read would pick a REAL combo at the WRONG
   tier and write that cost to the header as fact". Measured on production: 492
   orphaned lines across 76 codes (run 31478813584).
2. The colour number was read as `\d{1,3}`. `NOVENA-1003` therefore parsed as
   colour 100 with a NAME of "3", and run 31470428224 wrote `NOVENA-100` labelled
   `NOVENA-100 3` - plus LAMB VELVET-2005, GORGE-3003, POLAR-5002, MERINO-4005
   and MERINO-4010.
3. `align-fabric-trackings` then kept its OWN copy of the series rule, still at
   `\d{1,3}`, so after (2) was fixed its plan still called `NOVENA-1003`'s series
   `NOVENA-1`. The same duplication also made it match tracking codes by
   flattening the LABEL, which can never match a brand prefix - all 303 of
   `ARMANI ...`, `AGAZZI ...`, `HIVE ...` were reported as "the library does not
   know this code" when the library knew every one.

**Fix** - #2018 widens the number to four digits and refuses a "name" made only
of digits, because that is always a number the split cut off;
`repair-split-colour-numbers.mjs` restored the six written rows by fingerprint
(label = code + digits only), 0 live lines were on them. #2032 moves the whole
rule into `lib/fabric-code.mjs` so no script keeps a copy - two copies caused two
of the three faults. #2033 casts the tier columns (`scm.fabric_price_tier` is an
enum; a bound string is text, and the first apply died on it and rolled back) and
matches through the shared parser, so a brand prefix resolves in one step. #2009
then aligned the master: 386 codes rewritten, 220 series filled, 88 duplicates
deactivated (never deleted - `fabric_trackings.is_active`), 122 master rows
created for library colours that had none. Orphaned lines 492 -> 15, no code
carried by more than one active row, no library colour without an active master
row (run 31489281011).

**What caught it** - reading a `MODE=plan` output against production before every
apply. Fault (1) surfaced because the owner looked at the Converter screen; (2)
and (3) surfaced in plans that would otherwise have written them, and (3) twice.
The pattern to keep: these scripts are plan-by-default, and the plan is meant to
be read, not skimmed.

**Ref** - #2009 / #2018 / #2032 / #2033, 2026-08-11.
