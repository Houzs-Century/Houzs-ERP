import { boxOn, firstBox, SHOT_NOTE, SHOTS, type ShotHit } from "./mcp-help-shots";

export { SHOT_NOTE };
import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { erpLink } from "./mcp-howto-types";
import { screenForPath, whereIs } from "./mcp-screen";

/** Find the picture for show_me's arguments: a guide step, a page (+ label), or a label alone. */
export function resolveShot(args: { path?: string; guide_id?: string; step?: number; label?: string }): ShotHit | null {
  const label = (args.label ?? "").trim();
  if (args.guide_id) {
    const g = HOWTO_GUIDES.find((x) => x.id === args.guide_id);
    if (!g) return null;
    const steps = g.steps.filter((s) => s.page && s.highlight);
    const want = args.step && args.step > 0 ? g.steps[args.step - 1] : steps.length ? steps[0] : undefined;
    if (!want?.page || !want.highlight) return null;
    return boxOn(want.page, want.highlight);
  }
  if (args.path) {
    const screen = screenForPath(args.path);
    const raw = args.path.replace(/^https?:\/\/[^/]+/i, "");
    const pages = [raw, screen?.path ?? "", raw.split("?")[0]].filter(Boolean);
    for (const p of pages) {
      const hit = label ? boxOn(p, label) : firstBox(p);
      if (hit) return hit;
    }
    return null;
  }
  if (!label) return null;
  for (const w of whereIs(label)) {
    const hit = boxOn(w.screen.path, label) ?? (w.action ? boxOn(w.screen.path, w.action.label) : null);
    if (hit) return hit;
  }
  for (const p of Object.keys(SHOTS)) {
    const hit = boxOn(p, label);
    if (hit) return hit;
  }
  return null;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The annotated picture: the screenshot, a red box around the element, an arrow to it and a caption. */
export function annotatedSvg(hit: ShotHit, webpBase64: string, caption: string): string {
  const { w, h } = hit.shot;
  const [x, y, bw, bh] = hit.box;
  const pad = 6;
  const bx = Math.max(0, x - pad);
  const by = Math.max(0, y - pad);
  const tipX = bx + (bw + pad * 2) / 2;
  const below = by < 120;
  const tipY = below ? by + bh + pad * 2 : by;
  const tailX = Math.min(Math.max(tipX + (tipX > w / 2 ? -110 : 110), 10), w - 10);
  const tailY = below ? Math.min(tipY + 90, h - 10) : Math.max(tipY - 90, 10);
  const ang = Math.atan2(tipY - tailY, tipX - tailX);
  const head = (d: number) => `${tipX - 16 * Math.cos(ang + d)},${tipY - 16 * Math.sin(ang + d)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + 44}" viewBox="0 0 ${w} ${h + 44}">
<image href="data:image/webp;base64,${webpBase64}" x="0" y="0" width="${w}" height="${h}"/>
<rect x="${bx}" y="${by}" width="${bw + pad * 2}" height="${bh + pad * 2}" rx="6" fill="none" stroke="#e11d48" stroke-width="4"/>
<line x1="${tailX}" y1="${tailY}" x2="${tipX}" y2="${tipY}" stroke="#e11d48" stroke-width="5" stroke-linecap="round"/>
<polygon points="${tipX},${tipY} ${head(0.45)} ${head(-0.45)}" fill="#e11d48"/>
<rect x="0" y="${h}" width="${w}" height="44" fill="#1f2937"/>
<text x="14" y="${h + 28}" font-family="Arial, sans-serif" font-size="17" fill="#ffffff">${esc(caption)}</text>
</svg>`;
}

/** A small HTML page holding the annotated picture, for the 15-minute link. */
export const annotatedHtml = (svg: string, title: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;background:#111;display:flex;justify-content:center}svg{max-width:100%;height:auto}</style></head><body>${svg}</body></html>`;

/** What show_me hands back besides the picture itself. */
export function showMeText(hit: ShotHit, origin: string, annotatedLink: string | null) {
  return {
    caption: `Press "${hit.label}" (red box)`,
    page: hit.page,
    box: { x: hit.box[0], y: hit.box[1], width: hit.box[2], height: hit.box[3], imageWidth: hit.shot.w, imageHeight: hit.shot.h },
    ...(annotatedLink ? { annotatedImage: annotatedLink, expires: "15 minutes" } : {}),
    openThePage: erpLink(origin, hit.page, hit.label) ?? hit.page,
    note: SHOT_NOTE,
  };
}

/** show_me's tool definition. */
export const SHOW_ME_TOOL = {
  name: "show_me",
  title: "Show me where to click (annotated screenshot)",
  description: "A picture of the real ERP screen with a red box and an arrow on the button to press, plus a link that opens the real page with that button highlighted. Pass guide_id (+ step) from how_to, or path (+ label) from where_is / explain_screen, or just label. The screenshot uses test data; the layout is the same.",
  inputSchema: {
    type: "object",
    properties: {
      guide_id: { type: "string", description: "A how_to guide id" },
      step: { type: "number", description: "Step number in that guide (default: the first step with a button)" },
      path: { type: "string", description: "ERP page path, e.g. /scm/purchase-orders" },
      label: { type: "string", description: "The button / tab label, e.g. New Purchase Order" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
} as const;
