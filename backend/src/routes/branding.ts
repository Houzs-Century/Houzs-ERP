import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import {
  getBrandingForCompany,
  setBrandingForCompany,
  brandingKeyForCompany,
  resolveCompanyCode,
  type Branding,
} from "../services/branding";
import {
  CONFIG_CACHE_TTL_SECONDS,
  configCacheKeyUrl,
  configCacheMatch,
  configCachePut,
  configCacheVersion,
  toClientResponse,
} from "../services/configCache";
import { audit } from "../services/audit";
import { canonicalizeSinglePhone } from "../scm/shared/phone";

// ── Branding (company identity) ───────────────────────────────
//
// Multi-company: every route here operates on the ACTIVE company's branding
// row (companyContext — the top-bar switcher's X-Company-Id header, falling
// back to the hostname default, falling back to HOUZS). Switching company in
// the top bar therefore IS the "company selector" for Settings → Branding:
// the same UI edits whichever company is active. Single-company installs
// resolve HOUZS and are byte-identical to the pre-multi-company behaviour.
//
// GET  /api/branding — any authenticated user (the global auth middleware
//   already gates /api/*). The frontend reads this for PDF letterheads + the
//   shell chrome, so it must be available to every signed-in user.
// PUT  /api/branding — admin-gated (settings.manage, same as the email
//   settings route). The owner edits the active company's config here.
//
// Logo (2026-07 — owner batch):
// POST   /api/branding/logo — admin-gated raw-binary upload (png/jpg, ≤1 MB).
//   Follows the users.ts profile-pic pattern exactly (raw body + content-type
//   header). Bytes live in R2 (POD_BUCKET) under branding/logo-<ts>.<ext>;
//   the key is stored in the branding config row (logoR2Key).
// GET    /api/branding/logo — any authenticated user; streams the bytes back
//   through the worker (same serve pattern as profile-pic / POD photos) so the
//   PDF generator and <img> can fetch it with the bearer token.
// DELETE /api/branding/logo — admin-gated; clears the pointer and best-effort
//   deletes the R2 object.
//
// Two logo slots (owner 2026-08-06): all three logo routes take an optional
// ?variant=print addressing the SECOND slot (printLogoR2Key), the logo used on
// printed documents. No variant = the on-screen slot (logoR2Key), so every
// pre-existing caller behaves exactly as before. See the Branding interface for
// why one file can't serve both a dark app chrome and white paper.

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  // Active company for this request — companyContext's resolution, or HOUZS
  // on a pre-migration / single-company install where the middleware left it
  // unset. Same per-route pattern below.
  const companyCode = await resolveCompanyCode(c.env, c.get("companyCode"));

  // Shared PER-COMPANY read cache. The company code is resolved FIRST and is
  // a REQUIRED segment of the synthetic key, so key and payload derive from
  // the one same value — company A's entry can never answer company B. A
  // null version (KV unbound / erroring) bypasses caching entirely; the
  // family version is bumped by setBrandingForCompany on every write.
  const version = await configCacheVersion(c.env, "branding");
  const keyUrl =
    version == null
      ? null
      : configCacheKeyUrl(
          new URL(c.req.url).origin,
          "branding",
          `co=${encodeURIComponent(companyCode)}`,
          version,
        );
  if (keyUrl) {
    const hit = await configCacheMatch(keyUrl);
    if (hit) return toClientResponse(hit);
  }

  const branding = await getBrandingForCompany(c.env, companyCode);
  // companyCode rides along so the frontend can pick the matching default set
  // (a blank 2990 field must stay blank, never snap to a Houzs literal).
  const body = JSON.stringify({ branding, companyCode });
  if (keyUrl) {
    await configCachePut(keyUrl, body, CONFIG_CACHE_TTL_SECONDS.branding);
  }
  return c.body(body, 200, {
    "content-type": "application/json",
    "x-config-cache": keyUrl ? "miss" : "bypass",
  });
});

