#!/usr/bin/env node
/**
 * capture-help-shots.mjs — screenshots for the AI Connector's show_me tool.
 *
 * Runs the LOCAL frontend (vite) with demo data only: every /api call is answered inside this
 * script with fake data, every other host is blocked, and the "login" is a fake local token.
 * No production data, no real customer names, no money, no credentials are ever involved.
 *
 * For each page in the screen map and each how-to step page, it opens the page at desktop width,
 * finds every known label with the same matcher the ?highlight= helper uses, saves a compressed
 * WebP of the viewport (frontend/public/help-shots/<slug>.webp) and the boxes
 * (backend/src/services/mcp-help-shots.json).
 *
 * Usage: npm run capture:help-shots            (all pages)
 *        npm run capture:help-shots -- /scm/grns /assr?view=cases   (only these)
 * Env:   CHROME=<path to chrome / chrome-headless-shell> if Playwright's own browser is not installed.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fe = path.join(repo, "frontend");
const req = createRequire(path.join(fe, "package.json"));
const { chromium } = req("playwright");
const sharp = req("sharp");
const esbuild = req("esbuild");

const PORT = Number(process.env.HELP_SHOTS_PORT ?? 5199);
const BASE = `http://localhost:${PORT}`;
const VIEW = { width: 1440, height: 900 };
const OUT_W = 1200;
const QUALITY = 45;
const SHOT_DIR = path.join(fe, "public", "help-shots");
const BOX_JSON = path.join(repo, "backend", "src", "services", "mcp-help-shots.json");
fs.mkdirSync(path.join(repo, ".verify"), { recursive: true });
const tmp = fs.mkdtempSync(path.join(repo, ".verify", "help-shots-"));

async function bundle(entry, format, globalName) {
  const outfile = path.join(tmp, `${path.basename(entry)}.${format === "iife" ? "js" : "mjs"}`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format, globalName, platform: format === "iife" ? "browser" : "node", outfile, logLevel: "silent", loader: { ".json": "json" } });
  return outfile;
}

const slug = (p) => (p.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "home").slice(0, 80);

const demoUser = { id: 1, email: "demo@example.test", name: "Demo User", role_id: 1, role_name: "Owner", status: "active", permissions: ["*"], page_access: {}, scm_l2_configured: false, capabilities: {} };
const FIXED = {
  "/api/auth/me": { user: demoUser },
  "/api/auth/status": { has_users: true },
  "/api/notifications": { feed: [], unread_by_project: {}, total_unread: 0, points_balance: 0, gifting_balance: 0, current_streak: 0 },
  "/api/presence": { active: [], away: [], count: 0, window_seconds: 300 },
  "/api/companies": { companies: [{ id: 1, code: "HOUZS", name: "Demo Company" }], activeCompanyId: 1, activeCompanyCode: "HOUZS" },
  "/api/table-layouts": { companies: [], activeCompanyId: 1, canManageDefaults: false },
};
const OBJECT_ENDPOINTS = ["/api/branding", "/api/badge-counts", "/api/it-support/status", "/api/announcements/banner", "/api/presence/heartbeat"];

const EMPTY_OBJECT = { data: [], items: [], rows: [], results: [], list: [], total: 0, count: 0, page: 1, summary: {}, counts: {}, stats: {} };
let mode = "array";

const PROXY_JSON = `(() => {
  if (!location.hash.includes("hzproxy")) return;
  const plain = (t, p) => typeof p === "symbol" || p in t;
  const strish = (p) => typeof p === "string" && (p in String.prototype || p in Number.prototype);
  const empty = () => new Proxy([], { get: (t, p) => (plain(t, p) ? Reflect.get(t, p) : p === "then" || p === "toJSON" ? undefined : strish(p) ? () => "" : empty()) });
  const arrayish = (t, p) => !Array.isArray(t) && (p === Symbol.iterator || p === "length" || (typeof p === "string" && p in Array.prototype));
  const wrap = (v) => (v && typeof v === "object" ? new Proxy(v, { get: (t, p) => { if (!(p in t) && arrayish(t, p)) { const a = []; const x = a[p]; return typeof x === "function" ? x.bind(a) : x; } if (plain(t, p)) { const x = Reflect.get(t, p); return x && typeof x === "object" ? wrap(x) : x; } return p === "then" || p === "toJSON" ? undefined : empty(); } }) : v);
  const json = Response.prototype.json;
  Response.prototype.json = async function () { const v = await json.call(this); return this.url.includes("/api/") && !this.url.includes("/api/auth/") ? wrap(v) : v; };
})();`;

function demoResponse(pathname) {
  if (FIXED[pathname]) return FIXED[pathname];
  if (pathname.endsWith("/pending-count")) return { count: 0 };
  if (OBJECT_ENDPOINTS.includes(pathname)) return {};
  if (mode === "proxy") return {};
  return mode === "array" ? [] : EMPTY_OBJECT;
}

async function startVite() {
  const child = spawn(process.execPath, [path.join(fe, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORT), "--strictPort"], { cwd: fe, env: { ...process.env, VITE_API_URL: BASE }, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return child;
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
  child.kill();
  throw new Error("vite did not start");
}

async function main() {
  const dataFile = await bundle(path.join(repo, "backend", "src", "services", "mcp-help-shot-targets.ts"), "esm");
  const { helpShotTargets } = await import(pathToFileURL(dataFile).href);
  const only = process.argv.slice(2);
  const targets = helpShotTargets().filter((t) => !only.length || only.includes(t.page));
  const matcher = await bundle(path.join(fe, "src", "lib", "highlight-match.ts"), "iife", "__hzMatch");
  const matcherJs = `${fs.readFileSync(matcher, "utf8")}\nwindow.__hzMatch = __hzMatch;`;

  const vite = await startVite();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "localhost") return route.abort();
    if (u.pathname.startsWith("/api/")) return route.fulfill({ json: demoResponse(u.pathname) });
    return route.continue();
  });
  await ctx.addInitScript(() => localStorage.setItem("auth:token", "demo-local-token"));
  await ctx.addInitScript(matcherJs);
  await ctx.addInitScript(PROXY_JSON);

  const prev = fs.existsSync(BOX_JSON) ? JSON.parse(fs.readFileSync(BOX_JSON, "utf8")) : { shots: {} };
  const shots = only.length ? { ...prev.shots } : {};
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const failed = [];
  const page = await ctx.newPage();
  let lastCrash = "";
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("route-crash")) lastCrash = m.text().split("\n").slice(0, 2).join(" ").slice(0, 300);
  });
  for (const t of targets) {
    lastCrash = "";
    try {
      let rendered = false;
      for (const m of ["array", "object", "proxy"]) {
        mode = m;
        await page.goto("about:blank");
        await page.goto(`${BASE}${t.page}${m === "proxy" ? "#hzproxy" : ""}`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(1200);
        const body = await page.locator("body").innerText();
        if (!/Something went wrong loading this page|Welcome back/.test(body.slice(0, 3000))) {
          rendered = true;
          break;
        }
      }
      if (!rendered) throw new Error(`page did not render with demo data ${lastCrash}`);
      const boxes = await page.evaluate((labels) => {
        const out = {};
        for (const l of labels) {
          const el = window.__hzMatch.findHighlightTarget(document, l);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
          out[l] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        }
        return out;
      }, t.labels);
      if (!Object.keys(boxes).length) throw new Error("no label visible");
      const png = await page.screenshot({ type: "png" });
      const file = `${slug(t.page)}.webp`;
      await sharp(png).resize({ width: OUT_W }).webp({ quality: QUALITY }).toFile(path.join(SHOT_DIR, file));
      const k = OUT_W / VIEW.width;
      const scaled = Object.fromEntries(Object.entries(boxes).map(([l, b]) => [l, b.map((v) => Math.round(v * k))]));
      shots[t.page] = { file, w: OUT_W, h: Math.round(VIEW.height * k), boxes: scaled };
      process.stdout.write(`ok   ${t.page} (${Object.keys(scaled).length}/${t.labels.length} labels)\n`);
    } catch (e) {
      failed.push(t.page);
      await page.screenshot({ path: path.join(repo, ".verify", `failed-${slug(t.page)}.png`) }).catch(() => {});
      process.stdout.write(`skip ${t.page}: ${String(e.message).split("\n")[0].slice(0, 300)}\n`);
    }
  }
  await browser.close();
  vite.kill();

  const keep = new Set(Object.values(shots).map((s) => s.file));
  for (const f of fs.readdirSync(SHOT_DIR)) if (!keep.has(f)) fs.rmSync(path.join(SHOT_DIR, f));
  const sorted = Object.fromEntries(Object.entries(shots).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BOX_JSON, `${JSON.stringify({ note: "Generated by scripts/capture-help-shots.mjs from the local dev server with demo data. Re-capture: npm run capture:help-shots", viewport: VIEW, shots: sorted }, null, 1)}\n`);
  const bytes = [...keep].reduce((n, f) => n + fs.statSync(path.join(SHOT_DIR, f)).size, 0);
  const labels = Object.values(sorted).reduce((n, s) => n + Object.keys(s.boxes).length, 0);
  console.log(`\n${keep.size} shots, ${labels} boxed labels, ${(bytes / 1048576).toFixed(2)} MB; skipped ${failed.length}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
