// Generate src/services/autocount-item-master.ts from the live-book snapshot
// backend/scripts/data/ac-item-master.tsv (written by export-ac-item-master.py).
//
// The snapshot is AutoCount's own Description, Item Group and UOM per AutoCount ItemCode —
// what the account book's listings print for a line of that item. The Worker
// cannot read a file off disk, so it is emitted as one TAB-separated string
// constant and indexed at first use (the autocount-item-map.ts pattern).
//
//   node scripts/gen-autocount-item-master.mjs           # write
//   node scripts/gen-autocount-item-master.mjs --check   # fail if stale (CI)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sameIgnoringEol } from "./lib/eol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TSV = path.join(here, "data", "ac-item-master.tsv");
const OUT = path.join(here, "..", "src", "services", "autocount-item-master.ts");

const raw = fs.readFileSync(TSV, "utf8").trim().split(/\r?\n/);
const want = ["ac_code", "description", "item_group", "base_uom"];
if (raw[0].split("\t").join("|") !== want.join("|")) throw new Error(`unexpected TSV header: ${raw[0]}`);

const rows = [];
const seen = new Set();
for (const line of raw.slice(1)) {
  if (!line.trim()) continue;
  const p = line.split("\t");
  if (p.length !== 4) throw new Error(`row is not 4 fields, refusing to guess: ${line}`);
  const [ac, description, group, baseUom] = p.map((s) => s.trim());
  if (!ac) throw new Error(`row has a blank item code: ${line}`);
  const key = ac.toUpperCase();
  if (seen.has(key)) throw new Error(`duplicate ac_code ${ac}`);
  seen.add(key);
  if ([ac, description, group, baseUom].some((v) => v.includes("`") || v.includes("\\") || v.includes("${"))) {
    throw new Error(`a field carries a template-literal character, refusing to emit: ${line}`);
  }
  rows.push([ac, description, group, baseUom]);
}

const text = `// GENERATED FILE — do not edit by hand.
// Source: backend/scripts/data/ac-item-master.tsv (export-ac-item-master.py, live AED_HOUZS)
// Regenerate: node scripts/gen-autocount-item-master.mjs
// CI guard:   node scripts/gen-autocount-item-master.mjs --check
//
// One record per line: ac_code <TAB> description <TAB> item_group <TAB> base_uom.
export const AC_ITEM_MASTER_ROWS = ${rows.length};
export const AC_ITEM_MASTER_TSV = \`${rows.map((r) => r.join("\t")).join("\n")}\`;
`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (!sameIgnoringEol(current, text)) {
    console.error("autocount-item-master.ts is STALE. Run: node scripts/gen-autocount-item-master.mjs");
    process.exit(1);
  }
  console.log(`autocount-item-master.ts is current (${rows.length} rows)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${rows.length} rows)`);
}
