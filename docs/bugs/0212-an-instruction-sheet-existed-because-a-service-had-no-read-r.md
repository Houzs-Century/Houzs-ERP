## An instruction sheet existed because a service had no read route; it has one now [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Not a defect — a standing manual task that `CLAUDE.md` forbids in
every other corner of this system.

`docs/autocount-handling-listing.md` is a sheet someone carries to the AutoCount
machine, runs three SELECTs on by hand, and sends a file back from. It exists
because `AcSyncService` — the only automated path into the licensed book —
**exposed no read route at all**, so the standing rule (never ask a human to run
a query, build the check) could not be honoured for the one database no workflow
can reach. The listing's own section 8 said so, and named the fix.

**Fix.** `POST /further-description` on that service, with `{ Table, DtlKey }`.
Two SELECTs on one connection, no SDK session, no transaction. The table name
comes from an ALLOW-LIST, never the caller's string; the DtlKey is parameterised.

**It DISCOVERS the column rather than naming it**, and that is the design point,
not a flourish. The listing's step 1 exists because the SDK calls the field
`FurtherDescription` and *nobody has ever looked at what the column is called*.
Hard-coding a guess would turn "the column has another name" — a real answer —
into a SQL error that reads like a broken service. So step 1 IS the first query,
and no matching column comes back as a **200** with `column: null`. More than one
match refuses to pick.

**Truncation is reported, never silent.** The listing warns that `sqlcmd` cuts a
long text column and the reader never sees it; that is the exact failure this
route must not reproduce. The value is capped at 4 MB and the response carries
`truncated` plus the full `length`, so a caller holding partial bytes knows it.

Caller: `backend/scripts/read-further-description.mjs` — read-only, holds no
credential (the key comes from the environment and is never printed), refuses
with exit 2 rather than half-running, and prints the next command to run on the
extracted file.

**COMPILED, not just written.** `build-local.ps1` against the licensed AutoCount
2.2 assemblies: **exit 0, 51712 bytes**. That check exists because this file was
documented for months as the one thing CI cannot build, and an uncompilable
handler once sat on `main` undetected for exactly that reason.

**What is NOT done, and it is a deploy rather than a query:** the office host
still runs the previous build. `deploy-on-host.ps1` there once, and the sheet is
spent. The sheet stays afterwards for the case it still covers — a machine that
cannot reach the service, or a service that will not start.

**Ref.** 2026-08-15.
