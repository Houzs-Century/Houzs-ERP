// ----------------------------------------------------------------------------
// Delivery Order print theme — Theme C "Ink & Petrol" (owner handoff 2026-08-07,
// design project "DO Layout 重新设计" / HANDOFF-delivery-order.md).
//
// The handoff is written as CSS (var(--c-orange), border-radius, @page). The DO
// is drawn by jsPDF, not rendered as HTML — there is no stylesheet to reference,
// so the palette is declared ONCE here, named after the repo's Tailwind DS
// tokens, and every draw call reads it from here. That is the closest thing to
// "reference the token, don't hardcode a new colour" that a PDF can have.
//
// Where the handoff's value IS a DS token, the token's value wins (they agree,
// or differ imperceptibly — noted per entry). Three of the handoff's colours
// have NO token in this repo; they are marked, so a later design pass knows
// exactly which three to reconcile rather than re-deriving the whole set.
// ----------------------------------------------------------------------------

export type Rgb = [number, number, number];

/** mm per point — jsPDF documents here are created with unit: 'mm', while every
 *  font size in the handoff (and in setFontSize) is in points. */
export const PT = 25.4 / 72;

/** Points → mm. */
export const pt = (points: number): number => points * PT;

/** CSS `letter-spacing: <em>` → jsPDF's charSpace, which is in the document's
 *  unit (mm here), not em. */
export const charSpace = (sizePt: number, em: number): number => pt(sizePt) * em;

/**
 * A translucent ink over white paper, flattened. The handoff writes the hairlines
 * and the status chip as rgba(); a PDF fill has no alpha channel, and the paper
 * underneath is always white on a printed document, so the composite is exact
 * rather than an approximation.
 */
const overWhite = (rgb: Rgb, alpha: number): Rgb => [
  Math.round(rgb[0] * alpha + 255 * (1 - alpha)),
  Math.round(rgb[1] * alpha + 255 * (1 - alpha)),
  Math.round(rgb[2] * alpha + 255 * (1 - alpha)),
];

const INK_RGB: Rgb = [34, 31, 32]; // the hairline ink the handoff writes as rgba(34,31,32,…)

export const DO_THEME = {
  // ── Ink ──────────────────────────────────────────────────────────────────
  /** ink.DEFAULT #11140f */
  ink: [17, 20, 15] as Rgb,
  /** ink.secondary #414539 (handoff #4a4f45 — same step, token wins) */
  inkSecondary: [65, 69, 57] as Rgb,
  /** ink.muted #767b6e */
  inkMuted: [118, 123, 110] as Rgb,
  /** HANDOFF-ONLY #9aa093 — the em-dash placeholder tint. No DS token sits
   *  between ink.muted and border.strong; kept as specified. */
  inkFaint: [154, 160, 147] as Rgb,

  // ── Brand ────────────────────────────────────────────────────────────────
  /** primary.DEFAULT #16695f — the handoff calls this --c-orange (the design
   *  project rebinds that name to petrol; this repo's --c-orange is a real
   *  orange, so the NAME is not portable — the value is). */
  petrol: [22, 105, 95] as Rgb,
  /** primary.ink #0c3f39 — the handoff's --c-burnt. */
  burnt: [12, 63, 57] as Rgb,
  /** accent.DEFAULT #a16a2e — eyebrows and the doc-number chip's ink. */
  brass: [161, 106, 46] as Rgb,
  /** accent.soft #f3ece0 (handoff #f5ecd8 — same pale brass, token wins). */
  brassSoft: [243, 236, 224] as Rgb,

  // ── Surfaces ─────────────────────────────────────────────────────────────
  /** surface-2 #f4f6f3 — the handoff's --c-paper. */
  paper: [244, 246, 243] as Rgb,
  white: [255, 255, 255] as Rgb,

  // ── Table + status ───────────────────────────────────────────────────────
  /** HANDOFF-ONLY #2F5D4F — the column-header green, a step between
   *  primary.DEFAULT and primary.ink that this repo has no token for. */
  tableHeadInk: [47, 93, 79] as Rgb,
  /** HANDOFF-ONLY #00695c — the Status chip's ink. */
  statusInk: [0, 105, 92] as Rgb,
  /** rgba(0,150,136,.14) on white. */
  statusBg: overWhite([0, 150, 136], 0.14),

  /** rgba(34,31,32,.12) on white — row rules, panel border, footer rule. */
  line: overWhite(INK_RGB, 0.12),
  /** rgba(34,31,32,.28) on white — signature rules and the dotted fields. */
  lineStrong: overWhite(INK_RGB, 0.28),
} as const;

/**
 * jsPDF ships helvetica / times / courier and nothing else, and the handoff
 * forbids a web font, so the system-UI stack maps to helvetica and the system
 * mono stack maps to courier.
 *
 * `monoFor` exists because that mapping has one sharp edge: a document carrying
 * CJK text has its font redirected by ensurePdfCjkFont, which only rewrites
 * requests for 'helvetica'. A cell asking for 'courier' would keep courier and
 * paint the CJK as mojibake — the exact failure the CJK guard exists to prevent.
 * Mono is a numeric/identifier affordance, so any string that isn't plain ASCII
 * gives it up and stays on the redirectable family.
 */
export const MONO = 'courier';
export const SANS = 'helvetica';

export const monoFor = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  /^[\x00-\x7F]*$/.test(text) ? MONO : SANS;
