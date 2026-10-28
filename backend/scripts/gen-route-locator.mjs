// ---------------------------------------------------------------------------
// gen-route-locator.mjs — emits docs/generated/route-locator.md, the "house
// number" layer of code navigation.
//
// WHY THIS EXISTS. docs/generated/route-capability-matrix.csv already answers
// "which FILE is this endpoint in, and what gates it" for 900+ routes. What it
// does NOT give is the LINE. So an agent (or a human) still lands in a file like
// mfg-sales-orders.ts — 10,873 lines, 111 endpoints — and has to scan to find
// the handler. That scan is the slow, token-hungry part of AI-assisted work here
// (see docs/AI-DEV-VELOCITY.md): country -> state -> city -> postcode is covered
// by the map + module guides + capability matrix; this file adds the postcode's
// house number, so you jump straight to the line instead of reading the street.
//
// Usage:
//   node backend/scripts/gen-route-locator.mjs           # rewrite the artifact
//   node backend/scripts/gen-route-locator.mjs --check    # exit 1 if it drifted
//
// --check IS NOT A CI GATE, on purpose — same reasoning as gen-codebase-map.mjs:
// a navigation doc going stale must never block a deploy. Regenerate it when you
// touch routes, or let a future `audit:*` habit run it.
//
// NO DEPENDENCIES, deliberately (node:fs / node:path only) so it runs in a fresh
// worktree where `npm install` is unavailable. The scanner is hand-rolled and
// strips comments first, so a route pattern mentioned in a comment is never
// counted as a route.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sameIgnoringEol } from "./lib/eol.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(backendRoot, "..");
const outputPath = path.join(repoRoot, "docs", "generated", "route-locator.md");
const checkOnly = process.argv.includes("--check");

const SRC_DIRS = [path.join(backendRoot, "src")];
const METHODS = "get|post|put|patch|delete";
// A route registration: <router>.<method>( '<path starting with />'
// The leading-slash requirement excludes context accessors like c.get('supabase').
const ROUTE_RE = new RegExp(
  `\\b([A-Za-z_][A-Za-z0-9_]*)\\.(${METHODS})\\s*\\(\\s*['"\\\`](/[^'"\\\`]*)`,
);

function walk(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

// Strip /* */ block comments and // line comments so a route mentioned in prose
// is not scanned as code. Route paths never contain "//" or "/*", so cutting at
// the first occurrence on a code line is safe here.
function stripComments(lines) {
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return "";
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Remove any inline /* ... */ on the same line.
    line = line.replace(/\/\*.*?\*\//g, "");
    /* CUT THE LINE COMMENT FIRST. It used to run last, so a `//` comment that
       merely MENTIONED a wildcard path — "// Mounted at /api/sync/... above the
       /api/* wall" — had its `/api/*` read as an OPENING block comment. inBlock
       then stayed true to end of file and every route below it vanished. Five
       routers (addons, maintenance-config, pos-cart, public-images, so-mirror)
       and their registrations were missing from route-locator.md this way.

       That matters more than a wrong count: CLAUDE.md tells every session to
       grep this artifact for a line number before opening a multi-thousand-line
       router. A missing router reads as "no such endpoint". */
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    const openBlock = line.indexOf("/*");
    if (openBlock !== -1) {
      inBlock = true;
      line = line.slice(0, openBlock);
    }
    return line;
  });
}

const files = SRC_DIRS.flatMap((dir) =>
  walk(dir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
).sort();

const perFile = [];
let total = 0;
for (const file of files) {
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  const rawLines = fs.readFileSync(file, "utf8").split("\n");
  const cleaned = stripComments(rawLines);
  const routes = [];
  cleaned.forEach((line, i) => {
    const m = line.match(ROUTE_RE);
    if (m) routes.push({ line: i + 1, method: m[2].toUpperCase(), path: m[3] });
  });
  if (routes.length) {
    routes.sort((a, b) => a.line - b.line);
    perFile.push({ rel, routes });
    total += routes.length;
  }
}

perFile.sort((a, b) => b.routes.length - a.routes.length || a.rel.localeCompare(b.rel));

const lines = [];
lines.push("# Route Locator (generated)");
lines.push("");
lines.push(
  "Every backend route registration with its FILE and LINE, so you can jump",
);
lines.push(
  "straight to a handler instead of scanning a multi-thousand-line file. Pair",
);
lines.push(
  "with `route-capability-matrix.csv` (which carries the full mount path +",
);
lines.push(
  "permission gates). Generated by `backend/scripts/gen-route-locator.mjs` —",
);
lines.push("do not hand-edit; regenerate after touching routes.");
lines.push("");
lines.push(`Total: ${total} route registrations across ${perFile.length} files.`);
lines.push("");
for (const { rel, routes } of perFile) {
  lines.push(`## ${rel}  (${routes.length})`);
  for (const r of routes) {
    lines.push(`- L${r.line}  ${r.method.padEnd(6)} ${r.path}`);
  }
  lines.push("");
}
const output = lines.join("\n");

if (checkOnly) {
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  // Content, not line endings — see scripts/lib/eol.mjs.
  if (!sameIgnoringEol(existing, output)) {
    console.error("route-locator.md is stale — run: node backend/scripts/gen-route-locator.mjs");
    process.exit(1);
  }
  console.log(`route-locator.md up to date (${total} routes).`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
console.log(`Wrote ${outputPath} — ${total} routes across ${perFile.length} files.`);
