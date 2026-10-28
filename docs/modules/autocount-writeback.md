# AutoCount write-back (ERP -> AutoCount)

The ERP is master. Every SO, PO, DO, GRN, sales invoice and purchase invoice a switched-on company creates, converts, edits or cancels is queued in `scm.autocount_outbox` and pushed by a cron to AcSyncService, a .NET service on the office AutoCount host that writes the licensed `AED_HOUZS` book through the AutoCount 2.2 SDK.
Staff trigger it by saving documents. Admins watch it and re-send from System > AutoCount Sync (`/autocount-sync`).

## Statuses and flow

- Ops (`op`): `create_so`, `create_po`, `so_to_do`, `so_to_po`, `po_to_gr`, `do_to_iv`, `gr_to_pi`, `cancel` (all six types), `edit` (all six types). The drain calls `/ensure-masters` inline. It is never queued.
- AutoCount has no create for DO / GRN / SI / PI. They can only exist in the book as conversions of a parent.
- `status` (the table CHECK allows only these four): `pending` (waiting), `sent` (the book answered ok, `ac_doc_no` recorded), `failed` (the host refused: 4xx at once, 5xx or network after `MAX_ATTEMPTS` = 6), `skipped` (refused or recorded at enqueue, never sent, terminal).
- Derived, not statuses: `requeued` (`last_error` starts with the re-queue prefix; the page shows "Replaced"), `archived_at` / `archived_by` (a person cleared a finished document; the page shows "Cleared"), `claimed_at` (a dispatcher holds the row).
- Page states: In AutoCount / Waiting / Not accepted / Held back / Replaced. The page opens on "Needs attention" (`acNeedsAttention`) and shows one row per `doc_type + doc_no`.
- A document counts as Not accepted only while its newest refusal is newer than its newest arrival (`acRefusalPredatesArrival`). Chip counts can overlap.

Flow:
1. A route commits a save. The hook runs after the audit row. Drafts never enqueue; DRAFT -> live and PO confirm are create anchors. Amendment approve, salesperson handover, payments and line add/edit/delete all enqueue edits.
2. The gate is `isWritebackEnabled(company)`, which also refuses script (repair) clients. The payload is composed now and stored as a snapshot.
3. A compose refusal writes a `skipped` row (`refused, nothing sent (<ErrorClass>): ...` or `compose failed, nothing sent: ...`). The create response carries `acNotSent` so the operator sees it.
4. An edit before the drain replaces the pending create's payload. A cancel before the drain marks the pending create `skipped` and queues nothing.
5. The `*/5` cron runs `drainAutoCountOutbox`: 20 rows, oldest first. It claims each row (`claimed_at`, expired claims released), re-checks the switch per row (off: stays pending), then calls `dispatchOne`.
6. Only foreign keys are resolved late: parent `FromDocNo(s)` and subject `DocNo`, via `linked_ac_docno`. An unresolved row stays pending without spending an attempt. A merged conversion waits until every source is in the book.
7. `create_so`, `create_po` and `edit` call `/ensure-masters` first. If a master cannot be opened, the document is not sent.
8. On ok: `sent`, `linked_ac_docno` stamped, line keys stored. After any `sent` row, `resendHeldEdits` re-sends that document's edit if it was refused for timing. After a PO's `create_po`, `so_to_po` or `cancel` is sent, `queueSoPoDocNos` queues `ToPONo` edits on the source SOs.

Switches (`scm.app_config`):
- `scm.autocount_writeback`: `off` / `''` / absent = nothing queued or sent; `all`; `1` or `1,3` = only those companies. Checked at enqueue and per row at drain. 30s cache; a read error re-serves the last state. Production is live for company 1: read the row, never a note.
- `scm.autocount_relink_sweep` (`off` / `plan` / `apply`): a cron stamps provable book line keys onto keyless conversion documents. It queues one keyed edit only when a document becomes fully keyed. 25 documents per slot. Fails closed to off. Needs the write-back switch on as well.
- `scm.autocount_delivery_date_sweep` (`off` / `plan` / `apply`): INBOUND. Copies book line delivery dates onto SO / DO rows by `linked_ac_dtlkey`; skips blanks, overridden lines and amended headers; 200 writes per slot. Meant to stay off.
- `AC_SYNC_URL` (`[vars]`): when absent the drain does nothing and rows pile up. `AC_SYNC_KEY` (secret): the host's `X-API-KEY`.
- Separate things, never "the sync": the inbound pull (`AUTOCOUNT_SYNC_DISABLED`), the legacy `services/autocount.ts` push (hard-coded off) and the finished cutover import.

