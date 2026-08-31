## Desktop SO form squished Unit Price, Phone and date fields [low]

**Symptom.** On the desktop Sales Order form three fields were too cramped to
read. The Unit Price cell clipped a value like "4,000.0000" down to "4,(". The
customer Phone field left only ~98px for the number after the country chip. In
the Building Type / Venue / Processing Date / Delivery Date row each date got
only a quarter of the width, so "dd/mm/yyyy" was cramped.

**Root cause (traced).** All three are presentation, not logic.
- Unit Price: `SoLineCard.module.css` `.priceInput` used `font-family:
  var(--font-mark)` (Archivo Black), `font-size: var(--fs-13)`, `font-weight:
  700` — a very wide, heavy face — inside the fixed 96px "Unit Price" grid
  column defined by `.row`'s `grid-template-columns`, so the glyphs overflowed
  the column.
- Customer Phone: the `<label>` wrapping `<PhoneInput>` in `SalesOrderNew.tsx`
  sat in a single cell (span 1) of the `.formGrid4` 4-column grid; the country
  chip then left the number too little room.
- Processing/Delivery Date: both `DateField`s were span-1 cells in the same
  `.formGrid4` (`repeat(4, minmax(0,1fr))`), so each date was only 1/4 wide.

**Fix.** Layout/CSS only — no logic or label-text changes.
- `.priceInput` font changed to match the neighbouring qty input: `font-family:
  var(--font-sans)`, `font-size: var(--fs-12)`, `font-weight: 500`;
  `text-align:right` and `font-variant-numeric: tabular-nums` kept. The 96px
  column width was NOT widened (owner does not want the flexible Item/Remarks
  columns squeezed).
- Customer Phone label given `style={{ gridColumn: 'span 2' }}`, mirroring the
  Emergency-Contact phone which already spans 2.
- Processing Date and Delivery Date `DateField` labels each given `style={{
  gridColumn: 'span 2' }}` so each gets ~1/2 width. Building Type / Venue still
  lay out sensibly (one row: Building Type, Venue, then Processing Date spanning
  the remaining two columns; Delivery Date wraps to the next row).
Verified with `npm --prefix frontend run typecheck -- --force` (clean). No
automated test pins pure CSS/grid layout; change is visual-only.

**Ref.** fix/so-form-desktop-layout, 2026-08-31.
