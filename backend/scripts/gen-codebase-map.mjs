// ---------------------------------------------------------------------------
// gen-codebase-map.mjs — emits docs/generated/codebase-map-facts.md, the
// MECHANICAL half of the codebase map.
//
// WHY THIS EXISTS. docs/CODEBASE-MAP.md was 100% hand-written and rotted
// silently: by 2026-07-21 it claimed "82 route modules" against a real 122, and
// four whole subsystems (Sales Report, scan-to-SO, Announcements, the mobile
// layer) returned zero hits in it. Counts, inventories and file sizes are the
// part a human always gets wrong, so they are DERIVED here and the hand-written
// map links to this file instead of restating it. Nothing in the output is
// typed by hand; every line is computed from the tree.
//
// Usage:
//   node backend/scripts/gen-codebase-map.mjs           # rewrite the artifact
//   node backend/scripts/gen-codebase-map.mjs --check    # exit 1 if it drifted
//   npm --prefix backend run audit:map                   # same as --check
//
// --check IS NOT A CI GATE, ON PURPOSE. The sibling route-capability gate
// (audit:routes) blocks deploys when its artifact is stale, and that jammed
// prod + staging twice on 2026-07-21 (BUG-HISTORY). A navigation DOC going
// stale is not a reason to stop shipping code. Run --check when you touch the
// map, or when you want to know how far it has drifted; nothing runs it for you.
//
// NO DEPENDENCIES, DELIBERATELY. The sibling generator imports `typescript`,
// which means it cannot run in a fresh git worktree — and `npm install` in a
// worktree destroys the main checkout's node_modules, so installing is not the
// answer. This script uses only node:fs / node:path so it runs anywhere the
// repo is checked out. That is why the scanners below are hand-rolled instead
// of AST-based; they strip comments and string bodies first so a route pattern
// mentioned in a comment can never be counted as a route.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(backendRoot, "..");
const outputPath = path.join(repoRoot, "docs", "generated", "codebase-map-facts.md");
const checkOnly = process.argv.includes("--check");

const TOP_FILES = 20;
const HTTP_METHODS = "get|post|put|patch|delete";

function rel(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walk(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, keep);
    return entry.isFile() && keep(entry.name) ? [full] : [];
  });
}

// Node's ICU locale differs between Windows dev machines and Ubuntu Actions, so
// localeCompare would order a checked-in artifact differently per runtime.
// Relational string comparison is defined by UTF-16 code units and is stable.
function byCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Line count that does not depend on how git checked the file out (CRLF on
 *  Windows, LF in CI) and does not count a trailing newline as a line. */
function lineCount(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** Blank out comments and string/template bodies, preserving length and line
 *  breaks, so pattern scans below cannot match commented-out or quoted code. */
function blankNonCode(text) {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === quote) break;
        else j += 1;
      }
      i = Math.min(j + 1, n);
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// ── Backend route inventory ────────────────────────────────────────────────
// An endpoint is `<identifier>.<method>("/...")` — the Hono registration shape
// used by every router in this repo. Requiring the first argument to be a
// literal beginning with "/" is what keeps Map#delete / Headers#get out of the
// count. Scanned on the ORIGINAL text (comments blanked first via a mask) so
// template-literal paths (`/${base}/status`) are counted too.
function countEndpoints(text) {
  const masked = blankNonCode(text);
  const re = new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:${HTTP_METHODS})\\s*\\(\\s*["'\`]/`, "g");
  let count = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // The match starts at the receiver identifier; if that position was blanked
    // it lived inside a comment or a string, so it is not a registration.
    if (masked[m.index] !== " ") count += 1;
  }
  return count;
}

