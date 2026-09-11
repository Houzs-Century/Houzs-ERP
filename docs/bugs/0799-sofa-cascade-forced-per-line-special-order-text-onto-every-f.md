## Sofa cascade forced per-line special-order text onto every follower [critical]

**Symptom.** Owner (S. Peifen), 2026-09-11, mobile SO HC-SO-007678: added a
`Custom / other` note to HILTON (A)-(K) — *"Customer would like to customize
the front divan with one drawer on the left and one drawer on the right"* —
and saved. On reopen, the SAME text sat on the FENRIR-(Q) line further down
the same order, and the picker would not let her remove it from FENRIR. The
lines are different physical items — the text belongs on HILTON only. She
reported it as *"我要在erp remove掉这个之前 但是remove不到"* and *"我只是加
在Hilton Kingsize save起来 过后我开会去 看到fenrir那边也被一起加下去了 fenrir
那边remove不到"*.

DATA CONTAMINATION between lines is not a UI annoyance — this note is what
goes to the supplier, and copying it to the wrong sofa ships the wrong build.

**Root cause (traced).** `frontend/src/vendor/scm/lib/so-variant-cascade.ts`
holds the ONE master-follower rule shared by desktop and mobile. Its
`NEVER_INHERITED_KEYS` list (was L63) enumerated only `['remark', 'buildKey']`
— the two per-line keys anyone had thought about — and the rest of the
`variants` object was treated as a category-wide axis that a master's edit
FORCES onto every follower of the same category (owner ruling 2026-08-21,
"latest change wins").

The **SPECIAL-ORDER payload** — `extraAddonNote`, `extraAddonAmountRM`,
`specials`, `specialLabels`, `specialChoices` — was never on that list.
`cascadeMasterVariants` therefore treated the master's Custom-other note the
same way it treats a sofa's fabric: everyone follows. For a fabric on a sofa
that IS the right rule (one physical sofa's compartments share a colour); for
a free-text note on ONE build it is exactly wrong. The mobile sheet writing
the note (`SpecialOrderSheet` at `MobileNewSO.tsx:3411`) does its own edit
correctly — it's the cascade tick that fires next which force-copies the
result onto every same-category line.

The five keys are per-line by construction (`extraAddonNote` is a free text
box, `specials` an array of picks scoped to one build, `specialChoices` a
per-pick config), so they belong on the list with `remark` and `buildKey`.
Nothing else needed to move.

**Fix.** Add the five keys to `NEVER_INHERITED_KEYS`:

```ts
export const NEVER_INHERITED_KEYS: readonly string[] = [
  'remark', 'buildKey',
  'extraAddonNote', 'extraAddonAmountRM',
  'specials', 'specialLabels', 'specialChoices',
];
```

Both surfaces (desktop `SalesOrderNew`, mobile `MobileNewSO`,
`ConsignmentOrderNew`) import this module and are fixed at the same time.

**Test that pins it.** `so-variant-cascade.test.ts` gets a new case that
starts a sofa master carrying all five keys plus one legitimately-cascading
axis (`seatHeight`), asserts the follower receives ONLY `seatHeight`. The
existing list-shape test is updated to the new seven-key list. Proved RED on
the unfixed tree (the list-shape test asserted the old two-key contents,
which the fix breaks; the new leak test would find `extraAddonNote` on
`variants[1]` before the fix).

One collateral: an existing test at L181 ("a restricted category set leaves
everything else alone") used `specials` to demonstrate cascade travel. That
test was documenting the OLD (buggy) behaviour. Rewritten to use `seatHeight`
— it still tests the RESTRICTION path (mobile passing a Set that excludes
mattress), just with a key that is legitimately category-wide.

**Ref.** `fix/never-inherit-per-line-keys`, 2026-09-11.