## Permissions

- `scm.autocount.read` or `settings.manage`: `GET /api/scm/autocount-outbox` (the page), `POST /api/scm/autocount-outbox/line-order-sweep`.
- `scm.autocount.requeue` or `settings.manage`: `POST /:id/requeue` (Send again), `POST /:id/send-now`, `POST /archive`, `POST /restore`, `GET /host-log`, `GET /book-doc`, `GET /table-columns` (all under `/api/scm/autocount-outbox`).
- `scm.autocount.requeue` or `*`: `POST /api/scm/autocount-outbox/relink-lines` (Match up lines).
- `*`: `GET /api/admin/health/autocount/host-build` (which AcSyncService build answers).
- `/autocount-outbox` is mounted with no `scmAreaGuard` and is listed in `SCM_UNGUARDED_PREFIXES`; the two must change together. Every query is company-scoped; another company's row answers `row-not-found`.
- A refusal from requeue, send-now, archive or restore is HTTP 200 with a sentence. Non-200 only for 403, 409 (company unresolved), 404 and 500.

## Rules that must not break

Queue
- The outbox is append-only: never delete rows. Clearing sets `archived_at`; re-queue only prefixes `last_error`.
- AutoCount must never fail a user's save: every enqueue swallows its own errors and returns false.
- The drain replays the stored payload and never recomposes. Allowed at drain: FK resolution, backfill of `DebtorCode` / `CreditorCode` / `DocNo` / so_to_po keys on old rows, and photo bytes from R2.
- Scripts never write back by default. `pgrestShim(sql, "scm")` suppresses enqueue; only allow-listed tools pass `{ writeback: "enqueue" }` (`backend/tests/acWritebackPushAllowlist.test.mjs`). No DB trigger enqueues, so raw SQL never reaches the book.
- The SO and PO amendment approves enqueue through `pgTransactionSupabase`. Every composer query must work on that shim.
- Every column the composer reads is listed at the top of `autocount-outbox.ts`. A phantom column fails the whole read (42703). A failed read writes `compose failed` and never sends a partial document.
- An amendment is an edit in place. Never express an edit as cancel + create.
- Send now dispatches the existing pending row and spends an attempt. Send again inserts a fresh row. No row qualifies for both.

Numbers, cancel, locks
- Every document goes to the book under the ERP number as `DocNo`: SO / PO on create, DO / GR / SI / PI on conversion, `/so-to-po` included. The host refuses a missing `DocNo`.
- The book keeps every number it was sent: never reissue one. `scm.doc_number_counters` only goes up. Never wipe the outbox.
- A carried-over document is `HC-` + its book number (verdict `prefixed`, not a mismatch). An ERP-made one has the same number on both sides; `so-is-migrated.ts` holds that rule.
- A cancel that reached the book is final (the SDK has no un-cancel). With `linked_ac_docno` set, leaving CANCELLED returns 409 `cancel_is_final`; raise a new document instead.
- `downstream-lock.ts`: a live DO / SI blocks SO cancel and header identity fields. SO line writes are frozen per line (`readSoLineFreeze`). A live GRN locks the PO; a live return or SI locks the DO; an invoiced or returned qty locks the GRN. A cancelled child does not lock. Raising the next downstream document is still allowed.
- A conversion from a carried-over source must be refused before any enqueue (`refuseMigratedSources`, 409). Otherwise the book gets a duplicate of an invoice it already holds.
- A parentless DO / GRN / SI / PI writes a `skipped` row (`recordParentlessCreate`). Linked lines mixed with standalone lines give `mixed-source-lines`.

