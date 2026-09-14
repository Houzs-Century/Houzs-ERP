# Handoff — 2026-09-13 (evening)

Supersedes `HANDOFF-2026-09-13.md` for anything they disagree on. Everything here
is either PROVEN with the command that produced it, or labelled UNKNOWN.

---

## 1. Two production incidents today, both mine, both restored

### 1a. Clearing every option pool deleted configuration (0855)

`open-model-option-pools` removed nine keys from `allowed_options` on **421
Models across both companies**, on the premise that a pool is a RESTRICTION. That
is false for two of them: for MATTRESS and BEDFRAME, `allowed_options.sizes` is
"the SINGLE source of truth for ON/OFF" (`product-models.ts` PATCH `/:id`), and
`mattress_thickness_cm` has no other home.

**RESTORED**, production run 34742018114:

```
APPLIED: 421 Model(s) restored.
VERIFIED on a fresh connection: 421 Model(s) match the backup exactly, 1329 pool(s) back in place.
```

Then confirmed live: 113/113 BEDFRAME and 187/187 MATTRESS carry their `sizes`.

Full account: `docs/option-pool-clear-coe.md`.

### 1b. The 2990 POS lost every sofa colour (0858)

`open-model-fabric-pools` (earlier, PR #3743) cleared `allowed_options.fabrics`
on every SOFA Model, "every company". **The 2990 POS reads that field as the
SOURCE, not as a filter** — `fabrics ?? []` turns an absent key into an empty
array, and `buildFabricSeriesRows` BUILDS the series chips from it. Its own
comment: *"Empty -> 'No fabrics enabled'."* So the whole colour control vanished
and 2990 could not configure a sofa.

**RESTORED**, production run 34747283542:

```
BACKUP written: 17 model(s), 3885 bytes.
APPLIED: 17 SOFA Model(s) now offer every active colour.
VERIFIED on a fresh connection: all 17 SOFA Model(s) hold 58 colour(s).
```

Confirmed through the POS's own endpoint — `GET /pos-pools/mfg-catalog?baseModel=Annsa&category=SOFA`
with `X-Company-Id: 2` now returns 58 `allowed_options.fabrics`.

**His own ticks are now RESTORED** (each Model was ticked to 28 or 36, not all 58).
`scm.product_fabrics` proved empty for company 2 (run 34765055452:
`product_fabrics rows for this company: 0`). The 2990 SOURCE system still held
them (run 34765704752: 16 of 17 SOFA Models at 28/36, every colour id active here).
`restore-2990-fabric-ticks-from-source.mjs` (PR #3793, ledger 0871) put them back;
staging then production, production run 34766567177:

```
BACKUP written: 17 model(s), 13766 bytes.
APPLIED: 16 SOFA Model(s) restored to their source ticks.
VERIFIED on a fresh connection: 16 Model(s) hold exactly their source pool as a JSON array (... PANTTI=36, the rest 28).
```

A second plan run (34766609171) reported `Models to restore: 0`. MAKOTO has no
pool in the source and keeps all colours. Undo: write back
`scm.app_config['scm.sofa_fabric_pools_before_source_restore']`.
**Not yet seen on the POS screen** — the Chrome extension was disconnected; the
database state is what was verified. What it cannot prove: a tick changed inside
the ERP after migration would not be in the source.

"56" explained: `scm.fabric_colours` has 58 active rows for company 2 but 56
distinct colour ids — two ids appear under two series.

---

## 2. THE thing to understand before touching `allowed_options` again

That one column is read by clients that disagree about what an EMPTY pool means:

| reader | empty means |
| --- | --- |
| our line editors (`SoLineCard`, `restrictStringsToPool`) | no restriction — offer everything |
| our save gate (`allowed-options-check.ts`, `hasRestriction`) | no restriction — accept anything |
| **the 2990 POS** (other repo, `wenwei4046/2990s`) | **nothing available** |
| Modular editor + "Add codes" (`ProductModelDetail.tsx`) | the pool IS the configuration |

The POS reaches it through `GET /pos-pools/mfg-catalog`, which selects
`product_models(..., allowed_options)`. `routes/pos-pools.ts` carries a banner
saying it has an external consumer and to grep the POS repo first. The local
clone is `Desktop\2990s-Portal\2990s`.

**Enumerate the readers — in BOTH repos — before changing that column.**

---

## 3. Shipped today and live on production

Sixteen PRs. The ones that change what staff see:

| | |
|---|---|
| 0846 | one rule for whether a line is free; four surfaces had four answers |
| 0847 | the change log four documents kept but nobody could read |
| 0848 | a change log that could not load said "No history yet" — fixed on all six plus the SO |
| 0849 | FOC on the purchase side too |
| 0850 | the delivery order shows the money already taken on its order |
| 0851 | the confirm rung reads **Submitted** on SO / PO / GR / PI / SI |
| 0852 | the discount hint no longer makes every line ragged |
| 0853 | **Add line** reachable from the page you start on, on four documents, one shared word |
| 0854 | the phone's order-slip photo is visible on the desktop order |
| 0864 | the sales order reads **In Production** on the tab AND the pill (his choice) |

Guards added, which is the more durable half:

- `frontend/src/vendor/scm/lib/entity-audit-queries.test.ts` — the frontend's list of auditable document types is compared against the backend source.
- `frontend/src/components/audit/auditHistoryPanelError.test.tsx` — no change log may report a refusal as emptiness; scans every mount.
- `frontend/src/vendor/scm/lib/addLineHandoff.test.ts` — every detail page offers Add line and every editor consumes the handoff.
- `frontend/src/vendor/shared/pickerAgreesWithSaveGate.test.ts` — the SO/PO picker and the save gate cannot drift apart (they are two hand-copied implementations under different names, invisible to `check-shared-mirrors`).
- `frontend/src/pages/scm-v2/localStatusMapsAgree.test.ts` — every page's own status map against the canonical one. **Found 7 live disagreements on its first run**; 3 fixed, 3 recorded as deliberate with their authority, 1 put to the owner and since decided.

---

## 4. Background work — state at handoff

| what | state |
|---|---|
| Sales invoice: add a line (desktop) | MERGED #3787, deployed (run 34764719140); ledger 0870 |
| Collapse status maps onto `status-pill.ts` | 6 of 18 pages in #3792 (queue); follow-up: detail hero badges read "Posted"/"Sent" against the 2026-09-12 "Submitted" ruling — agent fixing, ledger 0868 |
| Mobile parity: direct create PO/GR/PI + rack lookup | in progress, ledger 0867; then mobile Add line (no mobile surface has it) |

---

## 5. Owner actions — nobody else can close these

1. **Staging's Worker holds the staging project's ANON key**, not its
   `service_role` key. Staging `/health` says `rest_role: anon`; production says
   `service_role`. Staging reads fail with `permission denied`, the rehearsal has
   been red since 2026-08-21, and staging QA under-reports. Fix: copy the
   `service_role` key for project `minnapsemfzjmtvnnvdd` and
   `wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging`. Production is
   unaffected. `docs/bugs/0824-the-staging-rehearsal-had-been-red-every-night-since-2026-08.md`.
2. ~~**A repo-level `STAGING_DATABASE_URL` points at PRODUCTION.** Same entry.~~
   **Already closed when this was written** — deleted 2026-09-12; on 2026-09-14
   `gh secret list` shows no repo-level copy, only the Staging environment's.
3. **Look at one 2990 sofa on the POS** (e.g. Annsa) and confirm it offers his 28
   colours, not all of them. Only needed because the browser check could not run.
4. **The option-pool question**, framed properly this time: the same column holds
   RESTRICTIONS (`fabrics`, `specials`) and CONFIGURATION (MATTRESS/BEDFRAME
   `sizes`, `mattress_thickness_cm`). Recommendation: clear only the
   restriction-shaped keys; never the configuration ones. The long-term fix is to
   split the column.

---

## 6. Known gaps, named so they are not rediscovered

- **The delivery order adds lines on its create screen**, not through an editor,
  so it is not on the Add line handoff.
- **`delivery_order_payments` is built and unwired on purpose** — recording a
  payment on the delivery would double-count against the order's outstanding.
  `docs/bugs/0850-the-delivery-order-never-showed-the-money-already-taken-on-i.md`.
- **Sixteen pages still declare their own status map.** Guarded now; the collapse
  is the agent above.
- **Consignment orders keep "Proceed"** for their own `IN_PRODUCTION`. The owner
  named the sales order; the consignment order is a different document.

---

## 7. The lesson both incidents share

Both came from taking a rule that is TRUE at the one consumer I could see and
applying it to every key and every company. In the first case the second reader
was in this repository (`product-models.ts`); in the second it was in another
one, behind an API whose own file said so.

**Before changing a shared column: enumerate its readers. One `git grep`. It
takes a minute and would have prevented both.**
