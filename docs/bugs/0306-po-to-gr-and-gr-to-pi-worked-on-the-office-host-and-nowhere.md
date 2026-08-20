## PO-to-GR and GR-to-PI worked on the office host and NOWHERE ELSE — the fix existed only as a hand-patched build [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `/po-to-gr` had failed since 2026-08-12 with
`IndexOutOfRangeException: There is no row at position -1`, and `/gr-to-pi` had
never been attempted. On 2026-08-17 at 23:09 both succeeded on the live book —
`HC-GR-2608-001` (DtlKeys 908162 / 908164) and then `HC-PI-2608-001` (908167 /
908169), which put all six ERP document types into `AED_HOUZS` under the ERP's
own numbers for the first time.

**The change that did it was never in this repository.** It was edited into
`C:\Temp\acbuild-0817\AcSyncService.cs` on the host and compiled there
(`builtAt 2026-08-17T15:05:51Z`, `mvid ad2cad05-e817-4318-b4a0-1a4b6b2d8d03`,
103,936 bytes). `deploy-on-host.ps1` fetches its source from `main`, so the next
routine deploy would have compiled the OLD file, swapped it in, and taken
`/po-to-gr` back to the exception — with nothing failing and nobody looking,
because the deploy would have reported success. That is the bug this entry is
about: a working fix that only exists on one machine is a scheduled regression.

**Root cause of the original failure (traced, and the previously recorded cause
is REFUTED).** The GR arm's comment blamed `transferMaster: false` — "the GRN is
built with no supplier, the purchase detail constructor's master lookup returns
`-1`". The host log refutes it. Every failed attempt logged the flag as TRUE and
threw anyway:

```
2026-08-16 09:54:26   po-to-gr: fromType=PO transferMaster=true keys=[906268]
2026-08-16 09:54:26 ERROR /po-to-gr: System.IndexOutOfRangeException: There is no row at position -1.
```

The flag was never the cause. The cause is the sales side's cause, already
proven that morning: the TARGET had no account set when the transfer ran.
`AddPartialTransferDetail` reports that as a contentless throw; `FullTransfer`
names it. What actually moved the document was the typed three-argument
`FullTransfer(String[], TransferFrom, FullTransferOption)`, with the primitive
demoted to a `catch` fallback:

```
23:09:04   target creditor before transfer = [400-H004]
23:09:04   trying purchase FullTransfer from=HC-PO-2608-001 tf=PurchaseOrder
23:09:04   purchase FullTransfer OK
```

**Fix.** The host's block is transcribed into `AcSyncService.cs` in both purchase
arms, statement for statement, duplicated rather than factored — `doc` is a
different concrete SDK class in each arm, so a shared helper would need
`dynamic` and would replace the binding that is proven with one that is not.
`PurchaseHeader` keeps BOTH calls, before and after the transfer: the trailing
one is what makes the ERP's `DocNo` and `DisplayTerm` survive a transfer that
copies the source's master, it is what the working build ran, and it is
idempotent here because a conversion payload carries no UDF. Four assertions in
`autocount-writeback.contract.test.ts` now read those properties out of the C#
source, including the enum member `GoodsReceiveNote` — no `d`, unlike the SDK
class of almost the same name, which cost the first build a `CS0117`.

**One deliberate deviation from the host's bytes, and it is a guard.** The patch
assigned `doc.CreditorCode = Str(p, "CreditorCode")` unconditionally, and `Str`
of an ABSENT key is `""`. The host test supplied the creditor by hand, so that
line was never exercised without one; on any row that carries none it would
blank the account `SetMaster`'s book fallback had just read off the source
document and re-create the exact failure being fixed. It is now guarded on
non-empty, which is a no-op on the proven run (`400-H004`) and the file's own
idiom elsewhere.

**Divergence D15 CLOSED, and the reasons it was left open were both wrong.**
`enqueueConvert` now sends `CreditorCode` / `CreditorName` on `po_to_gr` and
`gr_to_pi`, and `dispatchOne` backfills them at drain for rows already queued —
the drain replays a stored payload and never recomposes, so an enqueue-only fix
strands everything in the queue (the `so_to_po` lesson from #2345). The recorded
blocker was that `scm.grns` and `scm.purchase_invoices` "carry no supplier
column, so a creditor needs a `grn -> purchase_order -> supplier` join". Both
tables declare `supplier_id uuid NOT NULL`. There was never a join to build; the
second stated reason — "`po_to_gr` has never succeeded anyway" — is why nobody
went and checked the first.

**Divergence D16 OPENED, and it is the unpaid price of this fix.** FullTransfer
moves EVERY outstanding line on the source, and this path runs when the ERP has
NAMED a subset. On the proven run the two sets were equal, so nothing was
over-received; a real partial receipt of 2 of 5 lines would write 5 into a
licensed account book. It is registered rather than fixed because the only shape
observed to work on this side is this one, and refusing returns `/po-to-gr` to
the state it spent a week in. Guide 7c4 names the two candidate closes, both of
which need the host.

**What is NOT proven by this PR.** Nothing here was run against `AED_HOUZS` —
the book and the log are on the office host and this is a source change. The
document numbers and log lines above are the host session's, recorded in
`backend/scripts/data/ac-live-proof.json` with that provenance attached. The
first real test of this file is its next `deploy-on-host.ps1` run, which compiles
before it swaps and keeps a hash-verified rollback; that guard already caught the
`GoodsReceivedNote` typo and left the running service untouched.

**Ref.** PR #2373, 2026-08-17.
