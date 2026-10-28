/**
 * QR helpers for the ASSR print routes.
 *
 * - `qrSvg(text)` renders a black-on-white SVG QR code as a string,
 *   ready to drop into HTML. Inline SVG (not a data URI / image src)
 *   prints crisp at any size without an external request and survives
 *   PDF rasterisation cleanly.
 * - `getOrIssueCustomerPortalToken` reuses the existing idempotent
 *   `issueStaffToken` (mig 064 era — `case_track_tokens` with
 *   30-day TTL) so the QR on Customer Print encodes the same URL
 *   the "Copy portal link" button produces. No duplicate tokens.
 */
// @ts-ignore — qrcode-generator ships its own .d.ts but the typings
// don't always resolve cleanly under Workers' resolver. Library is
// pure JS and stable.
import qrcode from "qrcode-generator";
import type { Env } from "../types";
import { issueStaffToken } from "./caseTracking";

/**
 * Render a QR code as an inline SVG string.
 *
 * Defaults:
 *   - errorCorrection: 'M' (medium — same trade-off most QR readers
 *     handle robustly across phone cameras)
 *   - typeNumber: 0 (let the library auto-pick the smallest version
 *     that fits the payload)
 *   - cellSize: 4px per module (yields ~100-160px SVG for typical
 *     short URLs; CSS scales it to the slot)
 */
export function qrSvg(text: string, cellSizePx = 4): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count * cellSizePx;

  // Build the SVG by hand instead of using the library's
  // createSvgTag — gives us control over inline styling, viewBox,
  // and removes the library's outer whitespace.
  const cells: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        cells.push(
          `<rect x="${c * cellSizePx}" y="${r * cellSizePx}" width="${cellSizePx}" height="${cellSizePx}"/>`
        );
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<g fill="#000">${cells.join("")}</g>`,
    `</svg>`,
  ].join("");
}

/**
 * Reuse-or-issue a customer-portal token for the given case.
 * Identical semantics to the "Copy portal link" staff button — if
 * an unexpired staff token exists, returns it; otherwise mints a
 * fresh 30-day one.
 */
export async function getOrIssueCustomerPortalToken(
  env: Env,
  assrId: number,
): Promise<string> {
  return issueStaffToken(env, assrId);
}

/**
 * Build the full customer portal URL the QR encodes. Pulls origin
 * from `PUBLIC_APP_URL` (the same var the email templates read), so
 * a Pages preview deploy renders QRs that resolve back to the same
 * preview environment.
 */
export function customerPortalUrlFor(env: Env, token: string): string {
  const origin = (env as any).PUBLIC_APP_URL || "https://erp.houzscentury.com";
  return `${String(origin).replace(/\/$/, "")}/portal/case/${token}`;
}
