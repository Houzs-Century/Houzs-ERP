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
   hand-written pairing in this test, and the "no stray map" check below makes it
   self-completing: a new *_STATUS_BUCKETS anywhere under src/ that is not listed
   here fails, so the next list endpoint cannot quietly opt out of the check. */
const BUCKET_OWNERS = {
  "src/scm/routes/mfg-purchase-orders.ts": "po_status",
  "src/scm/routes/purchase-invoices.ts": "purchase_invoice_status",
  "src/scm/routes/sales-invoices.ts": "sales_invoice_status",
  "src/scm/routes/grns.ts": "grn_status",
  "src/scm/routes/delivery-orders-mfg.ts": "do_status",
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

const BUCKET_DECL = /const\s+(\w*_STATUS_BUCKETS)\s*:[^=]*=\s*\{([\s\S]*?)\n\};/g;

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** repo-relative file path -> { name, buckets: { bucket: [values] } } */
function readBucketMaps() {
  const found = new Map();
  for (const file of listSourceFiles(SRC_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("_STATUS_BUCKETS")) continue;
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
      const rel = path.relative(backendRoot, file).split(path.sep).join("/");
      found.set(rel, { name: m[1], buckets });
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

  test("every *_STATUS_BUCKETS map under src/ is registered here", () => {
    assert.equal(
      maps.size,
      Object.keys(BUCKET_OWNERS).length,
      `found ${maps.size} bucket maps, expected ${Object.keys(BUCKET_OWNERS).length}: ${[...maps.keys()].join(", ")}`,
    );
    for (const file of maps.keys()) {
      assert.ok(
        BUCKET_OWNERS[file],
        `${file} declares a *_STATUS_BUCKETS map that this test does not know the enum for. `
        + `Add it to BUCKET_OWNERS with the enum its status column uses — a map nobody checks is how ISSUED / PARTIAL / COMPLETED survived.`,
      );
    }
    for (const [file, enumName] of Object.entries(BUCKET_OWNERS)) {
      const map = maps.get(file);
      assert.ok(map, `${file} no longer declares a *_STATUS_BUCKETS map — was it renamed or moved? (${enumName})`);
      const keys = Object.keys(map.buckets);
      assert.ok(keys.length >= 3, `${map.name} parsed as ${keys.length} buckets — the map pattern is broken`);
      const values = keys.flatMap((k) => map.buckets[k]);
      assert.ok(values.length >= keys.length, `${map.name} parsed ${values.length} values across ${keys.length} buckets — the value pattern is broken`);
    }
  });
});

describe("status buckets against the enum", () => {
  for (const [file, enumName] of Object.entries(BUCKET_OWNERS)) {
    test(`${file}: every bucket value is a member of ${enumName}`, () => {
      const { name, buckets } = maps.get(file);
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

    test(`${file}: every member of ${enumName} is reachable from a bucket`, () => {
      const { name, buckets } = maps.get(file);
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
