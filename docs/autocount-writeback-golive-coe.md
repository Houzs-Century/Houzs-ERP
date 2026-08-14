# AutoCount Write-Back Go-Live — Nothing Reached the Account Book COE (Correction of Error)

**Date:** 2026-08-13
**Trigger:** The owner turned the write-back on and saved a Sales Order: *"所以我可以去开单，然后看它会不会进到去 AutoCount，是吗？"* Then, an hour and two orders later: *"我开了一张 Sales Order，帮我看一下这张通道去 AutoCount 会打通吗？"* It had not. Neither had the second.
**Status:** Root causes TRACED, all seven of them, each against source or production rather than inference. Twelve fixes shipped the same day, and fault 7 — the one that was "in flight at time of writing" — landed as #2148. **Not resolved:** no document has reached the account book yet. Nothing was written to the licensed book at any point; every failure was refused before it landed. The two orders are `failed` at `MAX_ATTEMPTS`, and the re-queue tool refuses a non-`skipped` row by design, so re-sending them is an owner decision (§5).

---

## 1. Incident — what the owner saw

He switched `scm.autocount_writeback` to `"1"` and created `HC-SO-2608-001`. Nothing appeared in AutoCount. He created a second, `HC-SO-2608-002`. Nothing appeared. Both looked healthy in the ERP.

Over the day, seven distinct faults sat between "the switch is on" and "the document is in the book". Each one hid the next: fixing any of them alone would have moved the failure one step down the chain and no further.

| # | What stopped it | Found by |
|---|---|---|
| 1 | `9028-1S` maps to two AutoCount items; a sales order names no supplier | the outbox's own `skipped` row |
| 2 | The documented remedy — a supplier SKU binding — was unreachable for sofas | reading `bindingsFor` against `composeDetails` |
| 3 | Every sofa binding in production named a code the book does not hold | the ambiguity report, written for this |
| 4 | `HC-SO-2608-002` had no stock location, so AutoCount would have rejected it | the second `skipped` row |
| 5 | A refused document had no way back — fixing the cause did not re-queue it | production: the address was fixed, the row did not move |
| 6 | The re-queue tool itself: absent secrets, a missing shim method, an unclosed pool | three consecutive dispatches |
| 7 | `FK_SO_SalesAgent` — the write-back reads `agent`, the ERP keeps the salesperson in `salesperson_id` | the health check, once it printed a pending row's error |

---

## 2. The one shape, three times

Faults 2, 4 and 7 are the same bug wearing different clothes, and that is the finding worth keeping:

> **A fact the ERP holds in two places. The UI reads both. The write-back reads one.**

- **`supplier_sku`** means "what this supplier calls it" on a purchase document *and* was borrowed as "what AutoCount calls it" by the write-back. The two coincide for most products and diverge for sofas. Correcting it for the sync would have corrupted the documents sent to suppliers.
- **Location** is a header `sales_location` *or* a per-line `warehouse_id`. The composer omitted the key when both were empty, and `Str()` on the C# side turns an absent key into `""`, which is not a row in `dbo.Location`.
- **The salesperson** is `agent` (legacy free text) *or* `salesperson_id` (the real identity, joined to `scm.staff`). `SalesOrderDetailV2.tsx:1176` renders `salespersonNameOf(agent, salesperson_id)`, so the name appears on screen either way — which is exactly why nobody noticed `agent` was empty until AutoCount's foreign key said so.

In all three the ERP was right, the screen was right, and the write-back read the wrong column. None of them is visible by reading either system alone.

---

## 3. Fixes shipped, 2026-08-13

| PR | Effect |
|---|---|
| #2093 | The supplier-SKU binding is reachable for a collapsed sofa line at all |
| #2095 | A binding that names none of the tied items is ignored, not obeyed and not fatal |
| #2119 | One canonical item per ERP line; the owner's HOK -> NB preference; an unknown code is opened rather than refusing the order; an edit never rewrites the item on a line AutoCount already owns |
| #2112 | Company 1 cannot create a Sales Order with no stock location |
| #2120 | A refused document can be re-queued once its cause is fixed |
| #2123 | The re-queue runs on `DATABASE_URL` through `pgrest-shim`, like the other 286 workflows |
| #2132 | `pgrest-shim` grows `neq` |
| #2136 | The re-queue closes its pool, so a successful run can end |
| #2094, #2144 | The health check stops mislabelling refusals, and prints the error on a *pending* row |
| #2110, #2117 | The address block on the SO edit page — the dropdown was clipped, Chrome's autofill covered it, and the reverse city/postcode resolution was never wired there |
| #2122 | The payment slip is optional on a Sales Order |
| #2148 | **Fault 7.** `agent` is stamped at create from the salesperson the order is attributed to, and the composer falls back to `salesperson_id` for the orders that already exist. A create that can name neither is REFUSED into a readable `skipped` row instead of sent to fail on the foreign key |

