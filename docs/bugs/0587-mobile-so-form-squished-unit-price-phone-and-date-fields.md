## Mobile SO form squished Unit Price, Phone and date fields [low]

**Symptom.** On a phone, three field groups in the mobile New Sales Order form
were too narrow to read. The Unit Price input clipped a value like "4,000.0000"
to "4,0"; the "Line Delivery Date" label truncated; the Customer Phone number was
cramped against its country-code chip because it shared a row with Email; and the
Processing Date / Delivery Date "dd/mm/yyyy" inputs were squeezed side by side.

**Root cause (traced).** Layout only — too many fields packed into one flex row on
a narrow viewport, in `frontend/src/mobile/MobileNewSO.tsx`:
- the line-item row held three `<Field>`s (Qty, Unit Price, Line Delivery Date) in
  one `<div style={{ display:"flex", gap:8 }}>`, so Unit Price got ~flex 1.1 of a
  ~360px row;
- Customer Phone and Email shared one `<div style={{ display:"flex", gap:9 }}>`,
  each flex 1, halving the phone field;
- Processing Date and Delivery Date shared one `<div style={{ display:"flex",
  gap:9 }}>`, each flex 1.

**Fix.** No logic, validation, state, or label text changed — presentation only.
- Line-item row split into two rows: row 1 = Qty (flex 0.5) + Unit Price (flex 1);
  row 2 = Line Delivery Date on its own full-width row.
- Phone and Email each moved to their own full-width row (the parent `card-b` is a
  `flexDirection: column` container, so dropping the wrapper `<div>` stacks them).
- Processing Date and Delivery Date each on their own full-width row, same way.
Verified with `npm --prefix frontend run typecheck -- --force` (clean).

**Ref.** fix/mobile-so-squished-fields, 2026-08-31.
