## A probe piped into tee reported a green run after dying on a Postgres error [high]

**Symptom.** `probe-catalogue-alias-disagreement` run **34178111750** concluded
**`success`**. It had not succeeded: its last query threw Postgres `42703`
(`errorMissingColumn`), `main().catch` ran `process.exit(1)`, and two of the
probe's five answers — the document census and the verdict line — were never
printed. Reading the run's conclusion, or the annotations, would have said the
check was fine. Only scrolling to the bottom of the step log showed the stack.

This is the trap CLAUDE.md names as *"the check that is not running"*, in its
most expensive form: not a check that fails loudly, a check that **dies and
reports a pass**.

**Root cause (traced).** The step was:

```yaml
run: node scripts/probe-catalogue-alias-disagreement.mjs | tee probe-out.txt
```

A `run:` step with no `shell:` key uses **`bash -e {0}`**, which does NOT set
`pipefail`. In a pipeline without it, the exit status is the status of the LAST
command — `tee`, which succeeds whatever happened upstream — so `node` exiting 1
is discarded. `-e` never sees a failure to act on.

The explicit `shell: bash` form is `bash --noprofile --norc -eo pipefail {0}`,
which is why this is easy to get wrong: the same YAML is safe with one extra
line and unsafe without it, and nothing in the run output distinguishes them.

The repo already knew this — 33 of the 36 workflows that pipe into `tee` set
`pipefail` explicitly. Three did not, and this probe was the newest of them.
Being the majority convention is not enforcement. After this change it is 36 of
36; re-measure rather than trusting the number:

```sh
for f in $(grep -rlF "| tee " .github/workflows); do grep -q pipefail "$f" || echo "$f"; done
```

The underlying error was a wrong column name in the probe's own SQL
(`purchase_order_items.po_id`; the column is `purchase_order_id`). That is a
one-character class of mistake and would have been caught in seconds — the bug
here is that it was not surfaced at all.

**Fix.** `set -o pipefail` added to all three workflows that lacked it, with the
measurement above written beside it so the next author reads why rather than
guessing it is boilerplate:

- `.github/workflows/probe-catalogue-alias-disagreement.yml`
- `.github/workflows/probe-sofa-import-duplicates.yml`
- `.github/workflows/probe-supplier-costing-state.yml`

The column name is corrected in the same change, and the probe re-dispatched to
prove it now answers all five questions.

**What this does NOT fix, said plainly.** Nothing stops a *new* workflow being
written the same way. A gate over `.github/workflows` — every `| tee` in a `run:`
step must be preceded by `pipefail` or carry `shell: bash` — is the durable
answer and is NOT built here; this change fixes the three instances and records
the rule. Left as a follow-up rather than done silently, because a rule written
in a ledger entry and enforced nowhere is exactly what let 33-of-36 look like a
convention rather than a guarantee.

**Ref.** fix/probe-pipefail-masks-failure, 2026-09-08. Evidence: run
34178111750 (`success`, exit 1 in the step log). Related: docs/bugs/0686, which
this probe was written to measure.