---

## 4. What the audit RULED OUT

- **"The AutoCount host is down."** It answered `401 {"ok":false,"error":"bad key"}` to an unauthenticated probe throughout — that is the live service refusing a missing key, so the tunnel and the process were up the whole time.
- **"`AC_SYNC_KEY` is missing."** `callAcService` classifies 4xx as **not** retryable. The rows were retrying, so the send was a 5xx — meaning the key was accepted and AutoCount itself threw. This inverts the natural first guess and is now stated in the health check's own output.
- **"`/ensure-masters` failed and the error was swallowed."** Proposed, then refuted by reading `EnsureMasters`: it returns `{"ok": failed.Count == 0}` and the drain turns `ok:false` into `masters not opened, document not sent`. The observed error was the foreign key, not that, so the agent was never in the payload — which is what pointed at fault 7.
- **"The credentials the re-queue wanted were never created."** The owner was sure they existed and was right: they are **Cloudflare Worker** secrets. GitHub Actions cannot read that store. Both statements were true at once, and the first answer — a flat "they do not exist" — was given after checking two of at least four places.
- **"Pick one of the two brand items for an ambiguous sofa."** Measured against 658 real sofa lines: 9028 is 64 DorsettLoft / 40 Armani, 9058 is 72 / 18. No existing item is right for more than about 70% of them, so any single choice is silently wrong a third of the time. Hence a canonical item instead.

---

## 5. Deferred

| Item | Owner |
|---|---|
| A field-by-field alignment audit — venue, branding, debtor, customer PO — for more instances of the shape in section 2 | DONE. `docs/autocount-field-alignment-audit.md` found 8 BROKEN, all fixed by #2200. Its row counts were inflated about fiftyfold by a missing company predicate (#2201): scoped to Houzs the whole picture is TWO orders, and the audit now carries that correction at the top |
| `recompute-2990-so-allocation.yml` is wired to secrets that do not exist and has never run; it is also what the re-queue was copied from | flagged with a header, own task |
| `wrangler secret list` cannot be run here — the authenticated account does not match `account_id` in `wrangler.toml` | unassigned |
| The C# create has no guard against a duplicate ERP document number, so a lost response on a retry could create a second document | unassigned; narrow, needs a mid-flight failure |
| Browser verification of the payment-slip and address UI changes | owner |
| `HC-SO-2608-001` / `-002` are `failed` at `MAX_ATTEMPTS` and the re-queue tool refuses a non-`skipped` row on purpose ("a failed create WAS sent"). Here the health check says `sent 0` and a foreign key rejects before any write, so nothing landed and both are safe to re-attempt — but relaxing that guard is a decision, not a cleanup | owner |
| A PURCHASE order has no agent at all: `readPoHeader` hardcodes `agent: null`, so every `/create-po` sends `Agent: ""` into `FK_PO_PurchaseAgent` — fault 7's shape on the other document type. Needs a decision about what AutoCount's purchase reports should attribute an ERP order to | owner |

---

## 6. Lessons

1. **A precedent is evidence only if it ran.** The re-queue was wired to two non-existent secrets by copying the one workflow in the repo that already was — three characters away by name from the one that works. Where a repo has 286 examples of one thing and 1 of another, the 1 needs a reason.
2. **A diagnostic that withholds a field is worse than one that says nothing.** The health check printed a pending row's age and attempt count and not its `last_error`, so a queue that was visibly retrying gave no clue why; the answer was thirty minutes away, waiting for a dead-letter. One column on a query that was already running.
3. **Refusing loudly is what made this tractable.** Every fault above was found from a message the system wrote down — a `skipped` row with its reason, `pgrest-shim` naming the method it lacked, AutoCount's own foreign key. The one fault that took longest, the unclosed pool, is the one that produced no message: it looked like a slow query, and only SUCCESS hung, because every earlier failure had exited through `process.exit(1)`.
4. **When a pipeline decides a shape, nothing downstream may re-derive it.** The sofa resolver held its own opinion about what a sofa is, alongside the collapse that had already decided, and produced two different AutoCount items for one sofa depending on which side of the collapse the caller sat. The fix was deleting the second opinion, not improving it.
5. **State that lives outside git cannot be answered from documents.** This system's state is spread over GitHub repo secrets, three GitHub environments, Cloudflare Worker secrets and `scm.app_config`, and nothing enumerates them. Every question of the form "is X set" cost a wrong answer first. The standing rule — build the check, do not read the write-up — is in `CLAUDE.md` and was still under-applied today.
