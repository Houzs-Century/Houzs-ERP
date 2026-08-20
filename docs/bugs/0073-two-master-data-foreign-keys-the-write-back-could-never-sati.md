## Two master-data foreign keys the write-back could never satisfy [high]

**Symptom** - on the live book, `/create-po` returns a bare 500 and the whole
purchase order is lost. Separately, opening a brand-new SKU fails, so the first
ERP document naming a new product would never reach AutoCount. Neither is
visible in the HTTP response: both are `500`, and the constraint name only
exists in `C:\Temp\ac-sync-service.log` on the host.

**Root cause (traced, not guessed)** - two different foreign keys, one shape.

1. **`FK_PO_PurchaseAgent`.** A purchase order's agent lives in
   `dbo.PurchaseAgent`, a **different master** from the sales agent, reached
   through a different SDK command. `ensure-masters` only ever opened SALES
   agents, so it reported `agent:OTHERS` as **already existing** while
   `/create-po` was being refused on that very value - the report was true and
   irrelevant. Found by reading the service log after the QA run of 2026-08-12;
   `AutoCount.GeneralMaint.PurchaseAgent.PurchaseAgentCommand` was found by
   reflecting the installed assemblies, because `sdk-api-reference.txt` does not
   mention PurchaseAgent at all.
2. **`FK_Item_ItemGroup`.** `ItemGroup` is a foreign key, not a label. The
   importer set it from the payload and the payload never carries one, so every
   new item was refused. Proved by calling `/ensure-masters` twice: the same
   item fails with `FK_Item_ItemGroup` and then succeeds with a group supplied.

**Fix** - `ensure-masters` accepts a `PurchaseAgents` list and opens it through
`PurchaseAgentCommand`; `mastersOf` routes the agent by whether the payload
carries a `CreditorCode`, which is the one field only a purchase document has.
Items default to `ItemGroup = OTHER`, which exists in `AED_HOUZS` for exactly
this. Three regression tests cover the routing. The whole foreign-key chain, and
the values known to exist, are now in `docs/modules/autocount-writeback.md`
section 7m so the fifth one is a lookup rather than another discovery.

**What this is really about** - these are the **third and fourth** foreign keys
found this way, after `FK_SO_SalesAgent` and `FK_SODTL_Location`. Each was
invisible until the previous one was satisfied, so every "fixed it, retry" bought
exactly one attempt. The evaluation book enforced none of them.

**Lesson** - **"the master exists" is only true about the master you asked
about.** A sales agent and a purchase agent share a name, a meaning and nothing
else. When a lookup says a dependency is present and the dependent call still
fails, check that you looked in the same table the constraint points at.

**Ref** - `fix/ac-deploy-verify-db`, 2026-08-12

---
