---------------------------- MODULE AcOutboxClaim ----------------------------
(***************************************************************************)
(* How the ERP's dispatchers take rows of scm.autocount_outbox and send    *)
(* them to the AutoCount host, and whether one row can become two          *)
(* documents in the account book.                                          *)
(*                                                                         *)
(* Dispatchers are Worker invocations that reach dispatchOne: the 5-minute *)
(* sweep (drainAutoCountOutbox) and the AutoCount Sync page's "Send now"   *)
(* (autocount-requeue.ts). The office host does not claim rows; it only    *)
(* answers the Worker's HTTP call. Every action cites the code it models;  *)
(* README.md has the full table.                                           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Dispatchers,              \* e.g. {"sweep", "sendNow"}
    Rows,                     \* outbox rows, one document each
    MaxAttempts,              \* MAX_ATTEMPTS, autocount-outbox.ts:111
    MaxCrashes,               \* bound on Worker kills, to keep liveness checkable
    CrashAfterSave,           \* the Worker can die after the host's Save() and before mark()
    ResponseCanBeLost,        \* the host saved, but the Worker sees a throw or a 5xx
    LeaseCanExpireOnLiveSend, \* a live send can outlast AC_CLAIM_LEASE_MS
    ClaimIgnoresHolder        \* BROKEN VARIANT ONLY: claimOutboxRow without .is('claimed_at', null)

None == "none"

VARIABLES
    status,    \* autocount_outbox.status: "pending" | "sent" | "failed"
    claimed,   \* autocount_outbox.claimed_at IS NOT NULL
    attempts,  \* autocount_outbox.attempts
    posts,     \* how many documents the account book holds for the row
    pc,        \* per dispatcher: "idle" | "claimed" | "saved"
    target,    \* the row a dispatcher holds, or None
    seen,      \* row.attempts as the dispatcher read it at select time
    crashes

vars == <<status, claimed, attempts, posts, pc, target, seen, crashes>>

Init ==
    /\ status   = [r \in Rows |-> "pending"]
    /\ claimed  = [r \in Rows |-> FALSE]
    /\ attempts = [r \in Rows |-> 0]
    /\ posts    = [r \in Rows |-> 0]
    /\ pc       = [d \in Dispatchers |-> "idle"]
    /\ target   = [d \in Dispatchers |-> None]
    /\ seen     = [d \in Dispatchers |-> 0]
    /\ crashes  = 0

Free(d) ==
    /\ pc'     = [pc EXCEPT ![d] = "idle"]
    /\ target' = [target EXCEPT ![d] = None]

(* mark(), autocount-outbox.ts:1105-1109. Filters on id ONLY: no status    *)
(* predicate and no "am I still the holder" predicate, and it clears the   *)
(* claim on every outcome. attempts is the value read at select + 1        *)
(* (autocount-outbox.ts:1217).                                             *)
Mark(d, newStatus) ==
    LET r == target[d] IN
    /\ status'   = [status EXCEPT ![r] = newStatus]
    /\ attempts' = [attempts EXCEPT ![r] = seen[d] + 1]
    /\ claimed'  = [claimed EXCEPT ![r] = FALSE]

(* The drain's SELECT (autocount-outbox.ts:1332-1337) or Send now's read,  *)
(* then claimOutboxRow (autocount-claim.ts:48-58): one UPDATE ... WHERE    *)
(* id AND status='pending' AND claimed_at IS NULL, atomic under the row    *)
(* lock. The select is folded in because the claim re-checks everything    *)
(* the select decided except attempts, which the claim does not test.      *)
Claim(d, r) ==
    /\ pc[d] = "idle"
    /\ status[r] = "pending"
    /\ attempts[r] < MaxAttempts
    /\ ClaimIgnoresHolder \/ ~claimed[r]
    /\ claimed' = [claimed EXCEPT ![r] = TRUE]
    /\ pc'      = [pc EXCEPT ![d] = "claimed"]
    /\ target'  = [target EXCEPT ![d] = r]
    /\ seen'    = [seen EXCEPT ![d] = attempts[r]]
    /\ UNCHANGED <<status, attempts, posts, crashes>>

(* The host refused, or never got the request: nothing is in the book.     *)
(* callAcService (autocount-writeback.ts:1384-1453), then dispatchOne's    *)
(* retry/give-up mark (autocount-outbox.ts:1297-1306; same shape for       *)
(* ensure_masters at 1227-1233). Retryable or not is the host's choice.    *)
SendFails(d) ==
    /\ pc[d] = "claimed"
    /\ \E giveUp \in BOOLEAN :
         /\ (seen[d] + 1 >= MaxAttempts) => giveUp
         /\ Mark(d, IF giveUp THEN "failed" ELSE "pending")
    /\ Free(d)
    /\ UNCHANGED <<posts, seen, crashes>>

(* The host saves the document: so.Save() in CreateSo (AcSyncService.cs:  *)
(* 1290), doc.Save() in Convert_ (AcSyncService.cs:1486). The C# does     *)
(* not look the DocNo up before saving. This step is NOT atomic with the   *)
(* Worker's mark().                                                        *)
HostSaves(d) ==
    /\ pc[d] = "claimed"
    /\ posts' = [posts EXCEPT ![target[d]] = @ + 1]
    /\ pc'    = [pc EXCEPT ![d] = "saved"]
    /\ UNCHANGED <<status, claimed, attempts, target, seen, crashes>>

(* The answer arrives: mark sent (autocount-outbox.ts:1246-1254).          *)
AckSent(d) ==
    /\ pc[d] = "saved"
    /\ Mark(d, "sent")
    /\ Free(d)
    /\ UNCHANGED <<posts, seen, crashes>>

(* The host saved, but the Worker sees a thrown fetch (always retryable,   *)
(* autocount-writeback.ts:1407-1418) or a 5xx such as a tunnel timeout,    *)
(* and dispatchOne marks the row pending again (autocount-outbox.ts:       *)
(* 1297-1306). The next sweep sends it again.                              *)
AckLost(d) ==
    /\ ResponseCanBeLost
    /\ pc[d] = "saved"
    /\ \E giveUp \in BOOLEAN :
         /\ (seen[d] + 1 >= MaxAttempts) => giveUp
         /\ Mark(d, IF giveUp THEN "failed" ELSE "pending")
    /\ Free(d)
    /\ UNCHANGED <<posts, seen, crashes>>

(* The Worker is killed (ctx.waitUntil is not guaranteed to finish), or    *)
(* dispatchOne throws (autocount-requeue.ts:1078-1085). mark() never runs, *)
(* so the claim stays on the row (autocount-outbox.ts:1107).          *)
Crash(d) ==
    /\ crashes < MaxCrashes
    /\ pc[d] = "claimed" \/ (pc[d] = "saved" /\ CrashAfterSave)
    /\ Free(d)
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<status, claimed, attempts, posts, seen>>

(* releaseExpiredClaims (autocount-claim.ts:79-85), run before every     *)
(* sweep's select (autocount-outbox.ts:1331). It decides on age alone: it  *)
(* cannot tell a dead holder from a slow one. Whether a live send can ever *)
(* be older than the lease is the constant LeaseCanExpireOnLiveSend.       *)
ReleaseExpired(r) ==
    /\ status[r] = "pending"
    /\ claimed[r]
    /\ LeaseCanExpireOnLiveSend \/ \A d \in Dispatchers : target[d] # r
    /\ claimed' = [claimed EXCEPT ![r] = FALSE]
    /\ UNCHANGED <<status, attempts, posts, pc, target, seen, crashes>>

Step(d) ==
    \/ \E r \in Rows : Claim(d, r)
    \/ SendFails(d) \/ HostSaves(d) \/ AckSent(d) \/ AckLost(d)

Next ==
    \/ \E d \in Dispatchers : Step(d) \/ Crash(d)
    \/ \E r \in Rows : ReleaseExpired(r)

(* The sweep fires every 5 minutes and a send in flight finishes unless    *)
(* killed: weak fairness on every step except Crash.                       *)
Fairness ==
    /\ \A d \in Dispatchers : WF_vars(Step(d))
    /\ \A r \in Rows : WF_vars(ReleaseExpired(r))

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
    /\ status   \in [Rows -> {"pending", "sent", "failed"}]
    /\ claimed  \in [Rows -> BOOLEAN]
    /\ attempts \in [Rows -> 0..MaxAttempts]
    /\ posts    \in [Rows -> Nat]
    /\ pc       \in [Dispatchers -> {"idle", "claimed", "saved"}]
    /\ target   \in [Dispatchers -> Rows \cup {None}]

(* SAFETY: each outbox row puts at most one document into the book.       *)
NoDoublePost == \A r \in Rows : posts[r] <= 1

(* LIVENESS: no row stays pending for ever.                                *)
EventuallyDone == \A r \in Rows : <>(status[r] \in {"sent", "failed"})
=============================================================================