Line identity (`linked_ac_dtlkey`, on all six line tables)
- An edit addresses book lines only by DtlKey. One keyless line refuses the whole edit (`KeylessLineError`). Exception: rows the inserting route names in `newLineIds`, when every other line is keyed; these go out as `IsNewLine`.
- Store a key only when it can be proved; on doubt store nothing. A wrong key silently edits another line, a missing key is refused loudly.
  - Create keys: zipped by index, ItemCode checked.
  - Added lines: by difference + ItemCode + Desc2.
  - Conversions: by the book's `DocTransfer` source link.
  - SO -> PO: by source key.
- All pieces of one sofa build carry the book line's single DtlKey, so the key is not unique. Conversions merge by key and never send a quantity for a shared key. A part-shipped sofa holds back only its own line; the delivery that covers the last piece carries it.
- A line added or hard-deleted on an SO / PO makes a rebuild (`Rebuild: true`): the book's lines are cleared, the ERP's are laid down in order, and the reissued keys are stored back.
- Never rebuild a DO / GR / IV / PI or an SO whose keys a PO holds (`rebuildAllowed`). The host refuses a rebuild if any book line has `TransferedQty > 0`.
- Otherwise a removed or cancelled line goes out as `Retire: true` (host sets Qty 0, not transferable, `[ERP-CANCELLED]` Desc2 prefix). DELETE routes call `retiredLineOf` before deleting the row. A line left out of the payload stays live in the book.
- A cancelled line is never on a create. A half-cancelled sofa build refuses the document (`SofaCollapseError`).
- Every read that becomes a payload uses `inAcLineOrder` (`created_at`, then `id`), including `readConvertSourceKeys` and `readPoTransferFacts`, whose keys and values are zipped by index.

Item codes, sofas, text widths
- An edit never sends `ItemCode` for a keyed line; the book keeps its own item. Rebuilds and new lines send it. The host throws on a new line with a blank item code.
- ItemCode order:
  1. `supplier_material_bindings`: `ac_item_code`, else `supplier_sku`. A PO prefers its own creditor's binding.
  2. The compiled cutover map, if exactly one candidate.
  3. A PO narrows by creditor, else `ItemCodeError`.
  4. Same name as the ERP code.
  5. `HOK`, then `NB`.
  6. The ERP's own code, opened by `/ensure-masters`.
  A blank code is refused. A transfer (`forTransfer`) skips this refusal and keeps unresolved lines so the key zip stays aligned.
- Sofa lines follow their book keys:
  - Keyless pieces go one ERP line per book line.
  - Pieces sharing one key fold into `<model>-1S` with the build in Desc2.
  - Distinct keys stay separate lines.
  - Mixed keys fold and then hit the keyless refusal.
- Pieces group by book key, not by adjacency. They are spelled in `line_no` order, and a gathered run takes its order from the book's own text.
- Every composed sofa Desc2 must decode back through `scripts/lib/parse-sofa.mjs` (pieces, size, colour, specials) or the document is refused. Stored book text is echoed when it still decodes to the ERP row. Colours use `liveColour`.
- Desc2 max 100 characters. Ladder: unchanged if it fits; the owner's abbreviations (`abbreviateDesc2`, least change); the special-order segment becomes `Special Order: Refer to ERP`; otherwise `Desc2TooLongError`.
- Never truncate Desc2. Never shorten stored `variants.specials`: specials are priced by name, so renaming one reprices the order.
- `InvAddr1-4` max 40: `fitAddressLines` re-flows at word boundaries, only when over. `UDF_PAYEMENT` max 50: whole references until full. Other column widths are unmeasured.
- Desc2 comes from `buildVariantSummary`; a stored `description2` wins verbatim. Line matching compares that text, so do not change the renderer to save characters.