app.put("/", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  let body: Partial<Branding>;
  try {
    body = await c.req.json<Partial<Branding>>();
  } catch {
    return c.json({ error: "We couldn't save those changes. Please try again." }, 400);
  }

  // Company name is the one load-bearing field (it anchors the OCR prompt +
  // every letterhead) — reject a blank/whitespace-only name. Merge the rest
  // over the current row so a partial PUT only updates the fields it sends.
  const companyCode = await resolveCompanyCode(c.env, c.get("companyCode"));
  const current = await getBrandingForCompany(c.env, companyCode);
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v.trim() : fallback;
  const next: Branding = {
    companyName: str(body.companyName, current.companyName),
    registrationNo: str(body.registrationNo, current.registrationNo),
    address: str(body.address, current.address),
    postcode: str(body.postcode, current.postcode),
    // Canonicalised so the phone printed on every document carries a country
    // code, like every other contact number in the system. canonicalizeSingle-
    // Phone REFUSES anything that is not unambiguously one number — this field
    // is free text and has held "03-1234 5678 / 019-876 5432"; normalizePhone
    // would concatenate those into one nonsense string and print THAT on every
    // invoice. Refusing keeps the human's formatting, which is the safe failure.
    phone: canonicalizeSinglePhone(str(body.phone, current.phone)),
    email: str(body.email, current.email),
    website: str(body.website, current.website),
    logoR2Key: str(body.logoR2Key, current.logoR2Key),
    printLogoR2Key: str(body.printLogoR2Key, current.printLogoR2Key),
    // Canonicalised like `phone` above, for the same reason: this number is
    // printed on documents, so it should carry a country code like every other
    // contact in the system — and refusing anything ambiguous keeps the human's
    // formatting rather than concatenating two numbers into nonsense.
    csPhone: canonicalizeSinglePhone(str(body.csPhone, current.csPhone)),
    csEmail: str(body.csEmail, current.csEmail),
  };
  if (next.companyName === "") {
    return c.json({ error: "companyName is required" }, 400);
  }

  await setBrandingForCompany(c.env, companyCode, next, user?.id ?? null);
  await audit(c, {
    action: "settings.branding",
    entityType: "app_setting",
    entityId: brandingKeyForCompany(companyCode),
    summary: `Company branding updated (${companyCode})`,
    meta: { companyName: next.companyName, companyCode },
  });
  return c.json({ branding: next, companyCode });
});

// ── Logo upload / serve / remove ──────────────────────────────

/* Only the two web-safe raster formats the jspdf letterhead can embed.
   Maps the upload's Content-Type to the stored extension. */
const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
};
const LOGO_MAX_BYTES = 1 * 1024 * 1024; // ~1 MB — a letterhead logo, not a photo

/**
 * Which of the two logo slots a request addresses (?variant=print). Two slots
 * exist because the app chrome is DARK and paper is WHITE — see the Branding
 * interface. Anything but "print" (including absent) means the on-screen slot,
 * so every pre-existing caller keeps hitting `logoR2Key` unchanged.
 *
 * A query param rather than separate /logo/print routes: the three verbs
 * already carry the right permissions, and the route-capability matrix stays
 * as it is.
 */
type LogoVariant = "app" | "print";
const variantOf = (raw: string | undefined): LogoVariant =>
  (raw || "").trim().toLowerCase() === "print" ? "print" : "app";
const logoFieldOf = (v: LogoVariant): "logoR2Key" | "printLogoR2Key" =>
  v === "print" ? "printLogoR2Key" : "logoR2Key";

/**
 * POST /api/branding/logo[?variant=print]
 * Raw binary upload of the company logo (admin-gated). The R2 key carries a
 * Date.now() stamp — same convention as profile pics — so every upload yields
 * a NEW key and every consumer (blob-URL previews, the PDF logo memo) can use
 * the key itself as the cache-buster.
 */
