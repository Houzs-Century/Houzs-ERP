// THIS FILE MUST STAY IN THE `light` PROJECT. It reads the tree with node:fs,
// which does not exist in workerd — sent to the workers pool it would not fail,
// it would DIE, and its assertions would be reported as neither passed nor
// failed (the shape measured 2026-08-14, written up in classifyTests.test.mjs).
// It also has to gate a MERGE, and only the light project runs inside a required
// context. Both are pinned: it is listed in that file's MUST_GATE_MERGE. There
// is deliberately NO `@vitest-project` override here — that escape hatch is
// pinned to the classifier's own test — so keep `cloudflare:test` and `env.DB`
// out of this file's CODE (a comment is stripped before the scan; a string
// literal is not).
//
// EVERY VALUE IN EVERY *_STATUS_BUCKETS MAP IS A MEMBER OF ITS TABLE'S ENUM —
// AND EVERY MEMBER IS IN SOME BUCKET.
//
// WHY THIS EXISTS. The five SCM list endpoints (PO, PI, SI, GRN, DO) each hold a
// filter-pill map, bucket name -> the raw `status` values it covers, used for
// BOTH the list filter and the tab counts. `status` is a Postgres ENUM column,
// so those literals are not free text: PostgREST hands an unknown label to
// Postgres, which refuses to parse it — `22P02 invalid input value for enum
// <type>: "<label>"` — and the whole query 500s.
//
// Measured against production on 2026-08-17, both companies:
//   GET /api/scm/sales-invoices?status=sent       -> 500 ... sales_invoice_status: "ISSUED"
//   GET /api/scm/sales-invoices?status=partial    -> 500 ... sales_invoice_status: "PARTIAL"
//   GET /api/scm/sales-invoices?status=paid       -> 500 ... sales_invoice_status: "COMPLETED"
//   GET /api/scm/delivery-orders-mfg?status=delivered -> 500 ... do_status: "COMPLETED"
// and the same labels made the COUNT queries fail, which the handlers were
// degrading to 0: the DO list read `all:27 delivered:0` for one company and
// `all:36 delivered:0` for the other, with 37 delivery orders reachable from no
// tab and nothing anywhere saying so.
//
// The three SI labels had sat there for months under a comment calling them a
// "backward-compatible fallback". They never were — an enum column cannot have
// held a label that is not in the type — which is exactly why prose was not
// enough and this is a test.
//
// The SECOND assertion below is the other half of the same fault, and it is the
// quiet one: OVERDUE is a real member of sales_invoice_status that was in NO
// bucket, so an overdue invoice counted in `all` and appeared in no tab. A
// missing member is invisible; a wrong member at least 500s.
//
// THE ENUM IS READ FROM SQL, NEVER HAND-COPIED. A hand-typed member list in this
// file would be one more copy to drift — the same failure it is testing. The
// vocabulary is assembled from the baseline DDL plus every
// `ALTER TYPE ... ADD VALUE` in the LIVE migration tree, which is where DRAFT
// came from for all five of these types (migrations 0040-0044).
//
// WHAT THIS CANNOT SEE: a value that is real in production but recorded in no
// file here. One is visible in the tree — migration 0106 casts 'VOID' to both
// scm.sales_invoice_status and scm.purchase_invoice_status inside a view, while
// no CREATE/ALTER in this repo declares it. So the assertion direction is
// deliberate: buckets must be a SUBSET of what the SQL records. If a value is
// genuinely a member and this test says it is not, the repair is to record it in
// the SQL — not to exempt it here, which would put the vocabulary back in a
// hand-copied list.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = path.join(backendRoot, "scripts/scm-schema/2990s-full-schema.sql");
const MIGRATIONS_PG = path.join(backendRoot, "src/db/migrations-pg");
const SRC_ROOT = path.join(backendRoot, "src");

