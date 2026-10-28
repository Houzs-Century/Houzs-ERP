// ----------------------------------------------------------------------------
// How wide the account book's columns are, on the screen where they are typed.
//
// AutoCount's columns are FIXED WIDTH and it refuses the WHOLE document when one
// is over — not the field, the document. Every width the ERP can overrun belongs
// here, next to its own enforcement, and each one is checked against the backend
// constant it copies by frontend/scripts/check-ac-column-widths.mjs.
//
// AutoCount's four address columns are 40 characters and it refuses the WHOLE
// document when one is over — an over-long line kept a sales order out of the
// accounts entirely (docs/bugs/0728). The write-back already fits an address to
// this on the way out; the input stops it being typed in the first place, so
// the person filling the form sees the limit instead of discovering it as a
// re-flow after saving. Owner, 2026-09-09: 「把我们的 address lock成 40 个字」.
//
// A COPY, and checked as one. The measured truth is
// `AC_ADDRESS_LINE_MAX` in backend/src/services/autocount-address-fit.ts, taken
// off AED_HOUZS itself; the frontend cannot import from the backend, so
// frontend/scripts/check-address-line-max.mjs fails the build if the two numbers
// ever disagree. That is the shape this repo uses for every rule that has to
// exist on both sides.
// ----------------------------------------------------------------------------

/** The widest an address line may be. Keep in step with the backend constant. */
export const ADDRESS_LINE_MAX = 40;

/**
 * The widest a line's Further Description may be — `SODTL.Desc2` / `PODTL.Desc2`,
 * `nvarchar(100)`.
 *
 * A COPY of `AC_DESC2_MAX` in backend/src/services/autocount-sofa-collapse.ts,
 * checked against it by the same gate as the address.
 *
 * NOT A FIELD SOMEBODY TYPES, which is why there is no `maxLength` for it. The
 * text is BUILT — `buildVariantSummary` folds the line's colour, divan, gap, leg,
 * seat and special orders into one string, so the length is the length of the
 * whole line's specification and no single input owns it. Measured 2026-09-09: a
 * plain bedframe renders 46 characters and two special-order notes take it to
 * 110. The screen therefore SHOWS the overrun where the line is read
 * (VariantDescription) instead of stopping anybody typing.
 *
 * AND IT IS NEVER CUT. Desc2 is the specification the factory builds from; half
 * a specification is a wrong instruction, not a short one. The write-back
 * refuses rather than truncating (Desc2TooLongError) and this is the warning
 * that lets somebody fix it before it gets that far.
 */
export const AC_DESC2_MAX = 100;

/**
 * WHERE LINE 1 ENDS when what was typed or pasted is wider than the column.
 *
 * At a word boundary, so the postal content survives in order — this is the
 * address a delivery is printed from, and a truncated one sends goods to the
 * wrong place. A single word wider than the line is broken, because nothing
 * else can be done with it.
 */
export function splitAddressAtLimit(text: string): { head: string; tail: string } {
  if (text.length <= ADDRESS_LINE_MAX) return { head: text, tail: '' };
  const cut = text.lastIndexOf(' ', ADDRESS_LINE_MAX);
  if (cut <= 0) return { head: text.slice(0, ADDRESS_LINE_MAX), tail: text.slice(ADDRESS_LINE_MAX) };
  return { head: text.slice(0, cut), tail: text.slice(cut + 1) };
}

/**
 * PASTING A LONG ADDRESS SPILLS INTO THE NEXT LINE. It never loses the tail.
 *
 * `maxLength` alone would be a REGRESSION here, not a lock: the browser
 * truncates an over-long paste to fit and the rest is gone, where today the
 * write-back re-flows it across the book's four lines on the way out and loses
 * no word (docs/bugs/0728). Staff paste addresses out of WhatsApp all day, so
 * that is the common path, not the corner.
 *
 * `spill` is REQUIRED and may be `null`, which is the last line saying "there
 * is nowhere after me — keep the whole paste here and let the write-back re-flow
 * it into the lines the form does not show". Optional would have meant every
 * caller that said nothing silently kept the truncating behaviour, which is the
 * bug class this repo names optional-param-noop (docs/bugs/0098).
 *
 * When there IS a next line the tail is handed to it WITHOUT being cut to the
 * column: the server stays the referee for anything four lines of forty cannot
 * hold, and this only decides where the FIRST break goes.
 */
export function onAddressPaste(
  e: { currentTarget: HTMLInputElement; clipboardData: DataTransfer; preventDefault: () => void },
  setLine: (v: string) => void,
  spill: { value: string; set: (v: string) => void } | null,
): void {
  const el = e.currentTarget;
  const pasted = e.clipboardData.getData('text').replace(/\s+/g, ' ');
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const merged = el.value.slice(0, start) + pasted + el.value.slice(end);
  /* Inside the column: let the browser do its own paste, caret and all. */
  if (merged.length <= ADDRESS_LINE_MAX) return;
  e.preventDefault();
  if (!spill) { setLine(merged); return; }
  const { head, tail } = splitAddressAtLimit(merged);
  setLine(head);
  spill.set(`${tail} ${spill.value}`.trim());
}

/**
 * THE CAP AND THE SPILL, AS ONE BUNDLE. Spread onto a sales-order address input:
 *
 *   <input value={addr1} {...addressLineProps(setAddr1, { value: addr2, set: setAddr2 })} />
 *   <input value={addr2} {...addressLineProps(setAddr2, null)} />
 *
 * One bundle rather than two attributes because they are not separable: a cap
 * without the spill is the truncating regression, and a spill without the cap
 * does not stop typing. Written apart, the next address input gets one of them.
 */
export function addressLineProps(
  setLine: (v: string) => void,
  spill: { value: string; set: (v: string) => void } | null,
) {
  return {
    maxLength: ADDRESS_LINE_MAX,
    onPaste: (e: { currentTarget: HTMLInputElement; clipboardData: DataTransfer; preventDefault: () => void }) =>
      onAddressPaste(e, setLine, spill),
  };
}
