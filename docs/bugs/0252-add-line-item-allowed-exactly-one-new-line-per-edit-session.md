## "+ Add Line Item" allowed exactly ONE new line per edit session [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-08-16: on the Sales Order detail page in edit mode he
clicked "+ Add Line Item", got one new empty line card, **and the button
vanished**. "It should be able to keep adding lines." He also saw the header
still reading "LINE ITEMS (2)" with three rows on screen, which made the new
row look like it had not registered.

**Root cause (traced).** `addingDraft` was a single nullable
`useState<SoLineDraft | null>`, and the button rendered behind
`{isEditing && !addingDraft && ...}` — a deliberate Task #80 guard against
stacking two add-cards, which also made a second line unrequestable. Every
consumer inherited the cap: the pre-save blank guard, the sofa-mix check, the
variant-gap check, the save chain's single `commitAddLine`, the amendment ADD
diff (so on a processing-locked SO a second new line would have vanished at
submit) and the empty state. The count was `items.length`, which in edit mode
is wrong in BOTH directions — it misses a staged add, and it keeps a row removed
this session until the refetch.

**Fix.** `addingDraft` -> `addingDrafts: StagedAddLine[]`, each row carrying its
own ADD idempotency key (the pattern `lib/idempotency.ts` already documents for
data-row intents; one shared key across distinct inserts would have the
middleware replay the first response for all of them). The button now consults
only `linesLocked`. The header counts rendered cards (`visibleLineCounts`) and
says how many are unsaved; each staged card is captioned "New line N — not
saved yet". Logic extracted to `so-add-lines.ts` because
`SalesOrderDetail.tsx` sits under a file-size ceiling that may only fall.

**Ref.** feat/so-multi-add-lines, 2026-08-16.
