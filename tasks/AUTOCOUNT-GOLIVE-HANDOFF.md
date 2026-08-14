# AutoCount cutover — go-live handoff

## PAUSED until Friday. Staff stay on AutoCount.

Owner's call, 2026-08-11: *"不行了，让他们继续用 autocount 先，我们星期五再继续做."*

The ERP is **not** the system of record and nobody has been moved onto it. Company 1
is frozen (`scm.write_freeze = '1'`, every area, 0 areas lifted), the write-back is
off (`scm.autocount_writeback = 'off'`), and `scm.autocount_outbox` holds **0 rows**
— not zero pending, zero rows, so no ERP document has ever been offered to
AutoCount. That is the intended state. 2990 (company 2) is unaffected and trades
normally.

**`AC_SYNC_URL` IS set** — corrected 2026-08-12. This banner said "unset", which
contradicted this file's own §"Two gates verified shut" and step 4 below. PR #2030
set it at `backend/wrangler.toml:42` (`https://autocount.houzscentury.com`).
Re-verified the same day: an unauthenticated `POST /health` answers
`401 {"ok":false,"error":"bad key"}` — the tunnel is up and the service is running.
**The DB toggle is now the only gate holding**, which is why the zero-row outbox
above is the number that matters.

**Do not lift anything without the owner.** His standing instruction:
*"解冻我跟你说你才做."*

> ### Resuming on Friday? Read `docs/autocount-migration-record.md` first.
>
> That is the record of the whole migration and it carries the **Friday execution
> runbook** — a numbered, strictly-ordered checklist where every step names who does
> it, how you know it worked, and how to undo it. It also carries the three things
> that exist nowhere else in this repository: the state of the office host right now
> (the running `AcSyncService.exe` is a temporary self-test build and must be
> replaced), the `tempdb.ac_src_bridge` channel that moves source to and from that
> host without a remote desktop, and why runbook 4.1-4.5 have not passed —
> `AED_TESTING` has exhausted its 500-transaction evaluation limit, and the live book
> enforces master-data foreign keys the test book does not.
>
> This file stays the index. That file is the instruction.

---

Status as of 2026-08-11. This is the index: one place to see where the cutover
stands against the owner's own acceptance criteria, what landed, and what is
still owed. Every number here came from a production read, not from a script's
own log line — see *The three things that were wrong about what we believed*
below for why that distinction is load-bearing.

## Where this actually stands, 2026-08-12 01:45

The service on the office host was **rebuilt from current `main` and swapped**,
and five coverage cells went from never-run to PROVEN against the live
`AED_HOUZS` book. What is left is small, named, and no longer needs anybody
standing at that machine except to run one command.

| | |
|---|---|
| Running exe | rebuilt 2026-08-12, 46,592 bytes, `/health` names `AED_HOUZS`, **database reachable** (`/ensure-masters` 200, and it read `agent:OTHERS` + `location:KL` back out of the book) |
| Rollback | `C:\Temp\AcSyncService.prev.exe` |
| PROVEN | `create-so`, all four `/edit` guards, `so-to-do` (**DO-011260**, cancelled), `cancel` SO + DO |
| BLOCKED | `create-po` and therefore `po-to-gr` — `FK_PO_PurchaseAgent`. **Fixed in code, NOT yet on the host** |
| Write-back toggle | still `off`; `scm.autocount_outbox` still holds **zero rows of any status** |
| Freeze | still on, every area — **and it does not need lifting.** The bypass works (`write-freeze.ts:244`, `BYPASS_PERMS = ['*','scm.admin']`); the owner's position is Super Admin, which `auth.ts:383` grants `*`. He and Nico write through a fully frozen system |

**The remaining sequence, in order.** Only step 1 touches the office machine.

1. Redeploy the service with the master-data fix:
   `powershell -ExecutionPolicy Bypass -File deploy-on-host.ps1 -Server ".\A2006"`
   The `-Server` matters: `setup.json` says `192.168.1.198\A2006`, which this host
   does not resolve, and it names database **`AED_DEMO`** — neither value can be
   trusted, and the script now warns about the second.
