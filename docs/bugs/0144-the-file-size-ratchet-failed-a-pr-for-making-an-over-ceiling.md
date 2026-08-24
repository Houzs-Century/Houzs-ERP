## The file-size ratchet failed a PR for making an over-ceiling file SMALLER [medium]

**Symptom** — PR #2127 opened `backend/src/scm/routes/grns.ts`, which stood at
**3,591 lines on main** against a ceiling of 3,482, and left it at **3,586**.
The gate failed it: *3586 lines, ceiling 3482 (over by 104). This file may only
SHRINK.* The PR had shrunk it.

**Root cause** — the fix earlier that same day taught the gate to charge only
files the change TOUCHED. That was right, and not enough: touching is not
growing. A file already carrying 109 lines of someone else's debt then puts
every later author to a choice the ratchet never meant to offer — abandon the
improvement, or pay off the debt before you are allowed to fix a bug in that
file.

**Fix** — a touched file is charged only when THIS change grew it, measured
against its own line count at the merge base. Growth is still charged from the
first line; a file with no counterpart at the base is charged as new; and if the
base cannot be resolved, every touched violation is charged again. The violation
prints either way — the debt is real and stays visible, it is simply not billed
to whoever walked past it.

**The check** — `scripts/check-file-size-ratchet.mjs` gains the case, with the
real numbers: 3,591 at base and 3,586 now is not chargeable; 3,500 at base and
3,586 now is, from the first line.

**Class** — *a gate whose blast radius is wider than its subject*, third
instance in two days (the census counting deliberate tombstones, the ratchet
charging untouched files, this). The subject here is growth; the gate was
measuring altitude.

**Ref** - `fix/ratchet-charges-growth`, 2026-08-14
