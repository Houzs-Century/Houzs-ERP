#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const opts = { url: null, out: null, clicks: [], waitMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--click") opts.clicks.push(argv[++i]);
    else if (a === "--wait-ms") opts.waitMs = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (opts.url) throw new Error(`unexpected argument ${a}`);
    else opts.url = a;
  }
  if (!opts.url) throw new Error("usage: node scripts/verify-probe.mjs <url> [--out <dir>] [--click <selector>]... [--wait-ms n]");
  if (opts.clicks.includes(undefined) || opts.out === undefined) throw new Error("flag is missing its value");
  if (!Number.isFinite(opts.waitMs) || opts.waitMs < 0) throw new Error("--wait-ms must be a non-negative number");
  return opts;
}

export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "data:") return "data:<redacted>";
    return `${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}`;
  } catch {
    return String(raw).split(/[?#]/)[0];
  }
}

export function summarize({ console: logs, network, pageErrors }) {
  const consoleErrors = logs.filter((l) => l.type === "error").length;
  const n = pageErrors.length + consoleErrors;
  const lines = [
    n === 0 ? "PROBE OK" : `PROBE ERRORS ${n}`,
    `page errors: ${pageErrors.length}`,
    `console errors: ${consoleErrors}, warnings: ${logs.length - consoleErrors}`,
    `failed or >=400 requests: ${network.length}`,
  ];
  return { verdict: lines[0], exitCode: n === 0 ? 0 : 1, text: lines.join("\n") + "\n" };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = join(fileURLToPath(import.meta.url), "..", "..");
  const { chromium } = createRequire(join(repo, "frontend", "package.json"))("playwright");
  const out = opts.out ?? join(repo, ".verify", new Date().toISOString().replace(/[:.]/g, "-"));

  let browser;
  for (const channel of [undefined, "chrome", "msedge"]) {
    try {
      browser = await chromium.launch({ channel });
      break;
    } catch (e) {
      if (!/Executable doesn't exist|playwright install|is not found|Chromium distribution/i.test(String(e.message))) throw e;
    }
  }
  if (!browser) {
    console.error("No Chromium found (bundled, Chrome or Edge). Run: npx --prefix frontend playwright install chromium");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const events = { console: [], network: [], pageErrors: [] };
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const loc = m.location();
    events.console.push({ type: m.type(), text: m.text(), url: redactUrl(loc.url), line: loc.lineNumber, column: loc.columnNumber });
  });
  page.on("pageerror", (e) => events.pageErrors.push({ message: e.message, stack: e.stack }));
  page.on("requestfailed", (r) => events.network.push({ method: r.method(), url: redactUrl(r.url()), failure: r.failure()?.errorText ?? null }));
  page.on("response", (r) => {
    if (r.status() >= 400) events.network.push({ method: r.request().method(), url: redactUrl(r.url()), status: r.status() });
  });

  await page.goto(opts.url, { waitUntil: "load" });
  for (const sel of opts.clicks) {
    await page.click(sel);
    await page.waitForTimeout(opts.waitMs);
  }
  await page.waitForTimeout(opts.waitMs);
  await page.screenshot({ path: join(out, "screenshot.png"), fullPage: true });
  await browser.close();

  const s = summarize(events);
  writeFileSync(join(out, "console.json"), JSON.stringify(events.console, null, 2));
  writeFileSync(join(out, "network.json"), JSON.stringify(events.network, null, 2));
  writeFileSync(join(out, "page-errors.json"), JSON.stringify(events.pageErrors, null, 2));
  writeFileSync(join(out, "summary.txt"), `url: ${redactUrl(opts.url)}\n${s.text}`);
  console.log(`${s.verdict} (${out})`);
  process.exit(s.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(2);
  });
}
