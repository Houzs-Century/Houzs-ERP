## A held-back document had no way to be matched up against AutoCount [high]

**Symptom.** A document refused for a keyless line renders, in the ERP's own
words: *"TO FIX: The lines have to be matched up against AutoCount, and then the
document saved again. Send again cannot do it — a change has nothing to
re-create."* There was no way to do that. The instruction named an action nobody
could take, and the document stayed stuck.

**Root cause.** Two halves, and only one of them existed. `docs/bugs/0583-*`
closes the hole going FORWARD — the service now reports the key it assigned to an
added line — but it needs a deploy on the office host and it does nothing for the
documents already held back. Nothing could repair those, because nothing in the
ERP had ever asked the account book what line keys it holds.

The read itself was already there and already unused: `AcSyncService` has served
`/doc-read` since 2026-08-15, and `GET /autocount-outbox/book-doc` calls it. What
was missing was the WRITE.

**The owner proposed the other remedy first, and it is refused with its reason**
(2026-08-31): 「每一次进去都重新 reset 过它所有的 item line 会比较好呢?」 — clear
every detail and rebuild. AutoCount's own documentation samples exactly that
(`ClearDetails()` then `AddDetail()`), and it is wrong here for two reasons that
are not matters of taste:

* it destroys every DtlKey, which is the identity every link in this system hangs
  on — `PODTL.FromSODtlKey`, the DO/GR transfer chain, the line photographs, and
  retirement itself;
* AutoCount's own troubleshooting page for a TRANSFERRED document says deleting
  its rows leaves the source pointing at nothing, the document goes grey and
  uneditable, and recovery needs raw SQL plus Management Studio's *Fix Deleted
  Document Transfer Problem*.

His diagnosis was right — our side does not know the numbers — and only the
remedy was wrong. Read them back; do not destroy them.

**Fix.** `POST /autocount-outbox/relink-lines` (`routes/autocount-relink.ts`):
reads the document out of the book, matches our keyless lines against it, and
stamps `linked_ac_dtlkey`. Read-only on the book — two SELECTs, no SDK session,
no outbox row — and the only write is a LINK on our own rows: no money, no stock,
no document created or changed in AutoCount. Needs no host deploy.

The matching rules and every refusal live in `lib/autocount-relink-lines.ts` with
their own tests, because a WRONG key is worse than no key: a missing one is
refused loudly by composeEdit, a wrong one silently edits somebody else's line in
a live account book on the next save. So:

* a book line one of our keyed rows already claims is never a candidate;
* a keyless row matches only on the item code;
* where that code repeats among the candidates, Desc2 must separate them —
  prefix-tolerant, because the book truncates its own long sofa builds at 100
  characters — and a repeated code with no Desc2 on both sides is refused rather
  than guessed;
* an ambiguous line refuses ITSELF and the rest still land, each refusal NAMED.

The write is `.is('linked_ac_dtlkey', null)`, so it only ever fills a blank.

**Tests.** Seven in `autocount-relink-lines.test.ts`: matched, claimed-line
excluded, the sofa case separated by Desc2, the truncated-Desc2 prefix, the
ambiguous refusal, one ambiguous line not stopping the others, and two same-code
rows never taking the same book line.

**Known narrowing, said plainly.** It matches on the RAW ERP item code. Where the
write-back resolves a supplier's own spelling through
`supplier_material_bindings`, the raw code will not match the book's and the line
is REFUSED — reported, not mis-assigned. Fail-closed is the right direction;
resolving through the bindings is the follow-up.

**Ref.** feat/ac-learn-new-line-keys, 2026-08-31.