const routeRoots = [
  path.join(backendRoot, "src", "routes"),
  path.join(backendRoot, "src", "scm", "routes"),
];
const routeModules = routeRoots
  .flatMap((dir) => walk(dir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")))
  .map((filePath) => {
    const text = read(filePath);
    return { file: rel(filePath), endpoints: countEndpoints(text), lines: lineCount(text) };
  })
  .sort((a, b) => byCodePoints(a.file, b.file));

const routeTotals = routeModules.reduce(
  (acc, m) => ({ modules: acc.modules + 1, endpoints: acc.endpoints + m.endpoints }),
  { modules: 0, endpoints: 0 },
);
const nativeRouteCount = routeModules.filter((m) => m.file.startsWith("backend/src/routes/")).length;
const scmRouteCount = routeModules.filter((m) => m.file.startsWith("backend/src/scm/routes/")).length;

// ── Migration trees ────────────────────────────────────────────────────────
// WHICH TREE IS LIVE IS DERIVED, NOT ASSERTED. Each runner script declares its
// own `const DIR`; the deploy workflow names the runner it executes. Getting
// this backwards is worse than saying nothing, so the label below is only ever
// the answer those two files give.
function runnerDir(scriptName) {
  const full = path.join(scriptDir, scriptName);
  if (!fs.existsSync(full)) return null;
  const m = /const\s+DIR\s*=\s*["']([^"']+)["']/.exec(read(full));
  return m ? m[1] : null;
}

const deployYml = read(path.join(repoRoot, ".github", "workflows", "deploy.yml"));

// The vitest config's EXTENSION is not stable: #925 renamed it .ts -> .mts on
// 2026-07-22, eleven hours after this generator was written against the old
// name, and the ENOENT crash that followed froze codebase-map-facts.md for
// three weeks. Resolve it, and say which name is missing rather than dying on
// the first guess.
const VITEST_CONFIG_NAMES = ["vitest.config.mts", "vitest.config.ts", "vitest.config.js"];
const vitestConfigPath = VITEST_CONFIG_NAMES.map((n) => path.join(backendRoot, n)).find((p) =>
  fs.existsSync(p),
);
if (!vitestConfigPath) {
  console.error(
    `Cannot find a vitest config in ${rel(backendRoot)} — looked for ${VITEST_CONFIG_NAMES.join(", ")}.\n` +
      `Table 2's "read by backend vitest" column is derived from it. Add the new name above.`,
  );
  process.exit(1);
}
const vitestConfig = read(vitestConfigPath);

function migrationTree(dirName, runner) {
  const dir = path.join(backendRoot, dirName.replace(/^src\//, "src/"));
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const numbered = entries
    .map((e) => ({ name: e.name, no: /^(\d{3,4})[_-]/.exec(e.name)?.[1] ?? null }))
    .filter((e) => e.no !== null);
  const sql = entries.filter((e) => e.name.endsWith(".sql"));
  const nonSql = numbered.filter((e) => !e.name.endsWith(".sql")).map((e) => e.name).sort(byCodePoints);
  const highest = numbered.slice().sort((a, b) => byCodePoints(a.no, b.no) || byCodePoints(a.name, b.name)).at(-1);
  const appliedByDeploy = new RegExp(`scripts/${runner.replace(".", "\\.")}`).test(deployYml);
  const readByVitest = vitestConfig.includes(dirName);
  return {
    dir: `backend/${dirName}`,
    runner: `backend/scripts/${runner}`,
    sqlFiles: sql.length,
    nonSqlNumbered: nonSql,
    highestNumber: highest?.no ?? "none",
    highestFile: highest?.name ?? "none",
    appliedByDeploy,
    readByVitest,
  };
}

const migrationRunners = [
  { runner: "pg-migrate.mjs", dir: runnerDir("pg-migrate.mjs") },
  { runner: "migrate.mjs", dir: runnerDir("migrate.mjs") },
].filter((r) => r.dir);
const migrationTrees = migrationRunners
  .map((r) => migrationTree(r.dir, r.runner))
  .sort((a, b) => byCodePoints(a.dir, b.dir));

// ── Largest source files ───────────────────────────────────────────────────
const sourceRoots = [path.join(backendRoot, "src"), path.join(repoRoot, "frontend", "src")];
const sourceFiles = sourceRoots
  .flatMap((dir) => walk(dir, (name) => /\.tsx?$/.test(name)))
  .map((filePath) => ({ file: rel(filePath), lines: lineCount(read(filePath)) }));
const largestFiles = sourceFiles
  .slice()
  .sort((a, b) => b.lines - a.lines || byCodePoints(a.file, b.file))
  .slice(0, TOP_FILES);
const totalSourceLines = sourceFiles.reduce((sum, f) => sum + f.lines, 0);

// ── Frontend route inventory ───────────────────────────────────────────────
// App.tsx is a flat list of <Route> elements preceded by a block of
// `const X = lazy(() => import("./pages/…"))` declarations. Split on the route
// tag and, per segment, take the declared path and the first capitalised JSX
// tag that resolves through the lazy map — that is the page the route renders.
const appTsxPath = path.join(repoRoot, "frontend", "src", "App.tsx");
const appTsx = read(appTsxPath);
const lazyModules = new Map();
for (const m of appTsx.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) {
  lazyModules.set(m[1], m[2].replace(/^\.\//, "frontend/src/"));
}

const desktopRoutes = [];
for (const segment of appTsx.split(/<Route\b/).slice(1)) {
  const routePath = /path=["']([^"']+)["']/.exec(segment)?.[1];
  if (!routePath) continue;
  // The PAGE is the self-closing lazy tag. Guards (<ScmGuard>) and provider
  // shells (<Scm2990Shell>) wrap children, so requiring `/>` picks the leaf
  // without the generator having to know any wrapper by name. A route that
  // renders two panes (list + detail) legitimately yields both.
  const pages = [...new Set(
    [...segment.matchAll(/<([A-Z][A-Za-z0-9_]*)[^<>]*\/>/g)]
      .map((tag) => lazyModules.get(tag[1]))
      .filter(Boolean),
  )];
  const isRedirect = /<Navigate\b/.test(segment);
  desktopRoutes.push({
    path: routePath,
    page: pages.length > 0 ? pages.join(" + ") : isRedirect ? "(redirect)" : "(inline)",
  });
}
desktopRoutes.sort((a, b) => byCodePoints(a.path, b.path) || byCodePoints(a.page, b.page));

const pageFiles = walk(path.join(repoRoot, "frontend", "src", "pages"), (name) => name.endsWith(".tsx") && !name.includes(".test."));
const pageDirCounts = new Map();
for (const filePath of pageFiles) {
  const dir = path.dirname(rel(filePath));
  pageDirCounts.set(dir, (pageDirCounts.get(dir) ?? 0) + 1);
}

// ── Mobile inventory ───────────────────────────────────────────────────────
const mobileDir = path.join(repoRoot, "frontend", "src", "mobile");
const mobileScreens = walk(mobileDir, (name) => /^Mobile[A-Za-z0-9]*\.tsx$/.test(name))
  .map((filePath) => ({ file: rel(filePath), lines: lineCount(read(filePath)) }))
  .sort((a, b) => byCodePoints(a.file, b.file));

const mobileAppTsx = read(path.join(mobileDir, "MobileApp.tsx"));
const mobileAppCode = blankNonCode(mobileAppTsx);

// destinationScreen()'s `if (path === "/x") return { t: "screen" }` table — the
// destinations with a PURPOSE-BUILT mobile screen.
const dedicatedScreens = new Map();
for (const m of mobileAppTsx.matchAll(/path === ["']([^"']+)["']\)\s*return\s*\{\s*t:\s*["']([^"']+)["']/g)) {
  dedicatedScreens.set(m[1], m[2]);
}
// ROUTE_TO_CONFIG — destinations rendered by the GENERIC list/detail engine.
const genericModules = new Map();
const routeToConfig = /const ROUTE_TO_CONFIG[^=]*=\s*\{([\s\S]*?)\n\};/.exec(mobileAppTsx);
if (routeToConfig) {
  for (const m of routeToConfig[1].matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)) {
    genericModules.set(m[1], m[2]);
  }
}
// Every menu row, in declaration order, from the (comment-stripped) shell.
const mobileMenu = [];
for (const m of mobileAppCode.matchAll(/\{\s*to:\s*["']([^"']+)["']\s*,\s*label:\s*["']([^"']+)["']/g)) {
  mobileMenu.push({ to: m[1], label: m[2] });
}

const desktopPageByPath = new Map(desktopRoutes.map((r) => [r.path, r.page]));
const surfacePairs = mobileMenu
  .map(({ to, label }) => {
    const cleanPath = to.split("?")[0];
    const screen = dedicatedScreens.has(cleanPath)
      ? `dedicated: ${dedicatedScreens.get(cleanPath)}`
      : genericModules.has(cleanPath)
        ? `generic: MobileModuleList[${genericModules.get(cleanPath)}]`
        : "resolved at runtime by destinationScreen()";
    return { to, label, desktop: desktopPageByPath.get(cleanPath) ?? "(no desktop route)", mobile: screen };
  })
  .filter((row, index, all) => all.findIndex((other) => other.to === row.to) === index)
  .sort((a, b) => byCodePoints(a.to, b.to));

// ── Render ─────────────────────────────────────────────────────────────────
function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
}

const body = [
  "# Generated codebase facts",
  "",
  "> Generated by `backend/scripts/gen-codebase-map.mjs`; do not edit manually.",
  "> Re-run `node backend/scripts/gen-codebase-map.mjs` after adding routes, pages,",
  "> migrations or mobile screens. `--check` reports drift and is NOT wired into CI —",
  "> a stale navigation doc must never block a deploy.",
  "",
  "Everything here is computed from the tree. The judgement layer — what each area is",
  "FOR, which trees are dead, what must be changed in pairs — lives in",
  "[`docs/CODEBASE-MAP.md`](../CODEBASE-MAP.md) and is not repeated here.",
  "",
  "## 1. Backend route inventory",
  "",
  `${routeTotals.modules} route modules (${nativeRouteCount} in \`backend/src/routes\`, ${scmRouteCount} in \`backend/src/scm/routes\`), ${routeTotals.endpoints} endpoint registrations.`,
  "",
  "An endpoint is a `router.<method>(\"/…\")` registration. For the per-route authorization",
  "boundary see the sibling artifact `docs/generated/route-capability-matrix.csv`, which",
  "resolves full mounted paths and their gates.",
  "",
  table(
    ["module", "endpoints", "lines"],
    routeModules.map((m) => [`\`${m.file}\``, String(m.endpoints), String(m.lines)]),
  ),
  "",
  "## 2. Migration trees",
  "",
  "Which tree reaches production is read off the deploy workflow and the runner",
  "scripts, never assumed: each runner declares its own directory, and",
  "`.github/workflows/deploy.yml` names the runner it executes on a push to `main`.",
  "",
  table(
    ["tree", "runner", "*.sql", "highest", "applied to PRODUCTION by deploy.yml", "read by backend vitest"],
    migrationTrees.map((t) => [
      `\`${t.dir}\``,
      `\`${t.runner}\``,
      String(t.sqlFiles),
      `\`${t.highestFile}\` (${t.highestNumber})`,
      t.appliedByDeploy ? "YES" : "no",
      t.readByVitest ? "yes" : "no",
    ]),
  ),
  "",
  ...migrationTrees
    .filter((t) => t.nonSqlNumbered.length > 0)
    .map((t) => `Numbered non-\`.sql\` files in \`${t.dir}\` (each still OWNS its number): ${t.nonSqlNumbered.map((n) => `\`${n}\``).join(", ")}`),
  ...(migrationTrees.some((t) => t.nonSqlNumbered.length > 0) ? [""] : []),
  "## 3. Largest source files",
  "",
  `Top ${TOP_FILES} by line count across \`backend/src\` and \`frontend/src\` (${sourceFiles.length} files, ${totalSourceLines} lines total).`,
  "Read these by line range, never whole — see the CODEBASE-MAP section of the same name.",
  "",
  table(
    ["file", "lines"],
    largestFiles.map((f) => [`\`${f.file}\``, String(f.lines)]),
  ),
  "",
  "## 4. Frontend desktop routes",
  "",
  `${desktopRoutes.length} \`<Route>\` declarations in \`frontend/src/App.tsx\` (aliases from`,
  "`frontend/src/lib/routeAliases.ts` are expanded at runtime and not counted here).",
  "",
  table(
    ["path", "page module"],
    desktopRoutes.map((r) => [`\`${r.path}\``, r.page === "(redirect)" || r.page === "(inline)" ? r.page : `\`${r.page}\``]),
  ),
  "",
  "Page files by directory:",
  "",
  table(
    ["directory", "*.tsx"],
    [...pageDirCounts.entries()].sort((a, b) => byCodePoints(a[0], b[0])).map(([dir, count]) => [`\`${dir}\``, String(count)]),
  ),
  "",
  "## 5. Mobile screen inventory",
  "",
  `${mobileScreens.length} screen/component modules in \`frontend/src/mobile\`.`,
  "",
  table(
    ["file", "lines"],
    mobileScreens.map((f) => [`\`${f.file}\``, String(f.lines)]),
  ),
  "",
  "## 6. Destinations served by both surfaces",
  "",
  "Every mobile menu destination, the desktop page module the same path renders, and",
  "the mobile screen that answers it. `dedicated:` is a purpose-built mobile screen;",
  "`generic:` is the shared list/detail engine driven by a `MODULE_CONFIGS` entry.",
  "Rows are derived from `frontend/src/mobile/MobileApp.tsx` and `frontend/src/App.tsx`.",
  "",
  table(
    ["path", "label", "desktop page", "mobile screen"],
    surfacePairs.map((p) => [
      `\`${p.to}\``,
      p.label,
      p.desktop.startsWith("(") ? p.desktop : `\`${p.desktop}\``,
      p.mobile,
    ]),
  ),
  "",
].join("\n");

// Line-ending agnostic: autocrlf checks this artifact out as CRLF on Windows.
const comparable = (text) => text.split(/\r?\n/).join("\n");

if (checkOnly) {
  if (!fs.existsSync(outputPath) || comparable(read(outputPath)) !== comparable(body)) {
    console.error("Codebase map facts are stale. Run: node backend/scripts/gen-codebase-map.mjs");
    console.error("(PR CI gates this; deploy.yml deliberately does NOT — a stale doc must never block a release.)");
    process.exit(1);
  }
  console.log(`Codebase map facts are current (${routeTotals.modules} route modules, ${desktopRoutes.length} desktop routes).`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, body);
  console.log(`Wrote ${rel(outputPath)} (${routeTotals.modules} route modules, ${routeTotals.endpoints} endpoints, ${desktopRoutes.length} desktop routes).`);
}
