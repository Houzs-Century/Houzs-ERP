// Regenerate the PWA install icons so the INSTALLED app icon (Chrome "Install
// app", Android/desktop home screen, iOS home screen) matches the clean HC
// mark the custom install banner renders — a pure-white HC silhouette on the
// brand-dark slab, exactly the Sidebar/PwaBanners treatment (brightness-0 +
// invert of the black mark on `bg-ink`/sidebar dark).
//
// WHY a script and not hand-drawn PNGs: the source of truth is the vector-clean
// mark `public/logo-hc-mark.png` (black glyph on transparent). We recolor its
// alpha to white and composite it centered on the brand-dark square at each
// size, so every icon is derived from the same clean asset and stays in sync if
// the mark is ever updated. Run: `node scripts/gen-pwa-icons.mjs` from frontend/.
//
// NOTE: the browser-TAB favicons (favicon-192/512.png) are intentionally a
// different asset — black mark on transparent, clean on light tab bars — and are
// deliberately NOT touched here (see index.html).

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const SRC = join(PUBLIC, "logo-hc-mark.png");

// Brand dark = manifest theme_color/background_color + html theme-color meta +
// the Sidebar slab (#13201c). This is what the OS composites the installed icon
// and splash against, so the icon background matches the surrounding chrome.
const BRAND_DARK = { r: 0x13, g: 0x20, b: 0x1c, alpha: 1 };

// Build a pure-white silhouette of the mark, trimmed to its glyph bounding box
// so padding is computed against the actual mark, not the source's transparent
// margin.
async function whiteMark() {
  const trimmed = await sharp(SRC).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
  const { width, height } = trimmed.info;
  const { data: alpha } = await sharp(trimmed.data).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

// Composite the white mark, scaled to `innerRatio` of the canvas, centered on a
// full-bleed brand-dark square.
async function render(mark, size, innerRatio, outFile) {
  const inner = Math.round(size * innerRatio);
  const scaled = await sharp(mark)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BRAND_DARK } })
    .composite([{ input: scaled, gravity: "center" }])
    .png()
    .toFile(join(PUBLIC, outFile));
  console.log(`wrote ${outFile} — ${size}x${size}, mark ${Math.round(innerRatio * 100)}%`);
}

const mark = await whiteMark();

// "any" icons + iOS home screen: banner-matching ~62% padded mark, full-bleed.
await render(mark, 192, 0.62, "icon-192.png");
await render(mark, 512, 0.62, "icon-512.png");
await render(mark, 180, 0.62, "apple-touch-icon.png");

// Maskable: mark must survive a circular mask, so keep the square glyph inside
// the 80% safe zone. A square inscribed in the safe circle → width <= 0.8/sqrt2
// ~= 0.566, so 0.56 keeps the glyph fully inside whatever mask Android applies.
await render(mark, 512, 0.56, "icon-512-maskable.png");

console.log("done.");
