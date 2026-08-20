## backfillSoPayments paged the already-posted journal scan with no ORDER BY [low]

Symptom: backfillSoPayments' first loop pages journal_entries (SOPAY) 1000 rows at a time with `.range()` and no `.order()`, breaking on a short page. Without a stable order, PostgREST/Postgres may return the same physical row on two pages or skip one between page requests, so `postedIds` could miss an already-booked payment id.

Root cause traced: the already-posted scan (`.from('journal_entries').select('source_doc_no, reversed').eq('source_type','SOPAY').range(from, from+page-1)`) had no ORDER BY, while the candidate scan immediately below already ordered by `.order('paid_at').order('id')`. A skipped already-posted id is re-classified as a candidate and re-posted; the DB `acc_je_one_active_source` unique index plus the engine's fail-closed guard prevent an actual double-book, so no money is lost, but `scanned`/`remaining` are inflated and work is wasted — the paged scan itself is non-deterministic and non-resumable, contrary to its own comment.

Fix: add `.order('id')` (the journal_entries PK, a unique stable key) before `.range()` on the already-posted scan, matching the candidate scan's stable-order pattern. Behaviour-preserving; only page boundaries are stabilised. Ref: PR TBD, 2026-08-18.
