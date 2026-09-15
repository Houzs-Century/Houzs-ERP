## The outbox health check kept listing documents as having no line identity after their keys were filled [low]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The AutoCount outbox health check of 2026-09-14 (run 34850891130)
reported *"IN AUTOCOUNT, BUT WITH NO LINE IDENTITY: 40"* and told the reader to
press "Match up lines" on each. By then the DocTransfer stamp (run 34847683795)
and the relink sweep had keyed most of those documents: HC-DO-2609-078 to -099
were on the list with every row keyed.

**Root cause (traced).** The section in
`backend/scripts/check-autocount-outbox-health.mjs` selected `sent` outbox rows
whose `last_error` holds the drain's identity note (0813), newest 40. That note
records what the drain could not store at send time. Keys filled later by any
other road leave the note in place, and the check never looked at the
document's rows, so a finished document read as open work indefinitely.

**Fix.** Each listed document is now looked up by number in its own item table
(SO, PO, DO, GR, IV, PI). It is listed only while one of its rows still has no
key, with that count. Documents whose rows are all keyed are counted apart under
*KEYED SINCE*. A document the lookup cannot find stays listed, which is the
conservative direction. Ran locally against production, read-only, 2026-09-14:
15 documents still keyless (PO-2609-098, SO-2609-071, SO-2609-065, nine goods
receipts, PO-2609-088/089/090), 44 keyed since.

**Ref.** fix/ac-health-identity-now, 2026-09-14.
