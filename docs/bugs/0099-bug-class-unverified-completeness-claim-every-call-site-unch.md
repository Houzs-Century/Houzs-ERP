## BUG CLASS - unverified-completeness-claim: "every call site", unchecked [high]

**The shape** - a PR asserts it covered a whole POPULATION — "every desktop +
mobile call site", "all four arms", "system-wide", "everywhere" — and it did
not. The claim is prose, so nothing reads it: `tsc` cannot see it, vitest
cannot see it, and a reviewer who could check it would have to re-derive the
population by hand, which is the work the sentence was written to save them.
The claim is believed exactly because it is confident, and the half of the
population nobody enumerated keeps the old behaviour.

This is the FIRST-ORDER version of `optional-param-noop` below. That class is
about the compiler being unable to enumerate call sites; this one is about the
AUTHOR not enumerating them either, and saying otherwise.

**Worked example** - PR #1763, as traced in the entry below: thirteen call
sites, five untouched, the sentence "every desktop + mobile call site", and four
days of DIVAN ONLY lines demanding a mattress Gap. Note that the false claim
lived in the PR BODY, not the title — the title says only "DIVAN ONLY lines do
not require a mattress Gap". Any check that reads titles alone misses it.

**How common** - the detector in `scripts/lib/completeness-claim.mjs`, run over
all 3,231 commits reachable from `origin/main` **as of 2026-08-13**, fires on 30
titles (0.9%) and 438 title-or-body messages (13.6%): roughly one merged PR in
seven makes a claim of this shape. Before this gate, none of them was checkable.
Those figures are a snapshot of that date and will drift; re-run the detector
over `git log` before quoting them.

**The remedy** - `.github/workflows/completeness-claim.yml`. When a PR title or
body claims completeness, the body must carry a fenced block tagged
`enumeration` holding the command that ENUMERATES the population and that
command's output:

````
```enumeration
$ git grep -n "missingVariantAxes(" -- backend/src frontend/src
backend/src/scm/lib/so-variant-check.ts:56:    const missing = ...
...
```
````

CI **re-runs the command against the PR head and diffs the output**. That last
part is the whole design: a pasted list can be stale or invented, so the check
reproduces it rather than trusting it. The author's own sentence becomes a test,
and the diff names the members of the population the PR did not cover.

The command is never handed to a shell — a PR body is untrusted input written by
anyone who can open a PR. It is tokenised in-process and restricted to
`grep` / `rg` / `git grep` / `git ls-files` / `node -e` one-liners over this
checkout, with a per-program flag allowlist (`rg --pre`, `rg -z`, `rg -L`, and
any option before a git subcommand are refused by name), a scrubbed environment
so no secret is reachable, `--permission --allow-fs-read=<repo>` for node, and a
60s timeout. See the header of `scripts/check-completeness-claim.mjs`.

**The escape, and why it is loud** - a PR may carry the label
`completeness-not-claimed`. The check then passes, prints the offending phrases
back with their line numbers, and asks for the wording to be changed. It waives
the PROOF, not the problem: the sentence is still in the PR and a reader six
months from now will still read it as a promise.

**Ref** - `completeness-gate`, 2026-08-13