Header fields
- An absent key leaves the book's value; present null or `""` blanks it. `present()` strips blanks on every header.
- Only exception: a create always sends line `DeliveryDate` (a date or explicit null). An edit omits it when the ERP has none.
- Stock location on a create, per line: the line's `warehouse_id` -> warehouse code -> `LOCATION_MAP`; else SO `sales_location` or PO `purchase_location_id`; else `MissingLocationError`. An edit omits it.
- Always map warehouse codes: raw names overflow AutoCount's short location code and the host silently drops them.
- Company-1 SO create and DRAFT -> live are gated by `so-location-gate.ts`. The composer refusal stays as the backstop.
- SO `SalesLocation`: `sales_location`, else the lines' location, else `MissingSalesLocationError`.
- PO `PurchaseLocation` is sent on create and on transfers (GRN: `grns.warehouse_id`). `/edit` cannot change it.
- SO Agent: `agent` via `AGENT_MAP`; else salesperson name via the map; else the salesperson name itself (opened). A create with none fails `MissingAgentError`; an edit omits it. Never send raw `agent` text (it holds UUIDs and "Unassigned").
- PO agent is always `AC_PURCHASE_AGENT` (`OTHERS`).
- Debtor: every sales document uses the fixed `AC_DEBTOR_CODE` (`300-C002`) and overwrites the name. Debtors are never opened.
- Creditor: `scm.suppliers.code` via `supplier_id`; blank gives `MissingCreditorError`. A book name that differs is reported in `mismatches` and never refused.
- `AGENT_MAP`, `LOCATION_MAP`, `VENUE_MAP` and `BRANDING_MAP` are spelling corrections. Location and venue pass through when unmapped (`bookSpellingOrOwn`). Agent and branding use `bookSpelling`; branding is an allow-list.
- The maps are generated: edit `backend/scripts/data/autocount-so-writeback-mappings.json`, then run `node scripts/gen-autocount-master-maps.mjs`. CI runs `npm run audit:ac-master-maps`.
- `UDF.BALANCE` = `soOutstandingSen`: the payments ledger, plus the legacy header deposit only when no `is_deposit` row exists, clamped at 0.
  - Total is `total_revenue_sen` if > 0, else `local_total_sen`. No total means no key.
  - A settled order sends `"0.00"`.
  - Never use `balance_sen`.
