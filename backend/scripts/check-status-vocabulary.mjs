#!/usr/bin/env node
// check-status-vocabulary — how big is "rename the effective status to SUBMITTED"?
//
// THE DECISION THIS SERVES. Owner 2026-09-12: 「你的 PI、SI、GR、PO、SO 都要改成
// submitted，然后跟 draft 基本上这几个全部都是一样」 and, before any of it moves,
// 「你改的东西前因后果，所有连接、API 等等都要查看」.
//
// Today "this document is live" is spelled FOUR different ways — CONFIRMED on a
// sales order, SUBMITTED on a purchase order, POSTED on a goods receipt and a
// purchase invoice, SENT on a sales invoice — and the delivery order keeps its
// own vocabulary (DRAFT / LOADED / DISPATCHED ...), which the owner explicitly
// left alone.
//
// A rename touches three ESTATES and each fails differently:
//
//   CODE   — a literal in a route, a client, a test. Fails loudly at build or
//            in CI, and is the cheap half.
//   DATA   — rows already carrying the old word. Nothing fails; a list silently
//            stops showing documents, which is the expensive half.
//   RULES  — a database CHECK constraint or an enum type. The WRITE is refused
//            at the moment of the rename, so this half decides the ORDER of
//            operations, not just the size of the job.
//
// This prints all three, so the plan is made against measurements instead of an
// impression. READ-ONLY: greps this checkout and runs SELECTs. It exits 0 for
// every legitimate answer — the answer IS the output, so a non-zero exit would
// read as "the check broke" (CLAUDE.md).
//
//   node backend/scripts/check-status-vocabulary.mjs            # code only
//   DATABASE_URL=... node backend/scripts/check-status-vocabulary.mjs  # + data
//
// NO DEPENDENCIES beyond `postgres`, and that one is only imported when a
// DATABASE_URL is present, so the code census runs in a fresh worktree.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GH = !!process.env.GITHUB_ACTIONS;
const say = (m) => console.log(GH ? `::notice::${m}` : m);
const head = (m) => console.log(GH ? `::group::${m}` : `\n${m}`);
const endGroup = () => { if (GH) console.log("::endgroup::"); };

/** The four spellings of "live", and the document each belongs to. DO is absent
 *  on purpose: the owner keeps its vocabulary. */
const WORDS = [
  { word: "CONFIRMED", document: "Sales Order" },
  { word: "SUBMITTED", document: "Purchase Order (the target spelling)" },
  { word: "POSTED", document: "Goods Receipt / Purchase Invoice" },
  { word: "SENT", document: "Sales Invoice" },
];

/** Where a hit lives decides what it costs to change. */
const ESTATES = [
  { key: "backend route / lib", dir: "backend/src", exts: [".ts"], skip: /\.test\.ts$/ },
  { key: "frontend", dir: "frontend/src", exts: [".ts", ".tsx"], skip: /\.test\.tsx?$/ },
  { key: "tests", dir: "backend/tests", exts: [".ts", ".mts", ".mjs"], skip: null },
  { key: "frontend tests", dir: "frontend/src", exts: [".test.ts", ".test.tsx"], skip: null },
  { key: "e2e", dir: "frontend/e2e", exts: [".ts"], skip: null },
  { key: "migrations (live tree)", dir: "backend/src/db/migrations-pg", exts: [".sql"], skip: null },
  { key: "ops scripts", dir: "backend/scripts", exts: [".mjs", ".ts"], skip: null },
  { key: "workflows", dir: ".github/workflows", exts: [".yml"], skip: null },
];

const walk = (dir, exts, skip, out = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, exts, skip, out); continue; }
    if (!exts.some((x) => e.name.endsWith(x))) continue;
    if (skip && skip.test(e.name)) continue;
    out.push(p);
  }
  return out;
};

/** A WORD hit only counts when it is the status VALUE — quoted, or inside a SQL
 *  string. `SUBMITTED_AT`, a comment sentence and an unrelated English use of
 *  "sent" would otherwise inflate every number here. */
const hitRe = (word) => new RegExp(`(['"\`])${word}\\1`, "g");

function codeCensus() {
  const rows = [];
  for (const estate of ESTATES) {
    const files = walk(path.join(REPO, estate.dir), estate.exts, estate.skip);
    for (const w of WORDS) {
      let fileCount = 0; let hitCount = 0;
      for (const f of files) {
        let text;
        try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
        const m = text.match(hitRe(w.word));
        if (m && m.length) { fileCount += 1; hitCount += m.length; }
      }
      if (fileCount) rows.push({ estate: estate.key, word: w.word, files: fileCount, hits: hitCount });
    }
  }
  return rows;
}

/** A CHECK constraint or an enum naming one of the words is the half that
 *  REFUSES THE WRITE, so it is listed separately and by file. */
