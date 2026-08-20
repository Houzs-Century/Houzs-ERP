## Shutting the door on the product rows left them sitting in the fabric master, and a retire tool that could not prove they were unused would have been worse than none [medium]

**Symptom** - the guard below stopped a third product code reaching
`scm.fabric_trackings`, and deliberately did not touch `SOFA 5535` and
`SQUARE PILLOW`, which were already in it. The owner's question —
「为什么sofa 和square pillow在fabric convert里面？」 — was therefore still true of
prod after the fix that answered it.

**Root cause (of the gap, not of the rows)** - retiring them by hand is a
two-line UPDATE, and that is exactly the trap. Nothing in this database protects
a fabric code: there is **not one foreign key to `scm.fabric_colours`**, and
every reference to a fabric is a bare TEXT string inside jsonb or inside a
pipe-joined stock key. So "is anything using this code?" cannot be answered by
the schema, only by counting — across all 58 carriers `lib/colour-carriers.mjs`
knows about. A hand UPDATE, or a script that checked two or three obvious
tables, would deactivate a code that a live sales order still names, and the
line would go unpickable with nothing saying why. That is the same shape as
#1964 (the GRN arm went unswept) and the 2026-08-11 pass that superseded
`BO315-2-FEATHER` while 12 live rows still pointed at it.

**Fix** - `backend/scripts/retire-non-fabric-rows.mjs` + its workflow.
`MODE=plan` is the default, writes nothing, and holds the session
`default_transaction_read_only`; `MODE=apply` needs
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`. **It has no DELETE in it.** A retired
row gets `is_active = false` and a sentence appended to its description naming
the word that condemned it and the date, with the original description kept
verbatim in front — and the plan prints the exact reversal SQL, as a proper
single-quoted Postgres literal (the first draft emitted `JSON.stringify`, whose
double quotes Postgres reads as an *identifier*; both target rows contain `"`,
so the reversal would not have pasted). Before any row is touched the full
census runs against its code and **any live carrier outside the master refuses
the row**, which is re-checked inside the apply transaction in case the plan
went stale. The census engine (`resolveCarriers` / `countCarrier`) moved out of
`census-fabric-colour.mjs` into `lib/colour-carriers.mjs` so the reporter and
the writer cannot walk different arms; `tests/colourCarriersEngine.test.ts` pins
the emitted SQL per carrier kind with a recording stub, so the move is provably
behaviour-preserving without a database.

**Lesson** - **a write path guard and the rows it would have caught are two
different jobs, and the second one is only safe if it can prove a negative.**
The cheap version of this script is four lines and is wrong in the one case that
matters — a product code that reached a real order. The rule that made it safe
was not cleverness, it was refusing to answer from the schema (which knows
nothing) and answering from a count over every carrier instead, with the row's
own master entry as the single, named exclusion. **And a "reversible" operation
is only reversible if the reversal you printed actually runs** — that bug was
invisible in review and obvious the first time the script was executed.

**Ref** - 2026-08-13, this PR. Follows the guard in the entry below.