2. Re-run `qa-convert.ps1` to close `create-po` and `po-to-gr`.
3. **Set `AC_SYNC_KEY` on the Worker** — `cd backend && npx wrangler secret put
   AC_SYNC_KEY` (the owner or IT types the value directly; never through chat).
   **This step was MISSING from this sequence and it is not optional.** Read
   from both sides' code on 2026-08-12: the Worker sends `X-API-KEY` only when
   the secret exists (`callAcService`, `services/autocount-writeback.ts:26` —
   `...(cfg.key ? { 'X-API-KEY': cfg.key } : {})`), and the host refuses
   everything without it (`AcSyncService.cs:161-162` — no key configured means
   **503 for every request**, wrong key means **401**). `acServiceConfig`
   treats the key as optional (`:775-780`, URL alone activates the drain), so
   with the toggle on and the key unset, every real order drains into 401/503,
   burns its 6 attempts, and lands FAILED — and there is still no outbox UI to
   re-queue it.
4. Turn the write-back on — Actions, **AutoCount write-back (on/off)**, `state=on`,
   `companies=1`. **Before anyone creates a document, not after**: the flag is
   checked at enqueue, so anything saved while it is off is never sent and cannot
   be backfilled.
5. One real order, watched into the outbox.

## The owner's acceptance criteria

He set these himself. Nothing ships until all three pass.

1. **Every document type syncs to AutoCount** — SO, PO, DO, GR, PI, SI — on
   **create, convert AND edit**.
2. **Compartment and variant aligned** on SO/PO, *and the relationships between
   the documents aligned too*.
3. **Stock** — (a) Stock Balance Record reconciles; (b) AutoCount **Remark 2**
   (his stock status field) reconciles with ERP stock status, with a *cause* for
   every disagreement.

He later narrowed the go-live gate: **SO + PO, create + edit** is enough to open;
DO/GR/PI/SI and convert can follow. Stock checked first makes it "more accurate".

### Four hard rules

- **不可以删，只可以 cancel.** Nothing is ever DELETED — not a document, not a
  line, not a stock movement. This forbids implementing an edit as
  delete-and-recreate (which also destroys AutoCount's own document links and
  audit trail), and forbids fixing a duplicated stock movement by removing the
  duplicate: use a compensating reversal that nets to zero.
- **暂时只可以在 ERP 改.** The ERP is the only editing surface for now, so sync is
  ONE-WAY with the ERP as master. This removes bidirectional conflict resolution
  from v1 — but staff will edit in AutoCount out of habit, so drift detection is
  still required.
- **Cancel must not diverge.** Acceptance test: after a cancel, the owner's
  outstanding rule (not converted to DO and not to IV) computes *identically* on
  both sides.
- **ZeroTier is the transport** and the only mitigation is keeping it up. Design
  for that, but a save that succeeds in the ERP while its sync is silently lost
  must be impossible.

---

## Criterion 1 — document sync

**FAIL: built, gated shut, not wired.** The corruption path is closed, which is
the part that mattered most.

| | |
|---|---|
| The write-back stack | `#1855` merged — outbox (migration 0277), six enqueue hooks, drain cron, toggle, downstream lock |
| Keyless-line guard | `#1935` + `#1945` merged. An edit whose lines carry no AutoCount identity is **refused**, not appended |
| Line identity in prod | SO **12,910 / 13,909** (92.8%), PO 275 / 864. **2,316 of 2,723 SO** and 127 of 449 PO are fully covered, i.e. editable |
| The tunnel | **DONE 2026-08-11 and PROVEN.** `autocount.houzscentury.com` fronts `localhost:8900`; `/health` answers `{"ok":true,"book":"AED_HOUZS"}` from an ordinary workstation, and runbook 4.1-4.5 plus cancel all passed over it on `ZZERP-0001` (left cancelled in the book — do not delete). `AC_SYNC_URL` and the `AC_SYNC_KEY` secret are set. **Any Claude session that reports "this machine cannot reach the service" is reading the pre-repoint state of this file** — see the migration record, Step 3 |
| Still needed | The C# service REBUILT on the host: the running exe predates `/ensure-masters` and the fail-closed auth. Nothing has been driven from an ERP save — the toggle is still `off` and the outbox still holds zero rows |