function ruleCensus() {
  const files = walk(path.join(REPO, "backend/src/db/migrations-pg"), [".sql"], null);
  const found = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const isRule = /CHECK\s*\(|CREATE\s+TYPE|ADD\s+CONSTRAINT|ENUM/i.test(line);
      if (!isRule) return;
      const words = WORDS.filter((w) => hitRe(w.word).test(line)).map((w) => w.word);
      if (words.length) {
        found.push({ file: path.relative(REPO, f).replace(/\\/g, "/"), line: i + 1, words, text: line.trim().slice(0, 120) });
      }
    });
  }
  return found;
}

async function dataCensus(dsn) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(dsn, { ssl: "require", prepare: false, max: 1 });
  const TABLES = [
    ["scm.mfg_sales_orders", "Sales Order"],
    ["scm.purchase_orders", "Purchase Order"],
    ["scm.grns", "Goods Receipt"],
    ["scm.delivery_orders", "Delivery Order (keeps its own words)"],
    ["scm.purchase_invoices", "Purchase Invoice"],
    ["scm.sales_invoices", "Sales Invoice"],
  ];
  const out = [];
  for (const [table, label] of TABLES) {
    try {
      const rows = await sql.unsafe(
        `select status::text as status, count(*)::int as n from ${table} group by 1 order by 2 desc`,
      );
      out.push({ table, label, rows });
    } catch (e) {
      out.push({ table, label, error: e?.message ?? String(e) });
    }
  }
  /* Is the column an ENUM? That decides whether the rename needs an ALTER TYPE
     before any row can move. */
  const types = await sql`
    select c.table_schema || '.' || c.table_name as tbl, c.udt_name, c.data_type
      from information_schema.columns c
     where c.column_name = 'status'
       and c.table_schema = 'scm'
       and c.table_name in ('mfg_sales_orders','purchase_orders','grns','delivery_orders','purchase_invoices','sales_invoices')
     order by 1`;
  await sql.end();
  return { out, types };
}

async function main() {
  say("STATUS VOCABULARY CENSUS — what a rename to SUBMITTED would touch");
  say('Owner 2026-09-12: SO / PO / GR / PI / SI all spell "live" as SUBMITTED; the Delivery Order keeps its own.');

  head("1. CODE — files carrying each spelling as a quoted value");
  const code = codeCensus();
  const byWord = new Map();
  for (const r of code) {
    if (!byWord.has(r.word)) byWord.set(r.word, { files: 0, hits: 0 });
    byWord.get(r.word).files += r.files; byWord.get(r.word).hits += r.hits;
  }
  for (const r of code) console.log(`  ${r.estate.padEnd(24)} ${r.word.padEnd(10)} files=${String(r.files).padStart(4)}  hits=${r.hits}`);
  endGroup();
  for (const w of WORDS) {
    const t = byWord.get(w.word) ?? { files: 0, hits: 0 };
    say(`CODE  ${w.word.padEnd(10)} ${String(t.files).padStart(4)} file(s), ${t.hits} value(s)   [${w.document}]`);
  }

  head("2. RULES — a CHECK / enum that would REFUSE the write");
  const rules = ruleCensus();
  if (!rules.length) console.log("  none found in backend/src/db/migrations-pg");
  for (const r of rules) console.log(`  ${r.file}:${r.line}  ${r.words.join(",")}\n      ${r.text}`);
  endGroup();
  say(rules.length
    ? `RULES ${rules.length} migration line(s) name one of the words inside a CHECK / enum — these decide the ORDER of the rename, not just its size.`
    : "RULES no CHECK / enum in the live migration tree names one of the words.");

  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    say("DATA  skipped — no DATABASE_URL. Re-run with one to count the rows already carrying each word.");
    return;
  }
  head("3. DATA — rows already carrying each status");
  const { out, types } = await dataCensus(dsn);
  for (const t of out) {
    if (t.error) { console.log(`  ${t.table}: READ FAILED — ${t.error}`); continue; }
    const total = t.rows.reduce((s, r) => s + r.n, 0);
    console.log(`  ${t.table} (${t.label}) — ${total} row(s)`);
    for (const r of t.rows) console.log(`      ${String(r.status ?? "(null)").padEnd(22)} ${r.n}`);
  }
  console.log("  status column types:");
  for (const r of types) console.log(`      ${String(r.tbl).padEnd(32)} ${r.data_type} (${r.udt_name})`);
  endGroup();
  const affected = out
    .filter((t) => !t.error && !/Delivery Order/.test(t.label))
    .flatMap((t) => t.rows.filter((r) => WORDS.some((w) => w.word === r.status)).map((r) => r.n));
  say(`DATA  ${affected.reduce((s, n) => s + n, 0)} row(s) across SO / PO / GR / PI / SI carry one of the four words today.`);
  const enums = types.filter((r) => r.data_type === "USER-DEFINED");
  say(enums.length
    ? `DATA  ${enums.length} of those status columns are an ENUM (${enums.map((r) => r.udt_name).join(", ")}) — a new value must be added to the TYPE before any row can move.`
    : "DATA  no status column is an enum; every one is free text under a CHECK, if anything.");
}

main().catch((e) => { console.error(GH ? `::error::${e?.message ?? e}` : e); process.exit(1); });