app.post("/logo", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  const variant = variantOf(c.req.query("variant"));
  const field = logoFieldOf(variant);
  const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = LOGO_TYPES[contentType];
  if (!ext) {
    return c.json({ error: "Logo must be a PNG or JPG image" }, 415);
  }
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > LOGO_MAX_BYTES) {
    return c.json({ error: "Logo must be under 1 MB" }, 413);
  }

  const companyCode = await resolveCompanyCode(c.env, c.get("companyCode"));
  const slug = variant === "print" ? "print-logo" : "logo";
  const key = `branding/${companyCode.toLowerCase()}-${slug}-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });

  // Point the active company's branding row at the new object; best-effort
  // clean up the previous one (orphans are cheap; a failed delete never fails
  // the upload). Only THIS variant's pointer moves — replacing the print logo
  // must never disturb the one the app chrome renders.
  const current = await getBrandingForCompany(c.env, companyCode);
  const prevKey = current[field];
  const next: Branding = { ...current, [field]: key };
  await setBrandingForCompany(c.env, companyCode, next, user?.id ?? null);
  // A slot may hold the SAME key as the other one only if a future feature
  // copies it; never delete an object the other slot still points at.
  if (prevKey && prevKey !== key && prevKey !== next.logoR2Key && prevKey !== next.printLogoR2Key) {
    try { await c.env.POD_BUCKET.delete(prevKey); } catch { /* orphan is fine */ }
  }

  await audit(c, {
    action: "settings.branding",
    entityType: "app_setting",
    entityId: brandingKeyForCompany(companyCode),
    summary: `Company ${variant === "print" ? "print " : ""}logo uploaded (${companyCode})`,
    meta: { variant, [field]: key, bytes: buf.byteLength, companyCode },
  });
  return c.json({ ok: true, branding: next, companyCode });
});

/**
 * GET /api/branding/logo[?variant=print]
 * Streams the stored logo bytes. Any authed user — the PDF letterhead is
 * drawn client-side by every signed-in user. 404 when that slot is empty;
 * the CALLER decides the fallback (letterheadLogoKey), because the client
 * memoises by key and must know which one it actually got.
 */
app.get("/logo", async (c) => {
  const field = logoFieldOf(variantOf(c.req.query("variant")));
  const branding = await getBrandingForCompany(c.env, await resolveCompanyCode(c.env, c.get("companyCode")));
  if (!branding[field]) return c.json({ error: "No logo uploaded" }, 404);
  const obj = await c.env.POD_BUCKET.get(branding[field]);
  if (!obj) return c.json({ error: "Logo missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=300");
  return new Response(obj.body, { headers });
});

/**
 * DELETE /api/branding/logo[?variant=print]
 * Clears that slot's pointer (admin-gated) and best-effort deletes the object.
 * Clearing the print slot sends the letterheads back to the on-screen logo;
 * clearing the on-screen one with no print logo set falls all the way back to
 * the text-only header.
 */
app.delete("/logo", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  const variant = variantOf(c.req.query("variant"));
  const field = logoFieldOf(variant);
  const companyCode = await resolveCompanyCode(c.env, c.get("companyCode"));
  const current = await getBrandingForCompany(c.env, companyCode);
  const prevKey = current[field];
  const cleared: Branding = { ...current, [field]: "" };
  if (prevKey) {
    await setBrandingForCompany(c.env, companyCode, cleared, user?.id ?? null);
    // Never delete bytes the OTHER slot still points at.
    if (prevKey !== cleared.logoR2Key && prevKey !== cleared.printLogoR2Key) {
      try { await c.env.POD_BUCKET.delete(prevKey); } catch { /* orphan is fine */ }
    }
  }
  await audit(c, {
    action: "settings.branding",
    entityType: "app_setting",
    entityId: brandingKeyForCompany(companyCode),
    summary: `Company ${variant === "print" ? "print " : ""}logo removed (${companyCode})`,
    meta: { variant, [field]: prevKey, companyCode },
  });
  return c.json({ ok: true, branding: cleared, companyCode });
});

export default app;
