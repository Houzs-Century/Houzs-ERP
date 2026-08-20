## `/ensure-masters` fetched the creditor, read a boolean off it and threw the company name away [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-PO-2608-001` / `HC-GR-2608-001` / `HC-PI-2608-001` are booked in
`AED_HOUZS` against creditor `400-H004`, which the account book holds as **HAO
HUA FURNITURE**. The ERP purchase order behind them names **HOOKKA INDUSTRIES
SDN. BHD.** The owner has confirmed those are two different companies, and no
creditor named HOOKKA INDUSTRIES exists anywhere in the book's 110 rows — the
only INDUSTRIES match is `400-G005 GUANGDONG DIGLANT FURNITURE INDUSTRIAL
CO.LTD.` So the documents are on a stranger's account, and nothing anywhere said
a word.

**Root cause, traced through the code that ran.** `readPoHeader`
(`scm/lib/autocount-outbox.ts`) sends `scm.suppliers.code` as `CreditorCode`
verbatim, and `mastersOf` puts the ERP's own supplier name in the same object as
`CompanyName`. The drain's `/ensure-masters` pre-flight then asked
`CreditorExists(acc)` — literally `da.GetCreditor(acc) != null`
(`AcSyncService.cs`) — which **fetched the creditor entity and discarded
everything about it except whether it was there**. Both names existed, in the
same method, at the same instant, and were never compared. A code that resolves
to the wrong company is therefore byte-for-byte indistinguishable from a code
that resolves to the right company at every layer: the service reports
`existed`, the drain sees `ok`, the document posts. The field is hand-entered in
the ERP and nothing validates it.

**Fix.**

1. `CreditorExists` becomes `CreditorFound(da, acc, out bookName)` and RETURNS
   the name it already read. `false` still opens a new creditor, so the create
   path is unchanged. The property is read by reflection, because
   `sdk-api-reference.txt` was dumped `DeclaredOnly` and does not cover
   `CreditorDataAccess`, so `GetCreditor`'s return type is not established in
   this repo — reflection compiles against whatever the SDK exposes, and a
   property that turned out to be absent degrades to *not compared* rather than
   to a false MISMATCH on every document.
2. The comparison sits where both names exist at once, in the `Creditors` loop,
   and lands in a new `mismatched[]` on the response. `ok` is untouched:
   **it reports and it must never refuse.** The ERP holds a shorter trading name
   than the book's registered one on many suppliers, so failing the document
   would block legitimate purchasing in bulk, and what is underneath is an
   accounting decision a human makes against the masters.
3. `NormParty` folds case and every non-alphanumeric character away first, so
   `SDN. BHD.` against `SDN BHD` says nothing — a guard that fires on
   punctuation is a guard nobody reads. Same fold the ERP-side census uses. The
   comparison is skipped entirely when the payload's `CompanyName` is just the
   code, which is what `mastersOf` falls back to when a PO carries no
   `CreditorName`.
4. ERP side: `AcCallResult.mismatches` + `parseAcMismatches` (an entry missing
   any of the three strings is dropped — a blank `book` would assert something
   about the account book nobody measured), and `dispatchOne` prints
   `MISMATCH <master> erp=<name> book=<name> — <doc> sent anyway` BEFORE it
   checks `ok`, because a payload can name several masters and fail on an
   unrelated one.

**What this does NOT establish.** An empty `mismatches` is *not reported*, not
*compared and agreed*: a host running an older build does not send the field and
the ERP cannot tell. `GET /health`'s `builtAt` / `mvid` is the only thing that
says which build answered. **This change is NOT yet proven on the host** — the
repo cannot compile C#, and as of 2026-08-18 the office host is still running the
hand-patched build from `builtAt 2026-08-17T15:05:51Z`. `deploy-on-host.ps1`
compiles with `csc` and refuses to swap an exe that did not compile, then
health-checks and rolls back to a hash-verified backup, which is the gate this
is proven by.

**Also in this change, and it is the reason for it.** The census
(`backend/scripts/census-autocount-party-codes.mjs`, workflow
`census-autocount-party-codes`) grew a **section 6 reconciliation worksheet**:
every ERP supplier that carries a code, both companies, sorted by code, with the
book's `AccNo` / `CompanyName` columns left EMPTY because this repo cannot reach
`AED_HOUZS` and fuzzy-matching a trading name to a registered one is the exact
reasoning that produced this bug. It flags, and does not resolve, the three codes
whose ERP rows name different companies, the names with no registered-entity
suffix, and the codes whose letter is not the name's initial. No repair is in it
and none may be added to it.

**Ref.** PR #2380, 2026-08-18.
