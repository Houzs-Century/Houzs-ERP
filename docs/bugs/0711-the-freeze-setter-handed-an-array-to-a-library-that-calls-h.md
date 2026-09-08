## The freeze setter handed an array to a library that calls .has() [medium]

**Symptom.** The very first dispatch of the new write-freeze setter — `mode=plan`,
against production, run `34209796675`, 2026-09-08 — died on its second line:

```
set-write-freeze — MODE=plan
BEFORE  scm.write_freeze = "1 - scm.procurement.products"
TypeError: areaKeys.has is not a function
    at validateFreezeValue (backend/scripts/lib/scm-area-keys.mjs:80:18)
```

**Nothing was written.** It is the plan path and it died before any write; the
production value stayed `1 - scm.procurement.products`.

**Root cause (traced).** `readScmAreaKeys()` returns a **Set**, and
`validateFreezeValue` calls `.has()` on whatever it is given.
`set-write-freeze.mjs` normalised it to a sorted **array** — genuinely useful,
because this script filters and joins that list to print what it OPENS, what it
CLOSES and what stays frozen — and then passed that array back into the library.

The array itself was a correction to an EARLIER version of the same confusion:
the first draft used `Array.isArray(areaKeys)` as its emptiness guard, which was
false against a Set, so the script refused to run at all with *"Could not read
the SCM area keys"*. Fixing that by converting to an array moved the wrong shape
one layer along instead of removing it.

**Why nothing local caught it.** Every gate passed: `node --check`, both refusal
guards (unknown area, missing DSN), `audit:release-discipline`,
`check-docs-drift --strict`, `check:file-size`. **None of them reaches that
line**, because none gets past opening a database — the parse of the CURRENT
value happens after the first `SELECT`. A local run without a DSN exits before
it; a local run with a bad DSN dies on connect.

**Fix.** Keep both shapes and never derive one at a call site:

- `AREA_SET` — the Set, and the only thing handed to `validateFreezeValue`
- `areaKeys` — `[...AREA_SET].sort()`, for this file's own filtering and printing

Plus a startup assertion, so the next person gets a sentence rather than a
`TypeError` from inside another module:

```js
if (typeof AREA_SET?.has !== "function") {
  console.error("readScmAreaKeys no longer returns a Set — validateFreezeValue calls .has() on it.");
  process.exit(1);
}
```

**Verified** by exercising the exact parse against the real area reader, which
is the check that was missing:

```
"1 - scm.procurement.products"                       ok=true scope=1 open=[scm.procurement.products]
"1 - scm.procurement.products, scm.sales.delivery"   ok=true scope=1 open=[scm.procurement.products, scm.sales.delivery]
"off"                                                ok=true scope=off open=[]
```

**Lesson, and it is not "check the return type".** A shared helper whose contract
is a Set is indistinguishable from one whose contract is an array until it is
called, and this file needed both. The durable form is to name the two and let
the names carry the contract — `AREA_SET` cannot be accidentally `.filter`ed and
`areaKeys` cannot be accidentally `.has`ed. A comment saying "returns a Set"
would have been read by the same person who had already written
`Array.isArray()` against it.

**And the rule that actually caught it:** *a `workflow_dispatch` workflow is not
shipped until it has been dispatched once and reported success.* The shipping
PR said UNTESTED in exactly those words, and the first dispatch is what found
it — the same way #2120 was caught when that rule was written.

**Ref.** PR pending, 2026-09-08. Follows
`docs/bugs/0710-the-write-freeze-runbook-told-everyone-to-run-a-workflow-tha.md`.
