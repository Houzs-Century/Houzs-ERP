# AutoCount outbox claim (TLA+)

A model of how the ERP's dispatchers take rows of `scm.autocount_outbox` and send them to the AutoCount host.

- **Property (NoDoublePost):** each outbox row puts at most one document into the AutoCount book.
- **Harm if broken:** the same sales order, delivery order, invoice, PO, GRN or purchase invoice lands in the licensed account book twice, which doubles money and stock.
- **Property (EventuallyDone):** no row stays `pending` for ever.
- **Harm if broken:** a document is queued and visibly waiting, and never reaches the book.

The dispatchers are Worker invocations: the 5-minute sweep and the AutoCount Sync page's "Send now". The office host does not claim rows. It only answers the Worker's HTTP call.

## Run

```
node scripts/run-tla.mjs formal/ac-outbox-claim/AcOutboxClaim.cfg                            # must pass
node scripts/run-tla.mjs --expect-violation formal/ac-outbox-claim/AcOutboxClaimBroken.cfg   # must violate
node scripts/run-tla.mjs --expect-violation formal/ac-outbox-claim/AcOutboxClaimFinding.cfg  # known finding
```

Needs `java` (11+ recommended; 8 also runs v1.7.4) on PATH. The runner downloads tla2tools.jar v1.7.4 into `formal/.cache/` and checks its sha256. Each run takes about 10 seconds.

| Config | Faults allowed | Result |
|---|---|---|
| `AcOutboxClaim.cfg` | Worker killed before the host saves; host refusals and retries | PASS (33,871 distinct states), both properties |
| `AcOutboxClaimBroken.cfg` | as above, and the claim ignores `claimed_at` | NoDoublePost violated: two dispatchers claim one row and both send |
| `AcOutboxClaimFinding.cfg` | as above (claim intact), plus the three faults below | NoDoublePost violated. This is a real finding |

## Finding

The claim stops two dispatchers starting the same row at the same time. It cannot stop a row being sent again after the book already saved it, because the host's `Save()` and the Worker's `mark()` are two separate steps, and the C# does not look up the DocNo before saving. TLC finds each of these on its own:

1. **Answer lost after save.** The sweep claims a row, the host saves the document, the Worker sees a thrown fetch or a 5xx (for example a tunnel timeout), `dispatchOne` marks the row `pending` again, and the next sweep claims it and sends it again. The claim is not involved.
2. **Worker killed after save.** The sweep claims a row, the host saves it, the Worker is killed before `mark()`. The claim stays. Ten minutes later `releaseExpiredClaims` frees it and the next sweep sends it again.
3. **Slow live send.** A send is still running after 10 minutes (`callAcService` sets no fetch timeout). `releaseExpiredClaims` cannot tell slow from dead, frees the row, and the second dispatcher sends it while the first is still going. The first one's late `mark()` then overwrites the row, because `mark()` filters on `id` only.

Not verified from this repo: whether the AutoCount SDK itself refuses a second document with the same DocNo on `Save()`. If it does, these cases end as a `failed` row for a document that is in the book, not as a duplicate. The ERP always sends its own DocNo on creates (`RequireDocNo`, AcSyncService.cs:1229) and on sales conversions (`SalesHeader`, comment at AcSyncService.cs:1473-1478).

## Code mapping

| Model | Code |
|---|---|
| `Claim(d, r)` | drain select `backend/src/scm/lib/autocount-outbox.ts:1332-1337`, Send now's checks `autocount-requeue.ts:1045-1076`, then `claimOutboxRow` `backend/src/scm/lib/autocount-claim.ts:48-58` (one `UPDATE ... WHERE id AND status='pending' AND claimed_at IS NULL`) |
| `Mark(d, s)` | `mark()` `autocount-outbox.ts:1105-1109` (id only, clears `claimed_at`); attempts = read value + 1 `autocount-outbox.ts:1217` |
| `SendFails(d)` | `callAcService` `backend/src/services/autocount-writeback.ts:1384-1453`; retry/give-up mark `autocount-outbox.ts:1297-1306`; masters refusal `autocount-outbox.ts:1227-1233` |
| `HostSaves(d)` | `so.Save()` `backend/scripts/autocount-service/AcSyncService.cs:1290`, `doc.Save()` `AcSyncService.cs:1486` and the other `Convert_` arms |
| `AckSent(d)` | sent mark `autocount-outbox.ts:1246-1254` |
| `AckLost(d)` | thrown fetch is retryable `autocount-writeback.ts:1407-1418`, then `autocount-outbox.ts:1297-1306` |
| `Crash(d)` | Worker killed or `dispatchOne` throws: claim left standing `autocount-outbox.ts:1107`, `autocount-requeue.ts:1078-1085` |
| `ReleaseExpired(r)` | `releaseExpiredClaims` `autocount-claim.ts:79-85`, called at `autocount-outbox.ts:1331`; lease `AC_CLAIM_LEASE_MS` `autocount-claim.ts:18` |
| `MaxAttempts` | `MAX_ATTEMPTS = 6` `autocount-outbox.ts:111` |
| table | `backend/src/db/migrations-pg/0277_scm_autocount_outbox.sql`, `0315_ac_outbox_claim.sql` |

## Bounds and assumptions

- 2 dispatchers, 2 rows, MaxAttempts 6, at most 2 Worker kills per run.
- Time is not modelled. Lease expiry is a step that may happen (`ReleaseExpired`). In the passing config it happens only when no live dispatcher holds the row, which is what the lease comment assumes.
- Fairness: every dispatcher step and the lease release are weakly fair (the sweep runs every 5 minutes). Crash is not.
- The select and the claim are one step. That is sound because the claim re-checks status and holder; it does not re-check `attempts`, which only matters if a row is re-queued at the cap.

## Not covered

- The `waiting` outcome (parent has no AutoCount number yet). It sends nothing and burns no attempt.
- Re-queue (`requeueOutboxRow`), the archive, and `edit` / `cancel` replay semantics on the host.
- Company scope and the per-company write-back switch.
- Whether AutoCount refuses a duplicate DocNo (see Finding).

Last synced with the code at commit `efe17f8be92f12341e3443685ef0ea73b86f8f04`.
