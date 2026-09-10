## The staleness guard names a re-export section that does not exist [low]

**Symptom.** `create-migrated-invoices.mjs` refuses when its AutoCount map is
more than two days old — a good guard, added after a dry run planned confidently
from a 17-day-old world — and tells the operator how to fix it:

```
Re-export the map first (export-ac-reimport.py ONLY=ivrefs).
```

Run it and you get:

```
$ ONLY=ivrefs python backend/scripts/export-ac-reimport.py
unknown ONLY 'ivrefs'
```

**Root cause (traced, not guessed).** `export-ac-reimport.py` validates `ONLY`
against `SECTION_ORDER` = `so, iv, dates, po1, po2, dos, bal, costs, grrefs,
links, ruler, remarks, stamps, hdr`. There is no `ivrefs`, and there never was.
The file the guard is about — `data/ac-invoice-refs.json.gz` — is written by a
DIFFERENT script, `export-ac-invoice-refs.py`, which takes no `ONLY` at all.

**Why it matters more than a typo.** This is a REMEDY CLAIM inside a refusal —
the one place an operator is guaranteed to read and act on. CLAUDE.md's rule 3
exists for exactly this: *"the moment you tell anyone that running something will
fix something, paste what you observed when you ran it, or write UNTESTED"*. The
sentence was written from reading the export script's shape, not from running it,
and the gate that catches this class **warns rather than fails** on a `check-*.mjs`
verdict string precisely because a reader cannot ask the author whether they ran
it.

**Fix.** The message now names the script that actually writes the file:

```
Re-export the map first: AC_CRED_FILE=<path> python backend/scripts/export-ac-invoice-refs.py
```

**Verified by running it** — the map is refreshed in the same commit:

```
wrote backend/scripts/data/ac-invoice-refs.json.gz
  grToPi=5277 doToIv=10458 piMeta=5283 ivMeta=10292 exportedAt=2026-09-09T22:55:21
```

**Ref.** PR for `chore/fresh-invoice-refs`, 2026-09-09.