/* The map's file -> the enum type its values are filtered against. The ONE
   hand-written pairing in this test. The "no stray map" check below is what
   stops a new endpoint quietly opting out: a *_STATUS_BUCKETS declaration
   anywhere under src/ that is not listed here FAILS.

   WHAT THAT CLAIM IS WORTH, stated exactly, because the sentence it replaces
   ("self-completing ... the next list endpoint cannot quietly opt out") was
   false twice and both holes were found by someone else planting the case:

   1. CORRECTED 2026-08-18 — the same-FILE case. The scan keyed its results by
      FILE PATH, so a SECOND *_STATUS_BUCKETS declaration in an already-registered
      file overwrote the real map and the real map stopped being checked. Planting
      'COMPLETED' back in GRN_STATUS_BUCKETS.posted AND appending a second, valid
      GRN2_STATUS_BUCKETS to grns.ts made this suite report 12 passed; `maps.size
      === 5` could not see it because it was counting FILES. Results are now keyed
      by `<file>::<MAP_NAME>` and parseBucketMaps() has a two-map self-test below.

   2. CORRECTED 2026-08-18 (second round) — the UNANNOTATED case. BUCKET_DECL
      required an explicit type annotation, so `export const XX_STATUS_BUCKETS =
      { ... }` was invisible to the whole suite (13 passed with a bogus member in
      it), and so was an `as const` variant. The annotation is now optional and
      both shapes have a self-test below.

   WHAT IT STILL CANNOT SEE, so nobody re-derives it by planting a third case: a
   map assembled at RUNTIME (spread, Object.fromEntries, a function return), a map
   whose closing brace is not at column 0, and a bucket list that is not a literal
   array on one line. Those are not opt-outs anyone reaches for by accident, but
   they are holes, and the honest statement is "every LITERAL declaration", not
   "every map". */
const BUCKET_OWNERS = {
  "src/scm/routes/mfg-purchase-orders.ts": "po_status",
  "src/scm/routes/purchase-invoices.ts": "purchase_invoice_status",
  "src/scm/routes/sales-invoices.ts": "sales_invoice_status",
  "src/scm/routes/grns.ts": "grn_status",
  /* MOVED 2026-08-21 out of routes/delivery-orders-mfg.ts, which is 225 lines
     over its size ceiling, when the four buckets became one-per-status. The map
     is registered at its new address; the route imports it. */
  "src/scm/lib/do-status-buckets.ts": "do_status",
};

/* ── The enum vocabulary, out of the SQL ─────────────────────────────────── */

const CREATE_TYPE =
  /CREATE\s+TYPE\s+(?:"?(?:public|scm)"?\s*\.\s*)?"?(\w+)"?\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
const ADD_VALUE =
  /ALTER\s+TYPE\s+(?:"?(?:public|scm)"?\s*\.\s*)?"?(\w+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;

/** Every single-quoted literal inside a CREATE TYPE's parenthesised body. */
function quotedValues(body) {
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function readEnumVocabulary() {
  /** enum name -> Set of members */
  const enums = new Map();
  const add = (name, value) => {
    if (!enums.has(name)) enums.set(name, new Set());
    enums.get(name).add(value);
  };

  const sqlFiles = [SCHEMA_SQL];
  for (const name of fs.readdirSync(MIGRATIONS_PG).sort()) {
    if (name.endsWith(".sql")) sqlFiles.push(path.join(MIGRATIONS_PG, name));
  }

  let creates = 0;
  let addValues = 0;
  for (const file of sqlFiles) {
    const sql = fs.readFileSync(file, "utf8");
    for (const m of sql.matchAll(CREATE_TYPE)) {
      creates += 1;
      for (const v of quotedValues(m[2])) add(m[1], v);
    }
    for (const m of sql.matchAll(ADD_VALUE)) {
      addValues += 1;
      add(m[1], m[2]);
    }
  }
  return { enums, creates, addValues };
}

/* ── The bucket maps, out of the route sources ───────────────────────────── */

/* The TYPE ANNOTATION IS OPTIONAL, and it was not until 2026-08-18. The pattern
   used to be `const (\w*_STATUS_BUCKETS)\s*:[^=]*=` — the `:` mandatory — so a map
   written the ordinary TS way, letting the type be inferred, was invisible to
   this entire suite: `maps.size` stayed at 5, both the registration guard and the
   one-map-per-file guard saw nothing, and a bucket full of non-members passed.
   Demonstrated with `export const XX_STATUS_BUCKETS = { ... 'COMPLETELY_BOGUS' }`
   dropped in src/scm/lib/ (13 passed), and again with an `as const` variant
   (13 passed) — which is why the terminator accepts `} as const;` too. */
const BUCKET_DECL =
  /const\s+(\w*_STATUS_BUCKETS)\s*(?::[^=]*)?=\s*\{([\s\S]*?)\n\}(?:\s+as\s+const)?\s*;/g;

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** EVERY *_STATUS_BUCKETS map in one source text, in declaration order.
 *  Pure, so the two-map case has a self-test rather than a manual demo. */
function parseBucketMaps(src) {
  const out = [];
  for (const m of src.matchAll(BUCKET_DECL)) {
    const buckets = {};
    /* One entry per LINE: `key: ['A', 'B'],`. Line-anchored so a comment
       mentioning a status inside the literal cannot contribute a value —
       these maps are commented heavily and a value harvested out of prose
       would be a value nobody wrote. */
    for (const line of m[2].split("\n")) {
      const entry = /^\s*(\w+)\s*:\s*\[([^\]]*)\]/.exec(line);
      if (entry) buckets[entry[1]] = quotedValues(entry[2]);
    }
    out.push({ name: m[1], buckets });
  }
  return out;
}

