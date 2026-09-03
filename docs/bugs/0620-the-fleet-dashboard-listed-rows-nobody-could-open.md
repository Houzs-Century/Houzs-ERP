## The fleet dashboard listed rows nobody could open [high]

<!-- area: Fleet, trips, TMS -->

**Symptom.** A maintenance record — a compliance document, a plan, a breakdown
case, a work order, a component — appears on the Fleet Health dashboard, and
clicking it answers **not found**. On screen, not openable, not editable, not
deletable, no explanation.

**Root cause (traced).** `GET /fleet-maintenance/dashboard`
(`fleet-maintenance.ts:574-587`) read `lorry_compliance_documents`,
`lorry_maintenance_plans`, `lorry_breakdown_cases`, `lorry_work_orders` and
`lorry_work_order_parts` with **no company predicate**, while **twelve** by-id
handlers on those same tables called `scopeToCompany`. Two answers to one
question, and the list won the argument on screen while the detail won it on the
click.

**The file predicted this in its own words.** `fleet-maintenance.ts:186-198`
carries a `company-scope-file:` marker stating the module is a UNIFIED FLEET,
citing migs 0202 / 0203 / 0204 / 0238 — each of which says `company_id` is
*"STAMPED on insert for provenance but NOT used to scope reads"*, *"one shared
lorry fleet across ALL companies"* — and ending:

> *"scoping only the WRITERS would leave the dashboard listing a row that
> PATCH/DELETE then 404s."*

That is exactly what had happened. **The note was right and the code had drifted
from it: a marker that states the intent is not a marker that enforces it.**

Two docs then disagreed with each other and with the code —
`MULTICOMPANY-MODULE-MAP.md:204-215` said the module's own records were
**SEPARATE** (a 2026-08-13 correction from the unscoped-write sweep, which
recorded the unscoped LIST reads as *"open and tracked"*), while
`MULTI-COMPANY-SCOPE-MODEL.md:67-71` said CENTRALISED, provenance-only. One
in-file comment said the opposite of the marker eight lines from a
`scopeToCompany` call: *"the renewal record itself is per-company"*.

**Which way it settles was NOT a reading of the tree.** Both directions are small
diffs and they point opposite ways: scope the dashboard (narrow), or unscope the
twelve (widen who can edit what). Widening access on the strength of a migration
header is not a change to make without the owner, so it was reported and left.

**Owner ruling, 2026-09-02**, asked directly:

> 「共用的，因为 TMS 是共用的。这个东西 TMS 就像我们的运输公司一样」

One transport company, one fleet, one set of maintenance records.

**Fix.** The twelve `scopeToCompany` calls are removed from the by-id handlers on
`lorry_compliance_documents`, `lorry_compliance_attachments`,
`lorry_maintenance_plans`, `lorry_breakdown_cases`, `lorry_work_orders`,
`lorry_work_order_parts` and `lorry_components`. The dashboard is unchanged — it
was already right.

Verified consistent before changing anything: the lorry master itself
(`inHouseLorries`, `:183`) and `drivers` carry no company predicate either, so
the records now match the vehicles they hang off.

**What did NOT change, and both are deliberate:**

- **`company_id` is still STAMPED on insert.** The migrations require it for
  provenance; unscoping reads is not the same as dropping the column, and the
  test pins the stamp so nobody "tidies" it away next.
- **`scm.workshops` stays per-company** (mig 0241) and keeps its
  `scopeToCompany`. It is the repair-shop MASTER, not a maintenance record; the
  ruling was about the records and was not asked about workshops. Its two
  handlers were separately repaired in
  `docs/bugs/0618-a-nullable-company-id-in-eq-matched-nothing-and-minted-dupli.md`,
  where the hand-rolled `.eq("company_id", … ?? null)` matched nothing.

**Test.** `backend/tests/fleetMaintenanceUnifiedScope.test.ts` — a source scan,
because the defect is not what one handler answers but TWO handlers on one table
disagreeing, which is a property of the file. It pins: no shared table is
company-scoped, workshops still is, `company_id` is still stamped on insert, and
its own matcher is alive. Proved RED by putting one `scopeToCompany` back on
`lorry_components`.

**The three documents that disagreed are corrected in the same change** — the
file marker (which now records that the code had drifted from it, and what
settled it), `MULTICOMPANY-MODULE-MAP.md` and `MULTI-COMPANY-SCOPE-MODEL.md`. The
2026-08-13 correction is marked SUPERSEDED rather than deleted: its reasoning was
sound and only its answer was wrong.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
