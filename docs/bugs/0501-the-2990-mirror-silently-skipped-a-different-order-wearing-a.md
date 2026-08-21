## The 2990 mirror silently skipped a different order wearing an existing doc number [critical]

<!-- area: SCM sync -->

**Symptom.** Owner searched "larding" in 2990's SCM Sales Orders and found only
the RM 0.00 lucky-draw order (2990-SO-2607-021). The customer's paid sofa order
— printed as 2990-SO-2607-019, RM 2,865, RM 1,433 deposit taken — was not in the
list. The DB row for 2990-SO-2607-019 held a DIFFERENT customer's order
(Jaikrishen Singh, created 2026-07-26), while the audit log still carried the
sofa's CREATE + "Auto: POS deposit recorded at SO create" from 2026-07-24 05:53.

**Root cause (traced).** A split-brain double-mint met a blind upsert. 2990's
own SO series is minted bare (`SO-2607-NNN`, max+1 over its rows —
apps/api nextDocNo in the 2990 repo) and cannot see the numbers Houzs mints
natively for company 2 post-flip (`2990-SO-2607-NNN`). On 2026-07-26 a POS-side
create took `SO-2607-019` (its July max was 018); so-mirror.ts's prefixDoc
mapped it onto `2990-SO-2607-019` — Larding Chen's Houzs-native sofa — and the
pre-#2515 receiver ("idempotently UPSERT by doc_no") replaced header, items and
the deposit payment wholesale, writing no audit. #2515's import-once stops the
overwrite, but classifies EVERY delivery of a held doc_no as `skipped_existing`
— so the same collision today would silently DROP the incoming order instead;
the doc_no-set mirror sentinel is blind to both shapes (the number still
exists, only the identity changed).

**Fix.** so-mirror.ts now reads the held row's debtor_name in the import-once
gate and classifies the skip: a delivery naming a different customer records
`skipped_conflict` in scm.so_mirror_skips plus a console.error, instead of
hiding among benign `skipped_existing` re-deliveries. Which order owns the
number stays a human call — the write is refused either way. Pinned by
so-mirror.skip-action.test.ts (the Larding/Jaikrishen shape, plus the
no-header and blank-name degradations). Proved RED on the unfixed tree in the
sense that the incident row exists in prod with no conflict evidence; the
classifier is new code, so the unit tests are the pin. Data repair for
2990-SO-2607-019 itself is a separate prod surgery (renumber the occupying
order, rebuild the sofa from the audit snapshot + printed SO).

**Ref.** fix/so-doc-no-clobber-guard-0821, 2026-08-21.
