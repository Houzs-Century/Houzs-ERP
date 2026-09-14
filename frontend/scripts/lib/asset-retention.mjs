// Pure rules for carrying the PREVIOUS builds' hashed files into the next
// Cloudflare Pages deployment. No I/O here; retain-previous-assets.mjs does that.
//
// WHY. A Pages deployment is atomic: the new one serves exactly the files it was
// uploaded with, so every deploy removed the last build's chunks. A tab still on
// that build then asked for them and got 404 — on 2026-09-14 staff printing
// HC-SO-012016 got "Failed to fetch dynamically imported module:
// …/assets3/sales-order-pdf-C9QaiR37.js". Carrying the old files forward is how
// the build a tab booted from stays fetchable.
//
// WHY A NAME COLLISION CANNOT HAPPEN (and is still checked). Vite names every
// file in the assets dir `<name>-<content hash>.<ext>`, so the same name means
// the same bytes. Measured 2026-09-14 on this tree: two builds, 170 shared names,
// 0 whose bytes differed; all 561 files matched the hashed-name shape. The plan
// below still compares sha256 for a shared name, reports a mismatch as a
// collision, and lets the NEW build win — never an old file over a new one.

import { createHash } from "node:crypto";

export const MANIFEST_NAME = "asset-manifest.json";
export const MANIFEST_VERSION = 1;

/** A file directly inside `assets`, `assets2`, `assets3`, … with a plain name.
 *  Anything else in a manifest (a traversal, a nested path, index.html) is refused,
 *  because the manifest is read back from the live site. */
export const ASSET_PATH_RE = /^assets\d*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Parse the live manifest. Never throws; a bad file reads as "no manifest". */
export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { manifest: null, reason: "not JSON" };
  }
  if (!raw || typeof raw !== "object" || raw.version !== MANIFEST_VERSION) {
    return { manifest: null, reason: `unsupported version ${raw?.version}` };
  }
  if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) {
    return { manifest: null, reason: "no files map" };
  }
  const files = {};
  let dropped = 0;
  for (const [path, entry] of Object.entries(raw.files)) {
    const ok =
      entry &&
      typeof entry === "object" &&
      SHA256_RE.test(String(entry.sha256)) &&
      Number.isFinite(entry.size) &&
      entry.size >= 0 &&
      Number.isFinite(Date.parse(entry.lastBuiltAt));
    if (ok) files[path] = { sha256: entry.sha256, size: entry.size, lastBuiltAt: entry.lastBuiltAt };
    else dropped++;
  }
  const builds = Array.isArray(raw.builds) ? raw.builds.filter((b) => b && typeof b === "object") : [];
  return { manifest: { version: MANIFEST_VERSION, builds, files }, reason: dropped ? `${dropped} malformed entries dropped` : null };
}

/**
 * Decide what to carry.
 *   built          files of the NEW build ({path, sha256, size})
 *   previous       parsed live manifest, or null
 *   otherFileCount files in dist that are not `built` (index.html, icons, fonts…)
 *   maxFiles       ceiling for the whole deployment (Pages: 20,000)
 * The newest carried files survive the ceiling; the oldest are dropped first.
 */
export function planRetention({ built, previous, now, retentionMs, maxFiles, otherFileCount, maxFileBytes }) {
  const nowMs = Date.parse(now);
  const builtByPath = new Map(built.map((f) => [f.path, f]));
  const pruned = { expired: [], overLimit: [], unsafe: [], tooLarge: [] };
  const collisions = [];
  const candidates = [];

  for (const [path, entry] of Object.entries(previous?.files ?? {})) {
    const mine = builtByPath.get(path);
    if (mine) {
      if (mine.sha256 !== entry.sha256) collisions.push(path);
      continue;
    }
    if (!ASSET_PATH_RE.test(path)) pruned.unsafe.push(path);
    else if (entry.size > maxFileBytes) pruned.tooLarge.push(path);
    else if (nowMs - Date.parse(entry.lastBuiltAt) > retentionMs) pruned.expired.push(path);
    else candidates.push({ path, ...entry });
  }

  candidates.sort((a, b) => Date.parse(b.lastBuiltAt) - Date.parse(a.lastBuiltAt) || a.path.localeCompare(b.path));
  const room = Math.max(0, maxFiles - otherFileCount - built.length);
  const carry = candidates.slice(0, room);
  for (const f of candidates.slice(room)) pruned.overLimit.push(f.path);

  return { carry, pruned, collisions };
}

/** Why a downloaded body must not be written, or null when it is the exact file. */
export function acceptDownload({ status, contentType, body }, expected) {
  if (status !== 200) return `http-${status}`;
  // The 2026-07-31 edge-poison shape: the SPA shell served at 200 under a .js URL.
  if (/text\/html/i.test(contentType ?? "")) return "html";
  if (body.length !== expected.size || sha256(body) !== expected.sha256) return "hash-mismatch";
  return null;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The manifest the NEW deployment serves, for the deploy after it to read. */
export function finalizeManifest({ built, carried, now, sha, previous }) {
  const files = {};
  for (const f of carried) files[f.path] = { sha256: f.sha256, size: f.size, lastBuiltAt: f.lastBuiltAt };
  for (const f of built) files[f.path] = { sha256: f.sha256, size: f.size, lastBuiltAt: now };
  const builds = [{ sha, builtAt: now, files: built.length }, ...(previous?.builds ?? [])].slice(0, 200);
  return { version: MANIFEST_VERSION, generatedAt: now, builds, files };
}