**Two gates verified shut, and the third is now OPEN — re-read 2026-08-11.**
`AC_SYNC_URL` is **set and uncommented** at `backend/wrangler.toml:42`
(`https://autocount.houzscentury.com`), so the sentence this paragraph used to
carry — "commented at line 34" — is no longer true and must not be quoted.
What still holds: migration 0277 seeds `scm.autocount_writeback = 'off'`, and
`callAcService` has one non-test caller, reachable only from
`drainAutoCountOutbox`. **The toggle is now the only thing holding**, and the
live proof is that `scm.autocount_outbox` holds **zero rows of any status** —
not zero pending, zero rows, so nothing has ever been enqueued
(`autocount-outbox-health`, run 31501435043).

**What was nearly shipped.** `create` returned only the document number, never
the line DtlKeys, and `edit` appends when it cannot find a key. So creating a
document and then editing it would have **appended a duplicate set of lines into
the live account book** — precisely the pair the owner named as his gate. On a
purchase order those duplicates could never be removed, only zeroed, because the
SDK has no `DeleteDetail` for `PurchaseOrder` at all.

~~Open: adding a line is refused~~ **Closed 2026-08-11 (#2003), for SO only**:
`composeEdit` now sets `IsNewLine` when the inserting route declares the new
row ids AND every other line on the document is already keyed (guard read in
`services/autocount-writeback.ts` on 2026-08-12); PO and the four downstream
types still refuse keyless lines. Still open: no API or UI for the outbox.
Coverage matrix and build plan: `docs/autocount-sync-coverage.md` (PR #1931).
(PR #1931).

## Criterion 2 — compartment and variant

**PARTIAL, and much better than the first measurement said.**

| | PO sofa | SO sofa |
|---|---|---|
| Compartment | **213 / 219** | **262 / 272** |
| Seat size | 191 / 219 | 253 / 272 |
| Colour | 175 / 219 | 216 / 272 |

The category "no compartment at all" is **empty** — no sofa line anywhere lacks
a compartment or carries an unminted SKU. Six real defects remain, on
`HC-PO-009469` and `HC-PO-009596`.

Chain alignment (`docs/sofa-document-chain-map.md`, PR #1933): **company 2 is
clean on all four legs.** Company 1 carries **0 wrong item codes on every leg**;
SO→PO piece-set mismatches went 8 → 2 after link repair, and both survivors are
correct outcomes (one refused to guess between two identical candidates, one is
a genuine short order). PO→GRN holds 79 differences that are legitimate history
— the PO was corrected after receipt — and must not be rewritten.

**The root cause of the whole variant mess.** `refresh-so-variants.mjs` keyed its
parsed-Desc2 lookup on `${DocNo}|${itemCode}`, which is not a line identity. An
order with three lines of the same SKU in different colours collapsed to one
entry, and the last row's parse was stamped onto all three. 183 keys collide,
298 lines affected. The purchase-order arm escaped only because a *received* PO
is not "outstanding" and so fell through to a per-line fallback — that accident
is the entire reason AutoCount's Desc2 appeared to "back the PO". Fixed in
`#1958`; both arms now key on `DtlKey`, which was in the export the whole time.

## Criterion 3 — stock

**Balance reconciles with every delta explained. Status axis moved and is still
moving.**

| | |
|---|---|
| Per-warehouse agreement | **917 of 976 cells (94%)**; 8 of 15 warehouses agree to the unit |
| Did the import dump everything into KL? | **No** — ERP KL 52% against AutoCount's 51%, 15 of 16 warehouses hold stock |
| `warehouse_id` correctness | 13,837 verified against AutoCount (7,800 on exact DtlKey), **0 miswarehoused**, 70 undetermined and left NULL |
| Sofa readiness | READY **0 → 70**, PENDING 272 → 202, lots with `batch_no` 0/20 → **103/123** |
| Status-axis disagreements | 151 → **126** |

**Every remaining unit of the +157 net delta sits in a named class**: 83
migration cut-off, 50 AutoCount negatives, 14 the known double-ship, 13 present
at seeding. Nothing is unexplained, so the owner's "by right they should agree"
premise holds.

**Remark 2 is `SO.Remark2`**, nvarchar(40), on the AutoCount SO *header*,
non-blank on 9,165 orders — and the mapping is an **identity** mapping, because
`so-readiness.ts` was written to reproduce that convention. The trap: the tokens
name what IS ready, not what is pending. Full detail:
`docs/stock-reconciliation.md`.

---

## The three things that were wrong about what we believed

Each was caught by measuring instead of reasoning. They are recorded here
because the pattern matters more than the individual facts.

1. **"The unique index on `inventory_movements` does not exist."** It does — four
   partial unique indexes, DDL ported from 2990 by hand and present in **no file
   in this repo**, which is why the migration reads as if none existed. The code
   comment was telling the truth. *Verify schema claims against the live database,
   not migration files.*
2. **"A backfill introduced a truncation."** It did not. The fabric library holds
   both `BO315-5` and `BO315-5-FOSSIL`; there are 56 bare-vs-named duplicate
   pairs across 7 series and only one document pair actually disagrees. The
   remedy is library de-duplication, not loosening a matcher — loosening is
   exactly what the digit guard exists to prevent.
3. **"604 array-shaped `custom_specials` rows are corrupt and should be nulled."**
   679 of their 694 strings are live picker codes, the derived cache agrees with
   its source on all 604 rows, and the renderer handles both shapes on purpose.
   Nulling would have deleted a correct, currently-rendering line item from 604
   historical documents.

And one that was real and worse than diagnosed: `refresh-so-variants.mjs` and
`refresh-po-variants.mjs` rebuilt `variants` from a fixed key list *and
recomputed specials through a mapper with no price guard*. Dispatching either
would have shrunk the specials backfill **and repriced historical migrated
documents** — the thing the owner ruled out. Fixed in `#1949`: the sweeps now
compute a patch and merge with `variants || patch` in the database, so a
thirteenth key survives by construction.

## Two bugs of the same class, one COE

Binding `JSON.stringify(value)` to a `$1::jsonb` parameter through postgres.js
encodes it twice, lands a jsonb string scalar, and then `object || non-object`
**concatenates into an array** instead of merging. `->>'key'` on an array is
NULL, so the guard re-admitted the same row every run — and `UPDATE 1` was
perfectly true, so `res.count` answered the wrong question and the script
reported success three times while corrupting the column.

`docs/jsonb-double-encoding-coe.md` exists because the class was found earlier
the same day and **documented rather than fixed**, which is how it reached a
third script hours later. The API path was never affected:
`pg-supabase-transaction.ts` routes every jsonb value through `sql.json()` and
its comment already named the trap.

---

## What still needs the owner

**Re-verified against the tree on 2026-08-12 — three of the seven were already
decided and SHIPPED on 2026-08-11.** Each closed row names the PR that closed
it: the previous version of this list was still answering "open owner decision"
for work already in production.

**Still genuinely open:**

| # | Decision |
|---|---|
| 1 | **Fabric library** — the individually ambiguous codes still need his call: `03#Straw` (HIRRING GD8371-03 or HIVE GD2034-03?), `J9833-2` (mistyped `J9883-2 CHIC`?), `Beetex harring gd 8371` (which of 10?), `ZanoLeather` (which ZL?), `GD8371` vs `HIRRING GD8371` (which survives?). The BULK half of this row is done: the merge tool shipped (#1972) and RAN six times on 2026-08-11 (last: run 31461314399), plus fabric repairs #2018 #2032 #2033 #2035 #2036 #2038 #2047 #2061. That final run's plan also surfaced one more decision this table did not have: **`NX` vs `NX016`** share zero colour codes so the detector cannot merge them — owner call |
| 4 | **"Seat Softer"** (7 instances) — the direct opposite of the existing `Seat Firmer`, currently with nowhere to go. Create it? (No trace in the tree — verified by grep, 2026-08-12) |
| 6 | **`HC-SO-012949`** — a customer ordered a super-single `CODY-(S)` that was never put on any purchase order. Raising it is a commercial act. (The link-repair workflow explicitly excludes this order and says why — `repair-po-so-links-autocount-text.yml`) |
| 7 | **The 27 held-back specials lines** keep their instructions as free text with no picker tick, matching his own fallback rule. Accept, or build migrated-immunity in the money path? (Still open — `docs/autocount-migration-record.md` section 9) |

**Closed since this list was written — decided and shipped 2026-08-11:**

| # | Was | Outcome |
|---|---|---|
| 2 | Should the ERP charge for special add-ons at all? | **CHARGE.** #1973: `chargeableSurchargesSen` reaches the customer price on every non-migrated line (`scm/lib/mfg-pricing-recompute.ts`), pinned by `mfg-pricing-recompute.surcharge.test.ts` — the 12 tests were RUN green on 2026-08-12, not just located. Migrated lines are structurally immune |
| 3 | HYDRAULIC — this row said "must not become a `special_addons` code" | **It became exactly that, at the owner's own later instruction** ("开 special order 那边勾选") — same PR #1973 plus `seed-hydraulic-special-addon.yml`, price seeded 0 so it charges nothing until he prices it. **Applied to prod**: run 31454564942 (2026-08-11 03:09) — `APPLIED — 1 inserted`, read back on a fresh connection as `[Hydraulic] categories=BEDFRAME active=true sell=0 cost=0`. The constraint recorded here was overtaken by his ruling |
| 5 | 18 duplicate DO lines — add a cancel column, or qty-0 with an audit note? | **Option B: qty-0 + audit note, nothing deleted.** #1971 + `zero-duplicate-do-lines.yml`. **Applied to prod**: run 31451705673 (2026-08-11 02:13, mode=APPLY) — surplus lines zeroed and, in the run's own words, `VERIFIED on a fresh connection: quantities zeroed, notes present, every other column and every document total unchanged` |

## Sequence to go live

**The executable version of this, with a verification and a rollback beside every
step, is the Friday execution runbook in `docs/autocount-migration-record.md` section 1.
Follow that. This is the summary.**

1. **Freeze stays ON.** It is already per-company (`value` is a company id list,
   which is why 2990 never stopped trading). Per-module staging now exists
   (`set-write-freeze`, PR #1967) and **zero areas have been lifted**.
2. Finish criterion 3 residue, then criterion 2 residue.
3. Rebuild the clean service on the office host from the SQL bridge, and run
   runbook 4.1-4.5 against the live book on a throwaway document — cancelled, never
   deleted. Neither has happened yet.
4. ~~Stand up the tunnel and set `AC_SYNC_URL`~~ — **DONE** (PR #2030; tunnel
   verified answering 2026-08-12). What remains of this step is `AC_SYNC_KEY`, the
   Worker secret, which cannot be confirmed from outside the account — check it with
   `wrangler secret list` before step 5, not by assuming.
5. Turn on `scm.autocount_writeback` for company 1.
6. Lift the freeze for `scm.sales.orders`, company 1 only, one pilot cohort,
   and watch a document reach AutoCount.
7. Widen one area at a time.

The freeze lift is last because it is the only step that is hard to reverse:
once staff edit, rolling back means reconciling human work, not re-running a
script.

## See also

- `docs/autocount-migration-record.md` — **the record and the Friday runbook.** How the
  migration was done, what went wrong, what to do next, in order
- `docs/autocount-cutover-ledger.md` — the chronological run log, W0 to W18
- `docs/write-freeze-staged-lift.md` — the freeze grammar, the area table, the rollback
- `docs/autocount-service-deploy.md` — build and deploy on the AutoCount host
