// ----------------------------------------------------------------------------
// schema-artifact.mjs — the two pure helpers the schema-truth checks share:
//
//   parseSchemaArtifact()  read src/db/schema.pg.ts into { table -> columns }
//   repairRawDefaults()    the one mechanical repair applied to drizzle-kit
//                          pull output before it is committed
//
// WHY A PARSER AND NOT AN IMPORT. The artifact is TypeScript and the checks that
// use it run as .mjs on whatever Node the runner ships. Importing it would make
// the checker's ability to run depend on type-stripping being enabled, and a
// checker that cannot run is a checker that reports nothing. Text in, facts out.
//
// Both helpers are regex/scanner code, which is exactly the kind of thing that
// dies silently. Each ships a hermetic self-test and every caller runs it BEFORE
// reading anything real: a parser that returns [] must never read as "the
// artifact declares nothing", and a repair pass that mangles a file must never
// be allowed to write it.
// ----------------------------------------------------------------------------

/* Every pg-core builder used by the artifact. A builder missing from this list
   makes its column INVISIBLE, which is the same failure the whole check exists
   to stop — so unknownBuilders() reports any `key: someFn("col")` whose
   function is not here, and the callers treat that as fatal. */
const BUILDERS = [
  "text", "integer", "bigint", "serial", "bigserial", "smallint", "boolean",
  "doublePrecision", "real", "numeric", "decimal", "jsonb", "json", "uuid",
  "timestamp", "date", "time", "varchar", "char", "customType", "smallserial",
];

