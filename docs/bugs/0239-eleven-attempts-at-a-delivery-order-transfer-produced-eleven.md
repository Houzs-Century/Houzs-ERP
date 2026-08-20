## Eleven attempts at a delivery-order transfer produced eleven identical, contentless errors [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-DO-2608-001` (`so_to_do`, FAILED, 6 of 6 attempts) and
`HC-DO-2608-002` (5 attempts, still pending) will not transfer into the live
`AED_HOUZS` book. Every attempt recorded the same `last_error`:

```
 Invalid transfer item.
```

Eleven runs, no key, no document, no reason, and no way to tell the eleven apart.

**What was actually wrong with the DIAGNOSIS, traced.** Two things, and neither
of them is the transfer itself.

1. **The probe printed the payload's key NAMES, not its values.**
   `why-so-line-not-purchasable.mjs` section D dumped an outbox row's header as
   `header keys: DocNo, DtlKeys` — so `DtlKeys` was known to be present and
   WHICH keys was never on screen through all eleven attempts.

2. **The service cannot say more than AutoCount said.** When the ERP names the
   lines, `DtlKeys()` returns the supplied array VERBATIM, so neither predicate
   this service otherwise applies — `h.Cancelled = 'F'` and
   `(d.Qty - ISNULL(d.TransferedQty,0)) > 0` — is evaluated for those keys, and
   AutoCount is the first thing in the chain to look at the lines at all.
   `Serve`'s catch-all returns `ex.Message` alone, and that message is the eleven
   words above.

**Fix.**

- The probe prints, for a conversion row, the `DtlKeys` array itself,
  `FromDocType`, the stored `FromDocNo` and the `FromDocNo` `dispatchOne`
  resolves at drain from `payload.fromDoc` — which is not in the stored payload
  at all. `last_error` is no longer clipped at 220 characters.
- A new section E walks target line -> source line -> source DOCUMENT for every
  key in the payload and prints the DISTINCT source documents beside that single
  `FromDocNo`, plus the two silent drops `readConvertSourceKeys` can make.
- `Convert_` wraps its whole `switch` and, on any failure, appends the book's own
  numbers per key: document, `Qty`, `TransferedQty`, `Transferable`, the
  document's `Cancelled`, the outstanding quantity, `NOT FOUND` for a key on no
  row. Columns go through `ExistingColumns`, so a book missing one loses that
  field and not the explanation. It DIAGNOSES and does not refuse: a pre-flight
  predicate stricter than AutoCount's own would turn working transfers into
  refusals, and this file compiles nowhere but the office host.

**What the probe RULED OUT** (run 31944045963 and 31944185309,
`why-so-line-not-purchasable.yml` against production, read-only):

| suspicion | refuted by |
|---|---|
| the keys span SEVERAL sales orders while `FromDocNo` names one — the mixed-array shape that raises this exact exception | `DISTINCT SOURCE DOCUMENTS: 1` on both. `HC-DO-2608-002` -> `[905348,905349]`, both on `HC-SO-2608-002`, which is what drain resolves. `HC-DO-2608-001` -> `[906306,906307]`, both on `HC-SO-2608-003`, likewise |
| a DO line with no `so_item_id` is silently dropped, so the key count disagrees with the line count | `lines with no so_item_id: 0` on both; 2 keys for 2 lines each |
| a source line carries no `linked_ac_dtlkey` | `source lines with NO DtlKey: 0` on both |
| `/so-to-do` passes the wrong `fromDocType` | it passes `"SO"`, and the same route with the same literal produced `DO-011260` and the `5b-multi` QA transfer on the live book |

**Still UNKNOWN, and honestly so.** WHICH of those four keys the book refuses,
and why. That needs `SODTL` for keys 905348, 905349, 906306, 906307, and no
credential in this repository reaches the AutoCount host — `gh api
repos/hello-houzs/Houzs-ERP/actions/secrets` returns ten secrets, none of them
`AC_*`, and neither environment carries one. The next attempt on either document
answers it by itself once the host is rebuilt.

**Ref:** this PR, 2026-08-16.
