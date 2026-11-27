import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_SRC = path.resolve(here, "../../../frontend/src");

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) out.push(p);
  }
  return out;
}

let corpusCache = null;
const labelCache = new Map();

/** All non-test frontend source, raw and whitespace-collapsed (labels split over JSX lines still match). */
export function frontendCorpus() {
  if (corpusCache) return corpusCache;
  const raw = walk(FRONTEND_SRC, []).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const collapsed = raw.replace(/\s+/g, " ");
  const jsxText = collapsed.replace(/>\s+/g, ">").replace(/\s+</g, "<");
  corpusCache = { raw, collapsed, jsxText };
  return corpusCache;
}

/** Does this UI label appear somewhere in frontend/src (outside tests)? */
export function labelInFrontend(label) {
  const c = frontendCorpus();
  const l = label.replace(/\s+/g, " ").trim();
  if (!l) return false;
  if (labelCache.has(l)) return labelCache.get(l);
  const hit = c.raw.includes(l) || c.collapsed.includes(l) || c.jsxText.includes(l) || c.raw.includes(l.replace(/&/g, "&amp;"));
  labelCache.set(l, hit);
  return hit;
}

let routesCache = null;

/** Every `path="..."` route pattern in frontend/src/App.tsx. */
export function frontendRoutes() {
  if (routesCache) return routesCache;
  const app = fs.readFileSync(path.join(FRONTEND_SRC, "App.tsx"), "utf8");
  const out = new Set();
  for (const m of app.matchAll(/path="([^"]+)"/g)) out.add(m[1]);
  routesCache = [...out].filter((p) => p !== "*");
  return routesCache;
}

/** Does the page (path, optional ?query) resolve to a route in App.tsx? A `:param` segment matches anything. */
export function routeExists(page) {
  const p = page.split("?")[0].split("#")[0];
  const segs = p.split("/");
  return frontendRoutes().some((r) => {
    const rs = r.split("/");
    if (rs.length !== segs.length) return false;
    return rs.every((s, i) => s.startsWith(":") || segs[i].startsWith(":") || s === segs[i]);
  });
}

/** The double-quoted UI labels in a sentence. */
export function quotedLabels(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

let backendCache = null;

/** All non-test backend/src TypeScript except the help data itself (mcp-howto*, mcp-screen*). */
export function backendCorpus() {
  if (backendCache) return backendCache;
  const dir = path.resolve(here, "../../src");
  const files = walk(dir, []).filter((f) => f.endsWith(".ts") && !/[\/]mcp-(howto|screen)/.test(f));
  backendCache = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  return backendCache;
}

const REPO = path.resolve(here, "../../..");

/** Read a repo file (relative to the repo root), or null when it does not exist. */
export function readRepoFile(rel) {
  const p = path.join(REPO, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") : null;
}

/** Write a repo file (relative to the repo root), creating its folder. */
export function writeRepoFile(rel, content) {
  const p = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** True when the caller asked to regenerate files (HOWTO_WRITE=1). */
export const WRITE_MODE = process.env.HOWTO_WRITE === "1";
