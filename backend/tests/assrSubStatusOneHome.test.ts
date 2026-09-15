import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sub-status list has one home — docs/bugs/0890.
 *
 * The service-case sub-statuses were typed by hand in the screens' list, the
 * save allowlist, the stage-entry seed, the printed report and the activity
 * log. When the Pickup / Return stage gained Pending Customer Pickup, the save
 * allowlist was the copy that did not hear about it, so the server refused the
 * very value its own stage entry had written. The way this comes back is one of
 * these files growing a local list again, which renders fine and errors nowhere
 * until someone picks the new value, so the check reads the source.
 *
 * Lives in tests/ because backend/tsconfig.json gives src/ no node:fs.
 */
const REPO_BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** [ what it is, path, the shared export it must reach ] */
const READS_THE_LIST: Array<[string, string, string]> = [
  ["the save allowlist", "src/routes/assr.ts", "ASSR_SUB_STATUS_KEYS"],
  ["the stage-entry seed", "src/services/assr.ts", "assrSubStatusSeed"],
  ["the activity log", "src/services/assr.ts", "assrSubStatusLabelOf"],
  ["the printed service report", "src/routes/assr_print.ts", "assrSubStatusLabelOf"],
];

/** A quoted sub-status LABEL is how every copy began. The keys stay legal: the
 *  dashboard counts and the sheet export legitimately name them. */
const BANNED_LABELS = [
  "Pending Customer Pickup",
  "Pending Supplier Pickup",
  "Pending Supplier Return",
  "QC Issue Result",
];

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const read = (rel: string): string => fs.readFileSync(path.join(REPO_BACKEND, rel), "utf8");

describe("the service-case sub-status list has exactly one home", () => {
  test("the scan can see the shape it bans", () => {
    const sample = stripComments('const L = {\n  pending_supplier_return: "Pending Supplier Return",\n};\n');
    expect(sample.includes('"Pending Supplier Return"')).toBe(true);
    expect(stripComments('// it used to say "Pending Supplier Return"').includes('"Pending Supplier Return"')).toBe(false);
  });

  test("the files it scans exist — a moved path must not pass in silence", () => {
    for (const [, rel] of READS_THE_LIST) {
      expect(fs.existsSync(path.join(REPO_BACKEND, rel)), `${rel} is missing`).toBe(true);
    }
  });

  test("each of them reads the shared list", () => {
    for (const [what, rel, symbol] of READS_THE_LIST) {
      const text = stripComments(read(rel));
      expect(text.includes("scm/shared/assr-sub-statuses"), `${rel} (${what}) does not import the shared list`).toBe(true);
      expect(text.includes(`${symbol}(`) || text.includes(`${symbol}.`), `${rel} (${what}) does not use ${symbol}`).toBe(true);
    }
  });

  test("the save keeps no list of its own", () => {
    const text = stripComments(read("src/routes/assr.ts"));
    expect(/new Set\(\[[^\]]*"pending_inspection"/.test(text)).toBe(false);
    expect(text.includes("SUB_STATUS_VALUES")).toBe(false);
  });

  test("no scanned file re-types a sub-status label", () => {
    const offenders: string[] = [];
    for (const rel of new Set(READS_THE_LIST.map(([, r]) => r))) {
      stripComments(read(rel)).split("\n").forEach((line, i) => {
        for (const label of BANNED_LABELS) {
          if (line.includes(`"${label}"`)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
