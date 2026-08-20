## The AutoCount write-back never told AutoCount who sold the order [high]

**Symptom** — the ERP -> AutoCount write-back went live on 2026-08-13. Two
re-queued sales orders retried four times each and the live `AED_HOUZS` book
answered, verbatim:

```
Foreign Key Error (Constraint Name=FK_SO_SalesAgent)
```

Nothing landed in the account book, so there was no residue to clean up — the
foreign key rejects the document before it is written.

**Root cause (traced, not guessed)** — `composeCreateSo` read
`mfg_sales_orders.agent` and nothing else. That column is legacy free text
filled only from `body.agent`, and **no SO form sends `body.agent`** — not
`SalesOrderNew.tsx`, not `MobileNewSO.tsx` — so it was empty on every order
created since the cutover. An empty Agent reaches AcSyncService as `""`
(`Set(() => so.Agent = Str(p, "Agent"))`; `Str` turns an absent key into the
empty string), and `""` is not a row in `dbo.SalesAgent`.

`/ensure-masters` could not save it either, which is the part worth
remembering: `mastersOf` only emits an `Agents` entry when `body.Agent` is a
non-empty string, so an empty agent opened nothing, the call returned `ok`
because it had nothing to do, and the create then died on the foreign key.

The ERP's real salesperson identity was one column along the whole time —
`salesperson_id` -> `scm.staff`, stamped at create as `salespersonIdToStamp`.
**The UI hid the gap for months:** `SalesOrderDetailV2.tsx` renders
`salespersonNameOf(salesOrder.agent, salesOrder.salesperson_id)`, which falls
back to the id, so a name appeared on screen while the column behind it was
empty.

**RULED OUT — a failed master-open.** The first theory was that
`/ensure-masters` had tried and failed and the drain sent anyway. It cannot
happen: `EnsureMasters` returns `{"ok": failed.Count == 0}` and the drain turns
`ok:false` into `masters not opened, document not sent`. The observed error was
the FK on `/create-so`, not that — so the agent was never in the payload at all.

**Fix** — both halves, because either alone leaves a hole:

1. **At the source.** `scm/lib/so-agent.ts`'s `soAgentToStamp` fills `agent`
   from the stamped salesperson's `scm.staff.name` when the caller supplies
   none, at all three create stamp sites (header, goods lines, SERVICE lines)
   and again on the header PATCH when the salesperson is reassigned. An
   explicit `body.agent` still wins; a blank one is not a supplied one.
2. **At compose, for the orders that already exist.** `resolveAcAgent` falls
   back to the salesperson behind `salesperson_id`; `SO_HEADER_COLS` carries the
   column and `readSalespersonName` turns the id into the name beside the other
   header reads, the same division `withLocations` draws for the line warehouse.
   A name `AGENT_MAP` does not know is sent as itself and opened by
   `/ensure-masters` — D10's 2026-08-13 rule applied to people, since the map is
   a snapshot of the book's spellings and not an allow-list.

The create's `scm.staff` read is the venue chain's read: `readStaffForStamp`
returns `{name, venueId}` off one row, where the router was two statements away
from fetching the same row twice. That also pays for the new lines under
`scripts/file-size-ceilings.json`, which lets `mfg-sales-orders.ts` only shrink.

**With BOTH empty the create is REFUSED** (`MissingAgentError`, a visible
`skipped` row through `noteReadFailure`) rather than sent to fail on the foreign
key. The document cannot land either way, so the refusal loses no successful
write; it converts four silent 500s in the AutoCount host's log into one row an
operator can read and the re-queue tool can retry. An EDIT is not refused —
`/edit` applies only the keys it is GIVEN, so omitting `Agent` leaves the book's
own value, the same asymmetry the stock Location runs under.

**The raw `agent` text is never passed through unmapped.** Production rows hold
bare `scm.staff` UUIDs (`useStaffLookup` carries a `UUID_RE` for exactly that)
and placeholder text like "Unassigned", and `/ensure-masters` opens an agent
under exactly the string it is given — so passing either through would write
permanent garbage master data into a licensed book. `scm.staff.name` is a real
person by construction, which is why only it is trusted unmapped.

**The class, for next time** — a display helper that falls back
(`salespersonNameOf(agent, salesperson_id)`) makes an empty column invisible on
screen, and the first system to read the column WITHOUT the fallback is the one
that finds out. When two columns hold one fact and only one of them is written,
say so where the writer is, not only where the reader is.

**Still open, same shape, not fixed here:** `readPoHeader` hardcodes
`agent: null`, so every `/create-po` sends `Agent: ""` into
`FK_PO_PurchaseAgent`. The ERP has no purchase-agent concept and no value to
send; picking one is an owner decision about what AutoCount's purchase reports
will show.

**Ref** — 2026-08-14, `fix/autocount-so-agent`.
