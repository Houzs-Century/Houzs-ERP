#!/usr/bin/env node
// Generate src/services/autocount-master-maps.ts from the master-data JSON.
//
// WHY. Confirming a binding used to mean hand-editing a TypeScript object
// literal, and the reviewable record of WHY that binding is right lived in
// data/autocount-so-writeback-mappings.json — a different file, which nobody
// was forced to update. They drifted apart in all four dimensions: the TS
// carried `ETHAN` and `WEI PIN` (confirmed out of the JSON's own
// `agent_map_fuzzy_to_confirm` and never written back), five identity location
// entries and four brands the JSON had never heard of. One source, generated
// into the other, is the repo's existing answer to that (gen:ac-item-map).
//
// So the loop is: check-autocount-master-bindings.mjs PROPOSES a pair, a human
// moves it into the JSON, this writes the map the composer compiles.
//
//   node scripts/gen-autocount-master-maps.mjs           # write
//   node scripts/gen-autocount-master-maps.mjs --check   # fail if stale (CI)
//
// RE-RUN: idempotent. A second run rewrites byte-identical output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sameIgnoringEol } from "./lib/eol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "data", "autocount-so-writeback-mappings.json");
const OUT = path.join(here, "..", "src", "services", "autocount-master-maps.ts");

const DIMENSIONS = [
  ["agent_map", "AGENT_MAP", "ERP salesperson label -> AutoCount Sales Agent (the agent name IS the code)."],
  ["location_map", "LOCATION_MAP", "ERP sales_location / warehouse code -> AutoCount location code."],
  ["venue_map", "VENUE_MAP", "ERP venue -> AutoCount VENUE UDF option (the book appends SOLO, JOHOR, ...)."],
  ["branding_map", "BRANDING_MAP", "ERP branding -> AutoCount BRANDING UDF option. ALLOW-LIST — see branding_note."],
];

const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));

/* `bookSpelling` looks a value up by norm() — uppercased, whitespace-collapsed
   — so a key in any other shape is unreachable by key and can only ever match
   through the value loop. Normalising here rather than trusting the hand-typed
   file is what makes "Shi Ting" work; refusing a collision is what stops two
   keys that differ only in case silently overwriting one another. */
const normKey = (s) => String(s).toUpperCase().replace(/\s+/g, " ").trim();

function compile(field) {
  const src = raw[field];
  if (!src || typeof src !== "object") throw new Error(`${SRC}: "${field}" is missing or not an object`);
  const out = {};
  const seen = new Map();
  for (const [k, v] of Object.entries(src)) {
    const key = normKey(k);
    if (!key) throw new Error(`${field}: a blank key, refusing to emit`);
    const value = String(v).replace(/\s+/g, " ").trim();
    if (!value) throw new Error(`${field}: "${k}" maps to nothing, refusing to emit`);
    if (seen.has(key) && seen.get(key) !== value) {
      throw new Error(`${field}: "${k}" and "${seen.get(key)}" both normalise to "${key}" with different targets`);
    }
    seen.set(key, value);
    out[key] = value;
  }
  return out;
}

const compiled = DIMENSIONS.map(([field, name, doc]) => [name, compile(field), doc]);

const body = compiled
  .map(([name, map, doc]) => {
    const entries = Object.entries(map)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join("\n");
    return `/** ${doc} */\nexport const ${name}: Record<string, string> = {\n${entries}\n};`;
  })
  .join("\n\n");

const text = `// GENERATED FILE — do not edit by hand.
// Source: backend/scripts/data/autocount-so-writeback-mappings.json
// Regenerate: node scripts/gen-autocount-master-maps.mjs
// CI guard:   npm run audit:ac-master-maps
//
// The four master-data spelling maps the write-back composes with. They are
// generated so that CONFIRMING A BINDING is an edit to the JSON — the file that
// also carries the reason, the harvest date and the book's own vocabularies —
// and never an edit to TypeScript. What each map means, and why BRANDING_MAP is
// an allow-list while the other three are not, is documented at the point of
// USE in autocount-writeback.ts, which re-exports all four.
//
// Keys are normalised to what \`bookSpelling\` looks up: uppercase, single-spaced.
${body}
`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  // Content, not line endings — see scripts/lib/eol.mjs.
  if (!sameIgnoringEol(current, text)) {
    console.error(
      `${path.relative(process.cwd(), OUT)} is STALE.\n` +
        "Run: node scripts/gen-autocount-master-maps.mjs",
    );
    process.exit(1);
  }
  console.log(
    `autocount master maps up to date: ${compiled.map(([n, m]) => `${n} ${Object.keys(m).length}`).join(", ")}`,
  );
} else {
  fs.writeFileSync(OUT, text);
  console.log(
    `wrote ${path.relative(process.cwd(), OUT)}: ${compiled.map(([n, m]) => `${n} ${Object.keys(m).length}`).join(", ")}`,
  );
}
