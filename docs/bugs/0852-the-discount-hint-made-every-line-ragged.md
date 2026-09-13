## The discount hint made every line ragged [low]

**Symptom.** The owner, 2026-09-13, on a sales-order line: 「关于 discount set
unit price first，怎么你把它的 front end 做到这样子呢？怎么不是整齐一点呢？」 with a
screenshot of the row.

The Discount cell rendered its hint — "Set a unit price first", or "= RM 250.00"
— as a BLOCK under the field, on every row, at rest. That made the Discount
column about 14px taller than Unit Price and Delivery Date beside it, so the
whole line read ragged. On a phone it spent a permanent strip of the row on a
sentence nobody reads while scanning a list.

**Root cause (traced).** `DiscountInput` put the hint in normal flow, inside a
`flex-direction: column` wrapper with `minHeight: 14`. It was always rendered and
always occupied space, whether or not the operator was anywhere near the field.
The component shipped with the typed-discount change and the hint was designed
for the moment of TYPING, without anyone looking at what it costs a resting row.

**Fix.** The hint is now `position: absolute` — out of flow entirely, so the cell
is the height of the input at rest AND while typing — and it is visible only
while the field has focus. It floats over whatever is below rather than pushing
it down, never wraps (a two-line hint would push the row again), and takes
`pointer-events: none` so it cannot swallow a click meant for the row underneath.

Nothing is lost: the same text is still on the input's `title` at rest, and the
element stays mounted with `aria-live="polite"` so a screen reader still
announces the reading on a field that never receives visible focus.

**Pinned** by `discountInputLayout.test.tsx`: out of flow, invisible at rest,
visible on focus and gone again on blur, the title still carries the reading, a
percentage still reads back as ringgit while typing, no wrapping, no pointer
events.

**Ref.** feat/status-reads-submitted, 2026-09-13.
