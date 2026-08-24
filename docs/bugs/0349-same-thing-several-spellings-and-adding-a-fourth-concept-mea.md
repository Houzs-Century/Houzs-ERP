## Same thing, several spellings — and adding a fourth concept meant remembering to write a fourth guard [medium]

**Symptom.** Owner, 2026-08-18: 「我跟你讲 Processing Date, 你却去找成 Process
Date ... 这种问题其实也是名词的统一」. Branding, the Processing Date and
Transfer to/from each carry more than one spelling, so every conversation starts
by re-agreeing which word is meant, and an audit script that guesses wrong
queries a column that does not exist — 42703 fails the WHOLE statement, so it
answers nothing rather than answering less.

**Root cause (the pattern, not the words).** The repo had already solved this
THREE times, by hand each time: `so-processing-date.mjs` plus an 80-line
directory-walking test, `transfer-vocabulary.ts` plus another, the catalogue
series plus a third. Every one works. But a FOURTH concept costs somebody
remembering to write a fourth test, and the concept nobody remembers is exactly
the one that drifts. The cost of guarding a word was the defect.

Separately, nothing existed for a HUMAN to read. The canonical spelling was in
the tree in plain text — and only programs ever opened the file.

**Fix.** One registry (`scripts/lib/vocabulary.mjs`), three consumers:

| | |
| --- | --- |
| `audit:vocabulary` | ONE guard for every concept. Comments, migrations and tests may name a retired spelling — a rename is a story worth telling; CODE may not |
| `audit:glossary` | `docs/generated/GLOSSARY.md`, GENERATED. A hand-written glossary is one more document to keep in sync, which is the problem, not the fix |
| working-agreement rule 2 | now fires on a LOGIC change in a documented file, not only the five surface shapes |

**THE REGISTRY'S FIRST DRAFT WAS WRONG TWICE, both caught by running it rather
than by reasoning, and both are now regression tests.** `proceeded_at` was
listed as retired: the column still exists on `scm.mfg_sales_orders` and the
diagnostic probes read it on purpose, so the guard produced **175 findings,
essentially all false** — the exact failure the file's own header warns about,
committed by its author. Then `internalExpectedDd` was listed: that is the
PAYLOAD key the status route still accepts from old clients deliberately, a
different thing from the dropped COLUMN it resembles. Only
`internal_expected_dd`, which `information_schema` no longer has, survived.

**Proven red before being trusted green.** A planted `internal_expected_dd` in
code exits 1; the same word in a comment exits 0; the guard self-tests its
matcher at startup and exits 2 rather than reporting a verdict it could not have
computed.

**Blast radius of the working-agreement half, measured:** of the last 30 merges,
19 touched a file some guide quotes and **8 never opened the guide** — one of
them the commit that created the shared Branding rule. Those 8 would now be
asked for the guide, or for the `no-guide-change` label, which prints the waiver
into the log.

**Ref.** 2026-08-18, branch `feat/one-vocabulary`.
