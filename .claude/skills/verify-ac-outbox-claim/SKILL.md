---
name: verify-ac-outbox-claim
description: Use when a change touches the AutoCount outbox claim, ack or retry code (claimOutboxRow, releaseExpiredClaims, mark, dispatchOne, drainAutoCountOutbox, Send now, callAcService retryable rules, the C# Save paths, or the autocount_outbox claimed_at/status/attempts columns). Model-checks with TLA+ that one outbox row never becomes two AutoCount documents and never stays pending for ever.
---

# Verify the AutoCount outbox claim

Model: `formal/ac-outbox-claim/AcOutboxClaim.tla`. Read `formal/ac-outbox-claim/README.md` first: it has the property, the harm, the code mapping table and the known finding.

## When to run

Run it when your diff touches any covered file below, and in particular when it changes:
- the claim predicate, the lease, or when the lease is released;
- what `mark()` filters on or what it writes;
- which outcomes are retryable, or the attempt cap;
- a new dispatcher that reaches `dispatchOne`;
- how the C# host saves a document, or a DocNo existence check before `Save()`.

Covered (synced at commit `efe17f8be92f12341e3443685ef0ea73b86f8f04`):
- `backend/src/scm/lib/autocount-claim.ts` — `claimOutboxRow`, `releaseExpiredClaims`, `AC_CLAIM_LEASE_MS`
- `backend/src/scm/lib/autocount-outbox.ts` — `mark`, `dispatchOne`, `drainAutoCountOutbox`, `MAX_ATTEMPTS`
- `backend/src/scm/lib/autocount-requeue.ts` — the Send now claim and dispatch
- `backend/src/services/autocount-writeback.ts` — `callAcService` (retryable rules)
- `backend/scripts/autocount-service/AcSyncService.cs` — `CreateSo`, `CreatePo`, `Convert_`, `SoToPo` save paths
- `backend/src/db/migrations-pg/0277_scm_autocount_outbox.sql`, `0315_ac_outbox_claim.sql`

Check drift: `git diff efe17f8be92f12341e3443685ef0ea73b86f8f04 -- <the files above>`.

## The command

```
node scripts/run-tla.mjs formal/ac-outbox-claim/AcOutboxClaim.cfg
node scripts/run-tla.mjs --expect-violation formal/ac-outbox-claim/AcOutboxClaimBroken.cfg
node scripts/run-tla.mjs --expect-violation formal/ac-outbox-claim/AcOutboxClaimFinding.cfg
```

Each exits 0 when the result is what that config expects. Needs `java` on PATH; the jar is pinned and checksummed by the script. About 10 seconds each.

## Reading a result

- `verdict: pass` on `AcOutboxClaim.cfg`: under its assumptions (lease outlives a live send, a Worker dies only before the host saves), no row is sent twice and none stays pending.
- `Error: Invariant NoDoublePost is violated`: TLC prints the shortest path as `State N: <Action ...>` lines. Read the action names against the README mapping table and retell it in the code's words, e.g. "sweep claims r2 (`claimOutboxRow`), host saves (`so.Save()`), answer lost (`callAcService` retryable), `mark()` sets pending, sweep claims r2 again, host saves again". If the `/statechart` skill is available, use it to show the path in plain words.
- `Error: Temporal properties were violated` ending in `Stuttering` or `Back to state`: a row can stay pending for ever along the printed loop.
- `verdict: error`: a parse or semantic problem in the model, not a finding. Fix the model.

Real bug or modelling error? Map each step of the counterexample to a line of code. If every step is something the code can do, it is a real bug: report it, do not weaken the property. If a step has no counterpart in the code, the model is wrong: fix the model and say so.

## Updating the model

- Code change that keeps the design: update the cited line numbers in the `.tla` comments and the README table.
- Code change in a modelled step (new predicate, new outcome, new dispatcher): change that action so it is one atomic step exactly where the code has one atomic statement, then rerun all three configs.
- A fix for the finding (e.g. `mark()` filtering on the claim, or a DocNo lookup on the host before `Save()`): model it, turn the relevant fault on in `AcOutboxClaim.cfg`, and if `AcOutboxClaimFinding.cfg` now passes, move it from `--expect-violation` to a plain run and rewrite the README Finding section.
- `AcOutboxClaimBroken.cfg` must keep failing. If it passes, the model no longer depends on the claim guard and has stopped checking anything.
- Move the sync commit (here and in the README) forward only after you have confirmed the model describes the code at the new commit.
