// Generate src/services/autocount-item-map.ts from the cutover mapping CSV.
//
// The CSV (backend/scripts/data/autocount-erp-mapping-1561.csv) is the record of
// how every AutoCount ItemCode was opened into the ERP at the cutover. It is the
// ONLY total ERP -> AutoCount item map that exists, and it was verified against
// the live AED_HOUZS Item table on 2026-08-11: 1561 rows both sides, zero codes
// missing in either direction.
//
// The Worker cannot read a CSV off disk, so the map is emitted as a TAB-separated
// string constant and indexed at first use. Emitting 1561 object literals instead
// would quadruple the bundle for no gain.
//
//   node scripts/gen-autocount-item-map.mjs           # write
//   node scripts/gen-autocount-item-map.mjs --check   # fail if stale (CI)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(here, "data", "autocount-erp-mapping-1561.csv");
const OUT = path.join(here, "..", "src", "services", "autocount-item-map.ts");

const raw = fs.readFileSync(CSV, "utf8").trim().split(/\r?\n/);
const head = raw[0].split(",").map((s) => s.trim());
const want = ["ac_code", "erp_code", "status", "category", "supplier"];
if (want.some((c, i) => head[i] !== c)) {
  throw new Error(`unexpected CSV header: ${raw[0]}`);
}

const rows = [];
for (const line of raw.slice(1)) {
  if (!line.trim()) continue;
  const p = line.split(",");
  if (p.length !== 5) throw new Error(`row is not 5 fields, refusing to guess: ${line}`);
  const [ac, erp, , category, supplier] = p.map((s) => s.trim());
  if (!ac || !erp) throw new Error(`row has a blank code, refusing to emit: ${line}`);
  if ([ac, erp, category, supplier].some((v) => v.includes("\t"))) {
    throw new Error(`a field contains a TAB, which is the record separator: ${line}`);
  }
  rows.push([ac, erp, category, supplier]);
}

const acSeen = new Set();
for (const [ac] of rows) {
  if (acSeen.has(ac.toUpperCase())) throw new Error(`duplicate ac_code ${ac}`);
  acSeen.add(ac.toUpperCase());
}

const body = rows.map((r) => r.join("\t")).join("\n");
const text = `// GENERATED FILE — do not edit by hand.
// Source: backend/scripts/data/autocount-erp-mapping-1561.csv
// Regenerate: node scripts/gen-autocount-item-map.mjs
// CI guard:   node scripts/gen-autocount-item-map.mjs --check
//
// One record per line: ac_code <TAB> erp_code <TAB> category <TAB> supplier.
// The supplier column is the AutoCount CREDITOR code (400-A004 and friends),
// which is also scm.suppliers.code — that is what makes it usable as the
// disambiguator when one ERP code was opened from several AutoCount items.
export const AC_ITEM_MAP_ROWS = ${rows.length};
export const AC_ITEM_MAP_TSV = \`${body.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;
`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  /* Compare CONTENT, not line endings. This repo is developed on Windows with
     core.autocrlf=true, so the checkout carries CRLF while the generator writes
     LF — an exact compare fails on every developer machine and passes on the
     Linux runner. A gate that cries wolf locally is a gate somebody deletes. */
  const lf = (s) => s.replace(/\r\n/g, "\n");
  if (lf(current) !== lf(text)) {
    console.error(
      "autocount-item-map.ts is STALE. Run: node scripts/gen-autocount-item-map.mjs",
    );
    process.exit(1);
  }
  console.log(`autocount-item-map.ts is current (${rows.length} rows)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${rows.length} rows)`);
}