/** "<repo-relative file>::<MAP_NAME>" -> { file, name, buckets }. Keyed by the
 *  PAIR, never by the file alone: two maps in one file must be two entries, or
 *  the second silently replaces the first and the first stops being checked. */
function readBucketMaps() {
  const found = new Map();
  for (const file of listSourceFiles(SRC_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("_STATUS_BUCKETS")) continue;
    const rel = path.relative(backendRoot, file).split(path.sep).join("/");
    for (const { name, buckets } of parseBucketMaps(src)) {
      found.set(`${rel}::${name}`, { file: rel, name, buckets });
    }
  }
  return found;
}

/* ── The patterns must be alive before any verdict is computed ───────────── */

const { enums, creates, addValues } = readEnumVocabulary();
const maps = readBucketMaps();

describe("the checker itself", () => {
  test("the SQL scan reads real enums out of the schema and the migrations", () => {
    assert.ok(fs.existsSync(SCHEMA_SQL), `baseline DDL not found at ${SCHEMA_SQL}`);
    assert.ok(creates >= 20, `CREATE TYPE scan matched ${creates} enums — the pattern is dead, not the schema`);
    assert.ok(addValues >= 5, `ALTER TYPE ... ADD VALUE scan matched ${addValues} — the pattern is dead`);
    for (const enumName of new Set(Object.values(BUCKET_OWNERS))) {
      const members = enums.get(enumName);
      assert.ok(members, `no CREATE TYPE found for ${enumName}`);
      assert.ok(members.size >= 3, `${enumName} parsed as ${members.size} members — the value split is broken`);
      /* DRAFT reaches all five of these types ONLY through migrations
         0040-0044, so its presence proves the ADD VALUE half of the scan ran
         over the migration tree and not just the baseline DDL. */
      assert.ok(members.has("DRAFT"), `${enumName} has no DRAFT — the migration ALTER TYPE scan is not reaching migrations-pg`);
    }
  });

  /* THE HOLE THAT WAS WALKED PAST, pinned. The old scan kept one result per
     FILE, so the second map in a file replaced the first and the first stopped
     being checked while the suite stayed green. */
  test("the map scan returns EVERY map in a file, not only the last one", () => {
    const twoInOneFile = [
      "const A_STATUS_BUCKETS: Record<string, string[]> = {",
      "  draft: ['DRAFT'],",
      "  posted: ['POSTED', 'CLOSED'],",
      "  cancelled: ['CANCELLED'],",
      "};",
      "const B_STATUS_BUCKETS: Record<string, string[]> = {",
      "  draft: ['DRAFT'],",
      "  posted: ['POSTED'],",
      "  cancelled: ['CANCELLED'],",
      "};",
    ].join("\n");
    const parsed = parseBucketMaps(twoInOneFile);
    assert.deepEqual(parsed.map((p) => p.name), ["A_STATUS_BUCKETS", "B_STATUS_BUCKETS"]);
    assert.deepEqual(parsed[0].buckets.posted, ["POSTED", "CLOSED"]);
    assert.deepEqual(parsed[1].buckets.posted, ["POSTED"]);
  });

  /* THE SECOND WALK-PAST, pinned the same way. All five real maps carry a type
     annotation, so nothing in the tree would notice this pattern demanding one. */
  test("a map with no type annotation is still seen", () => {
    const shapes = [
      "export const C_STATUS_BUCKETS = {\n  draft: ['DRAFT'],\n  posted: ['POSTED'],\n};",
      "export const D_STATUS_BUCKETS = {\n  draft: ['DRAFT'],\n  posted: ['POSTED'],\n} as const;",
      "const E_STATUS_BUCKETS: Record<string, string[]> = {\n  draft: ['DRAFT'],\n  posted: ['POSTED'],\n};",
    ];
    for (const src of shapes) {
      const parsed = parseBucketMaps(src);
      assert.equal(parsed.length, 1, `this declaration shape is invisible to the scan:\n${src}`);
      assert.deepEqual(parsed[0].buckets.posted, ["POSTED"]);
    }
  });

  test("every *_STATUS_BUCKETS map under src/ is registered here", () => {
    assert.equal(
      maps.size,
      Object.keys(BUCKET_OWNERS).length,
      `found ${maps.size} bucket maps, expected ${Object.keys(BUCKET_OWNERS).length}: ${[...maps.keys()].join(", ")}`,
    );
    for (const [key, map] of maps) {
      assert.ok(
        BUCKET_OWNERS[map.file],
        `${key} declares a *_STATUS_BUCKETS map that this test does not know the enum for. `
        + `Add it to BUCKET_OWNERS with the enum its status column uses — a map nobody checks is how ISSUED / PARTIAL / COMPLETED survived.`,
      );
    }
    for (const [file, enumName] of Object.entries(BUCKET_OWNERS)) {
      const mine = [...maps.values()].filter((m) => m.file === file);
      assert.equal(
        mine.length, 1,
        `${file} declares ${mine.length} *_STATUS_BUCKETS map(s) (${mine.map((m) => m.name).join(", ") || "none"}) — expected exactly one for ${enumName}. `
        + `Zero means it was renamed or moved; two means a second map now shares the file, and BUCKET_OWNERS pairs an enum with a FILE, so it can no longer say which map that enum belongs to.`,
      );
      const map = mine[0];
      const keys = Object.keys(map.buckets);
      assert.ok(keys.length >= 3, `${map.name} parsed as ${keys.length} buckets — the map pattern is broken`);
      const values = keys.flatMap((k) => map.buckets[k]);
      assert.ok(values.length >= keys.length, `${map.name} parsed ${values.length} values across ${keys.length} buckets — the value pattern is broken`);
    }
  });
});