const TABLE_RE = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\(\s*["'`]([a-z_0-9]+)["'`]\s*,\s*\{/g;
/* Two shapes, because the generated file and the hand-written one differ:
     hand-written   logo_r2_key: text("logo_r2_key")
     generated      logo_r2_key: text()
   In the generated form drizzle infers the column name from the key, so the key
   IS the column name. Reading only the first shape would see zero columns in a
   regenerated file - a clean run over nothing. */
const COLUMN_RE = new RegExp(
  String.raw`^\s{2,}(?:"([\w$]+)"|([A-Za-z_$][\w$]*))\s*:\s*(` +
    BUILDERS.join("|") +
    String.raw`)\s*\(\s*(?:["'\x60]([a-z_0-9]+)["'\x60])?`,
);
/* Catches a builder this file does not know about, so a new column type cannot
   silently drop a column out of the census. */
const UNKNOWN_RE = /^\s{2,}(?:"[\w$]+"|[A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\(/;

export function parseSchemaArtifact(src) {
  const tables = new Map();
  TABLE_RE.lastIndex = 0;
  const unknown = [];
  for (const m of src.matchAll(TABLE_RE)) {
    const [, exportName, tableName] = m;
    // Brace-match from the `{` that TABLE_RE just consumed.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const body = src.slice(m.index + m[0].length, i - 1);
    const columns = new Map();
    const lines = body.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const cm = line.match(COLUMN_RE);
      if (!cm) {
        const um = line.match(UNKNOWN_RE);
        if (um && !BUILDERS.includes(um[1])) unknown.push(`${tableName}: ${um[1]}(...)`);
        continue;
      }
      // Explicit first argument wins; otherwise drizzle takes the key.
      const col = cm[4] ?? cm[1] ?? cm[2];
      /* A column entry routinely wraps: `.notNull()` and `.unique()` land on
         following lines. Read forward until the entry ends rather than trusting
         one line. */
      let chunk = line;
      let j = li;
      while (
        j + 1 < lines.length &&
        !/,\s*(\/\/.*)?$/.test(chunk.trimEnd()) &&
        !/^\s*\}/.test(lines[j + 1])
      ) {
        j++;
        chunk += "\n" + lines[j];
      }
      columns.set(col, {
        notNull: /\.notNull\(\)/.test(chunk),
        unique: /\.unique\(/.test(chunk),
      });
    }
    tables.set(tableName, { export: exportName, columns });
  }
  return { tables, unknownBuilders: unknown };
}

/* Hermetic fixture. Covers: a plain table, a wrapped `.notNull().unique()`
   entry, a multi-line entry, a table whose second argument is an extras
   callback (the `pgTable(name, {...}, (t) => [...])` shape), the GENERATED
   no-argument column form, and a builder the parser must report rather than
   skip. */
export const FIXTURE = [
  "",
  'export const alpha = pgTable("alpha", {',
  '  id: serial("id").primaryKey(),',
  '  name: text("name").notNull().unique(),',
  '  note: text("note"),',
  "});",
  "",
  "export const beta = pgTable(",
  '  "beta",',
  "  {",
  '    alpha_id: integer("alpha_id").notNull(),',
  '    payload: jsonb("payload"),',
  '    made_at: timestamp("made_at", { withTimezone: true })',
  "      .notNull()",
  "      .default(sql`now()`),",
  "  },",
  "  (t) => [primaryKey({ columns: [t.alpha_id] })],",
  ");",
  "",
  'export const gamma = pgTable("gamma", {',
  "  company_id: bigint({ mode: \"number\" }).notNull(),",
  "  logo_r2_key: text(),",
  '  weird: mysteryType("weird"),',
  "});",
  "",
].join("\n");

export function selfTestParser() {
  const { tables, unknownBuilders } = parseSchemaArtifact(FIXTURE);
  const a = tables.get("alpha");
  const b = tables.get("beta");
  const g = tables.get("gamma");
  const problems = [];
  if (tables.size !== 3) problems.push(`expected 3 tables, got ${tables.size}`);
  if (!a || a.export !== "alpha") problems.push("alpha export name lost");
  if (!a || [...a.columns.keys()].join(",") !== "id,name,note") {
    problems.push(`alpha columns wrong: ${a ? [...a.columns.keys()].join(",") : "(none)"}`);
  }
  if (!a?.columns.get("name")?.notNull) problems.push("alpha.name notNull missed");
  if (!a?.columns.get("name")?.unique) problems.push("alpha.name unique missed");
  if (a?.columns.get("note")?.notNull) problems.push("alpha.note wrongly notNull");
  if (!b || [...b.columns.keys()].join(",") !== "alpha_id,payload,made_at") {
    problems.push(`beta columns wrong: ${b ? [...b.columns.keys()].join(",") : "(none)"}`);
  }
  if (!b?.columns.get("made_at")?.notNull) problems.push("beta.made_at multi-line notNull missed");
  if (b?.columns.get("payload")?.notNull) problems.push("beta.payload wrongly notNull");
  /* THE REGRESSION FIXTURE. These two are the generated no-argument form and
     they are the exact columns whose absence hid the brand-letterhead leak. If
     the parser stops seeing them, every drift and scope check built on it goes
     quietly blind. */
  if (!g || !g.columns.has("company_id")) problems.push("generated form: company_id not seen");
  if (!g?.columns.get("company_id")?.notNull) problems.push("generated form: notNull missed");
  if (!g?.columns.has("logo_r2_key")) problems.push("generated form: logo_r2_key not seen");
  if (!unknownBuilders.some((u) => u.includes("mysteryType"))) {
    problems.push("unknown builder not reported");
  }
  return problems;
}

// ----------------------------------------------------------------------------
// repairRawDefaults — applied to `drizzle-kit pull` output before it is
// committed as src/db/schema.pg.ts.
//
// drizzle-kit 0.31.10 emits INVALID TypeScript for a column default that is a
// function call; 94 columns in this database hit it. The emitted shape is a
// bare SQL expression carrying backslash-escaped quotes, which does not parse,
// so `pull` output cannot be committed as it comes out. The choice is between
// repairing that one shape mechanically or hand-writing the schema. This
// rewrites exactly that shape into the documented raw-default form and touches
// no other token.
// ----------------------------------------------------------------------------

/* A default is a JS literal when it is a number, a quoted string, true / false
   / null, or an already-wrapped sql`` tag. Anything else is SQL drizzle-kit
   failed to wrap. */
const LITERAL_DEFAULT = new RegExp(
  String.raw`^\s*(?:-?\d[\d_.eE+-]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|true|false|null|sql\x60)`,
);

export function repairRawDefaults(src) {
  let out = "";
  let i = 0;
  let repaired = 0;
  const NEEDLE = ".default(";
  for (;;) {
    const at = src.indexOf(NEEDLE, i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }
    const open = at + NEEDLE.length;
    let depth = 1;
    let j = open;
    let inStr = null;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      /* A backslash escapes the next character ANYWHERE, not only inside a
         string. The broken output is full of bare \' pairs; treating one as a
         quote opener desynchronises the scanner and it swallows the rest of the
         file. The self-test caught exactly that while this was written. */
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (inStr) {
        if (ch === inStr) inStr = null;
      } else if (ch === "'" || ch === '"' || ch === "\x60") {
        inStr = ch;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    const inner = src.slice(open, j - 1);
    out += src.slice(i, open);
    if (LITERAL_DEFAULT.test(inner)) {
      out += inner;
    } else {
      const sqlText = inner
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\x60/g, "\\\x60")
        .replace(/\$\{/g, "\\${");
      out += "sql\x60" + sqlText + "\x60";
      repaired++;
    }
    out += ")";
    i = j;
  }
  return { text: out, repaired };
}

export function selfTestRepair() {
  const B = "\x60";
  const before = [
    "\tcreated_at: text().default(to_char(timezone(\\'UTC\\'::text, now()), \\'YYYY-MM-DD HH24:MI:SS\\'::text)).notNull(),",
    '\tactive: bigint({ mode: "number" }).default(1).notNull(),',
    "\tstatus: text().default('running').notNull(),",
    "\tflag: boolean().default(true),",
    `\tkept: text().default(sql${B}now()${B}),`,
    "\tnum: doublePrecision().default(-1.5),",
  ].join("\n");
  const { text, repaired } = repairRawDefaults(before);
  const problems = [];
  if (repaired !== 1) problems.push(`expected exactly 1 repair, got ${repaired}`);
  const wants = [
    `created_at: text().default(sql${B}to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD HH24:MI:SS'::text)${B}).notNull(),`,
    'active: bigint({ mode: "number" }).default(1).notNull(),',
    "status: text().default('running').notNull(),",
    "flag: boolean().default(true),",
    `kept: text().default(sql${B}now()${B}),`,
    "num: doublePrecision().default(-1.5),",
  ];
  for (const w of wants) if (!text.includes(w)) problems.push(`lost or mangled: ${w}`);
  if (text.split("\n").length !== before.split("\n").length) {
    problems.push("line count changed - the scanner swallowed something");
  }
  return problems;
}