- A payment add, edit or delete queues a header-only edit (`enqueueSoPaymentEdit`: `UDF.BALANCE` + `UDF.PAYEMENT`, `Lines: []`, never Rebuild). An order not yet in the book folds it into the pending create.
- `UDF.PAYEMENT` is written only when the ERP owns the text (`erpOwnsPaymentText`: a create, or an `HC-` book number). A carried-over order sends BALANCE only.
- `scm.delivery_order_payments` never reaches the book. Do not add it to the SO payment readers: the same payment would be counted twice.
- `Phone1` = `phone`. `DeliverPhone1` = `emergency_contact_phone`; a create falls back to phone.
- SO `Ref` = `ref`, else `customer_so_no`. `ToPONo` (the book's "PO Doc No.") is the SO's non-cancelled POs in the book, joined with ", ". Only `queueSoPoDocNos` writes it.
- PO `UDF_SONo` = the source SOs' book numbers. PO `Ref` = the SO reference, only when there is exactly one source SO. A stock PO sends neither.
- PO UDF `EDate` / `EDate2` / `EDate3` = `supplier_delivery_date_2/3/4` on create, transfer and edit; blanks omitted.
- UDFs travel nested under `UDF`. `PDate` is a date column; the host tries string, then null, then decimal, then DateTime.
- UOM is never sent. It belongs to the item master; `/ensure-masters` sets it on new items.

Conversions and SO -> PO
- The shape is the ERP's decision, read only from the payload:
  - no `DtlKeys`: full transfer;
  - `DtlKeys`: by line, at each line's outstanding quantity;
  - `Details[].Qty`: only when genuinely partial, all-or-nothing per document.
  Never promote a named set to a full transfer.
- The host tries the documented `FullTransfer` / `PartialTransfer` first, with `focQty` = 0. It falls back to `AddPartialTransferDetail` only if nothing was written yet, and refuses a partial-quantity plan it cannot express.
- The account is set before the transfer: sales conversions use `DebtorCode` `300-C002`; purchase conversions use the source supplier's `CreditorCode`. The host falls back to the source document header.
- Conversion headers come from one master (`AcDownstreamSpec.facts`) projected per route. Fields a route cannot carry are reported as `acNotSent` (`AC_SENT_INCOMPLETE`) and stored in `payload.notCarried`.
- `poTransferShape` decides SO -> PO:
  - `transfer` only when every line maps 1:1 to a keyed line of ONE SO with the same product;
  - `wait` when keyless because that SO is not in the book yet;
  - `create` otherwise (consolidated, stock or multi-SO lines).
- `composeSoToPo` spreads the create master and overrides only `Details` (`UnitPrice`, `Qty`, `Location`, `DeliveryDate`). A misaligned zip is refused with `AcSoToPoAlignmentError`.

Masters, photos, host
- `/ensure-masters` opens items (group `OTHER`), sales agents, purchase agents (for purchase payloads), locations, creditors, and BRANDING / VENUE options (read-append-write, never `Add()`). It never edits an existing master and never opens a debtor.
- Photos go on `/edit` only, for SO and PO lines. The payload stores R2 keys; the drain fetches the bytes. A line gets NO `Photos` key if any picture is unreadable or would push the body past the host's 2 MiB limit, because the field is replaced wholesale.
- The host's `Set()` swallows refused assignments and still answers ok, so `sent` does not prove the value landed. Check the book with `GET /book-doc`.
- C# changes take effect only after `deploy-on-host.ps1` runs on the office host. Check `builtAt` / `mvid` via host-build before assuming host behaviour is live. Deploy the backend first.
- Call the service by hostname only: `https://autocount.houzscentury.com/<route>` with `X-API-KEY`. The ZeroTier IP is refused, and `it-houzs.dev` is a different relay.
- Host routes: `/create-so`, `/create-po`, `/so-to-do`, `/so-to-po`, `/po-to-gr`, `/do-to-iv`, `/gr-to-pi`, `/cancel`, `/edit`, `/ensure-masters`. Read-only: `GET /health`, `/doc-read`, `/further-description`, `/picture-census`, `/last-errors`, `/line-fingerprints`, `/delivery-dates`, `/table-columns`.

## Gotchas

- A repair that copied a value OUT of the book must not push. A repair correcting an ERP-owned figure must: SOs via "Enqueue SO write-back", anything else via "Send named documents to AutoCount again".
- A skipped create is terminal, and re-saving does nothing (an edit needs `linked_ac_docno`). Use Send again or the re-queue workflow.
- `Primary Key Error` on a create means the book already holds that number. If the book's document is this one, record the link. If not, issue a new number. Use `repair-outbox-sent-by-hand.mjs` only when it is the same document.
- A host 500 hides the FK constraint name; it is only in `C:\Temp\ac-sync-service.log`. Read `GET /host-log`. Master FKs fail one at a time: fixing one reveals the next.
- `Invalid transfer item.` names nothing. Read the host log (`target debtor before transfer = [...]` and the per-key dump) instead of pressing Send again repeatedly.
- A body of `error code: 502` means the host is not running (`host-unreachable`). It is not a master-data problem.
- New refusal Error class: add it to `noteReadFailure` and `acNotSentProblems`, and add its needle to `AC_SKIP_KINDS`, then the mirror `backend/scripts/lib/autocount-skip-kinds.mjs`. The kinds are a priority order.
- Carrying a key is not landing it. A header field must be applied by every host function on its path (`CreatePo` and `PurchaseHeader` both), and added to `AcDownstreamSpec.facts` so the test names any route that drops it.
- A repair that inserts a sibling row must clone it (column list from `information_schema`) so `linked_ac_dtlkey` and `warehouse_id` come along. Never enumerate columns by hand.
- Inside `sql.begin` use only `tx`: the pool has one connection, so reaching for `sql` hangs the job.
- Do not clear-and-rebuild a converted document by hand: it destroys the transfer link. Rebuild SO / PO only.
- Never pair ERP and book lines by item code (Houzs vs supplier spellings) or by position. Use `linked_ac_dtlkey`, or `DocTransfer` / `PODTL.FromSODtlKey`.
- `grns.linked_ac_docno` holds the PO's book number. The receipt's own number is `grns.linked_ac_gr_docno`.
- Book GRN lines carry no From* link. Compare GR against PO through `PODTL.TransferedQty`, never with a join.
- An empty `mismatches` from an old host build is not "clean". Check the host build.
- A purchase-conversion fallback runs `FullTransfer`, which moves every outstanding line. If the host log warns about this on a partial receipt, check for over-receipt.
- A dead R2 key in `photo_urls` makes that line send no photos. Prune with `prune-dead-line-photo-keys.mjs`: plan where the R2 token is, apply via the "Apply line photo repair (from a plan file)" workflow.
- A picture too large for one request is left out of the send, and still never reaches the book.
- CI cannot compile C#. Run `build-local.ps1` on a desktop with AutoCount 2.2 before claiming it compiles.
- Page text: server text appears only under a label naming who said it (`acWhatWasSaid`). Never name a state with a button's verb ("Replaced", not "Sent again").
- A re-queue sweep sends one rebuild per document, not one per refusal row. Keep the `already-queued` guard.
- Migrated purchase-invoice lines are copied from the book's PIDTL and tied by `grn_items.linked_ac_dtlkey`. Run `backfill-ac-downstream-line-keys.mjs` first; never fall back to item code.

## How to operate

- Page `/autocount-sync` (desktop) or System > AutoCount Sync (mobile):
  - Send now: pending rows.
  - Send again: failed or skipped creates and transfers; edits rebuild. Missing or stale ancestors are sent first.
  - Match up lines: keyless-line rows; then save the document again.
  - Clear / Put back: finished documents.
- Switch: Actions > "AutoCount write-back (on/off)" (`.github/workflows/set-autocount-writeback.yml`). Takes effect within 30s. Never hand the owner SQL.
- Health: "AutoCount write-back queue — health (read-only)" (`autocount-outbox-health.yml`). Runs daily with ALARM, failing on an outstanding failed row or a pending row older than 60 minutes.
- Identify a held-back document: "AutoCount held-back documents — identify (read-only)" (`autocount-held-back.yml`, inputs `doc` / `search` / `control`).
- Backlog re-queue with dry run: `requeue-autocount-skipped.yml`. Inputs: `doc_no` or `doc_type`, `apply=1`; `include_failed=1` is required for DO / GR / IV / PI.
- Re-push ERP-corrected SOs: `enqueue-so-writeback.yml` (dry run by default). Re-send named documents as they stand: `resend-ac-document-edits.yml` (`doc_nos`, `mode` plan / apply).
- Line keys: `backfill-ac-line-keys.yml`, `backfill-ac-sofa-line-keys.yml`, `backfill-ac-downstream-line-keys.yml`.
  - Converted documents: run `backend/scripts/export-ac-conversion-line-keys.py` on the office network, then `stamp-conversion-line-keys.yml`, then `requeue-keyed-conversion-edits.yml`.
  - Book lines the ERP removed: `retire-book-only-conversion-lines.yml`.
- Sweeps: `set-relink-sweep.yml` and `set-delivery-date-sweep.yml`. Run `plan` first.
- Cancel parity: refresh with `backend/scripts/export-ac-cancel-parity.py`, then `cancel-parity-check.yml`. Master binding proposals: `autocount-field-alignment.yml`, then confirm pairs in the mappings JSON and regenerate.
- Read the book without visiting the office: `GET /api/scm/autocount-outbox/book-doc?docType=&docNo=`, `GET /api/scm/autocount-outbox/host-log?lines=&onlyErrors=1`, and the host-build endpoint.
- Host deploy: `backend/scripts/autocount-service/build-local.ps1` (compile check), then `deploy-on-host.ps1` on the host. It refuses an exe that did not compile, health-checks, and rolls back. Steps: `docs/autocount-service-deploy.md`.

## Where the code is

- Queue and drain: `backend/src/scm/lib/autocount-outbox.ts`, `autocount-claim.ts`, `autocount-writeback-flag.ts`, `ac-repair-suppression.ts`.
- Composer and host client: `backend/src/services/autocount-writeback.ts`, `autocount-item-code.ts`, `autocount-sofa-collapse.ts`, `autocount-desc2-abbrev.ts`, `autocount-address-fit.ts`, `ac-line-gone.ts`, `autocount-created-lines.ts`, `autocount-host-read.ts`. Generated maps: `autocount-item-map.ts`, `autocount-master-maps.ts`.
- Lines and masters: `backend/src/scm/lib/autocount-line-keys.ts`, `autocount-convert-lines.ts`, `autocount-relink-lines.ts`, `ac-line-order.ts`, `autocount-masters.ts`, `autocount-photo-attach.ts`.
- Rules:
  - `backend/src/scm/lib/`: `downstream-lock.ts`, `migrated-chain.ts`, `so-is-migrated.ts`, `convert-parent.ts`, `si-autocount-source.ts`, `so-location-gate.ts`, `so-agent.ts`, `autocount-read.ts`, `ac-so-payment-edit.ts`, `ac-payement-owner.ts`, `autocount-so-po-doc-no.ts`, `autocount-po-source-so.ts`, `autocount-held-edit-resend.ts`, `ac-preflight.ts`.
  - `backend/src/scm/shared/`: `po-transfer-shape.ts`, `so-outstanding.ts`.
- Status, re-queue, sweeps: `backend/src/scm/lib/autocount-outbox-status.ts` (mirror: `backend/scripts/lib/autocount-skip-kinds.mjs`), `autocount-requeue.ts`, `autocount-cascade.ts`, `autocount-outbox-archive.ts`, `autocount-relink-sweep.ts`, `autocount-delivery-date-sweep.ts`, `ac-line-order-sweep.ts`.
- Routes: `backend/src/scm/routes/autocount-outbox.ts`, `autocount-relink.ts`, `autocount-line-sweep.ts`.
- Enqueue anchors: `mfg-sales-orders.ts`, `mfg-purchase-orders.ts`, `delivery-orders-mfg.ts`, `grns.ts`, `sales-invoices.ts`, `purchase-invoices.ts`, `so-amendments.ts`, `po-amendments.ts`, `so-handover.ts`, `scan-so.ts` (same folder).
- Frontend: `frontend/src/pages/AutoCountSync.tsx`, `frontend/src/mobile/MobileAutoCountSync.tsx`, `frontend/src/lib/autocountOutbox.ts`, `frontend/src/lib/autocountRegister.ts`, `frontend/src/vendor/scm/lib/ac-not-sent.tsx`.
- Host: `backend/scripts/autocount-service/AcSyncService.cs`, `sdk-api-reference.txt`, `build-local.ps1`, `deploy-on-host.ps1`.
- Migrations: `backend/src/db/migrations-pg/0277_scm_autocount_outbox.sql`, `0315_ac_outbox_claim.sql`, `20260908T0620_scm_autocount_outbox_archive.sql`.
- Wiring tests: `backend/tests/autocountWritebackWiring.test.ts`, `autocountWritebackCells.test.ts`, `acWritebackPushAllowlist.test.mjs`, `migratedConvertGuard.test.mjs`, `acLineOrderWiring.test.ts`, `autocountSyncReasonsCatalogue.test.ts`.
- Unit tests: `backend/src/scm/lib/autocount-outbox.test.ts`, `autocount-requeue.test.ts`, `backend/src/services/autocount-writeback.contract.test.ts`.
- Reference docs: `docs/autocount-sync-reasons.md` (every skip reason and re-queue outcome), `docs/autocount-integration-map.md`.