/* Driven by what is DECLARED, not by what is registered. Registration is a
   separate assertion above; if a file grew a second map, both are checked here
   on their own merits rather than one hiding behind the other. */
describe("status buckets against the enum", () => {
  for (const [key, { file, name, buckets }] of maps) {
    const enumName = BUCKET_OWNERS[file];
    test(`${key}: every bucket value is a member of ${enumName ?? "its (unregistered) enum"}`, () => {
      assert.ok(enumName, `${file} is in no BUCKET_OWNERS entry, so nothing knows which enum ${name} must be a subset of`);
      const members = enums.get(enumName);
      for (const [bucket, values] of Object.entries(buckets)) {
        for (const value of values) {
          assert.ok(
            members.has(value),
            `${name}.${bucket} contains '${value}', which is not a member of ${enumName} `
            + `(${[...members].sort().join(", ")}). Postgres answers a non-member with `
            + `22P02 invalid input value for enum ${enumName}: "${value}" — the tab 500s and its count fails to 0.`,
          );
        }
      }
    });

    test(`${key}: every member of ${enumName ?? "its (unregistered) enum"} is reachable from a bucket`, () => {
      assert.ok(enumName, `${file} is in no BUCKET_OWNERS entry, so nothing knows which enum ${name} must cover`);
      const covered = new Set(Object.values(buckets).flat());
      for (const member of enums.get(enumName)) {
        assert.ok(
          covered.has(member),
          `${enumName} has '${member}' but no ${name} bucket covers it, so a row in that status is counted in `
          + `'all' and shown in no tab. Put it in the bucket it belongs to (and make the frontend's bucket map agree).`,
        );
      }
    });
  }
});
