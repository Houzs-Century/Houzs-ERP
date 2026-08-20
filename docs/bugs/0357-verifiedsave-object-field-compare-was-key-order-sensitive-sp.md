## verifiedSave object-field compare was key-order sensitive — spurious "save did not stick" [medium]

Symptom: Saving a record whose object field (e.g. address, variants) persisted correctly could still surface the operator-facing "<Noun> not saved — <field> still shows ... instead of ..." message. The write had actually stuck; verifiedSave reported a false mismatch.

Root cause (traced, not guessed): frontend/src/vendor/scm/lib/verified-save.ts `valuesEqual` compared non-scalar values with `JSON.stringify(a) === JSON.stringify(b)` (line ~100) and no key normalisation. JSON.stringify emits object keys in insertion order, so a readback returning `{b:2,a:1}` against an `expect` of `{a:1,b:2}` — the same value — stringified to different text and was flagged unequal by computeSaveDiffs, producing `{ ok:false, reason:'mismatch' }`.

Fix: Added a local `stableStringify` (JSON.stringify with a replacer that emits every plain object's keys in sorted order, recursively; arrays left in order so a genuine reorder is still a change) and switched `valuesEqual`'s object branch to compare via it. Added verified-save.test.ts covering reordered keys (equal), nested reordered keys (equal), a genuine value change (still flagged), and array reorder (still flagged). Frontend-only, no behaviour change beyond removing the false positive.
