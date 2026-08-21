// ----------------------------------------------------------------------------
// schema-artifact.mjs — parse backend/src/db/schema.pg.ts into a plain
// { table -> { export, columns: { col -> {notNull, unique} } } } map.
//
// WHY A PARSER AND NOT AN IMPORT. The artifact is TypeScript and the checks that
// use it run as .mjs on whatever Node the runner ships. Importing it would make
// the checker's ability to run depend on type-stripping being enabled, and a
// checker that cannot run is a checker that reports nothing. Text in, facts out.
//
// This is regex over source, so it is exactly the kind of thing that dies
// silently. parseSchemaArtifact() is self-tested by its callers against the
// FIXTURE below before any real file is read; a parser that returns [] must
// never read as "the artifact declares nothing".
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
const COLUMN_RE = new RegExp(
  String.raw`^\s{2,}(?:"([\w$]+)"|([A-Za-z_$][\w$]*))\s*:\s*(` +
    BUILDERS.join("|") +
    String.raw`)\s*\(\s*["'\x60]([a-z_0-9]+)["'\x60]`,
);
/* Catches a builder this file does not know about, so a new column type cannot
   silently drop a column out of the census. */
const UNKNOWN_RE = /^\s{2,}(?:"[\w$]+"|[A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\(\s*["'`][a-z_0-9]+["'`]/;

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
      const col = cm[4];
      /* A column entry routinely wraps: `.notNull()` and `.unique()` land on
         following lines. Read forward until the entry ends (a line whose trailing
         comma closes it at depth 0) rather than trusting one line. */
      let chunk = line;
      let j = li;
      while (j + 1 < lines.length && !/,\s*(\/\/.*)?$/.test(chunk.trimEnd()) && !/^\s*\}/.test(lines[j + 1])) {
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
   callback (the `pgTable(name, {...}, (t) => [...])` shape), and a builder the
   parser must report rather than skip. */
export const FIXTURE = `
export const alpha = pgTable("alpha", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  note: text("note"),
});

export const beta = pgTable(
  "beta",
  {
    alpha_id: integer("alpha_id").notNull(),
    payload: jsonb("payload"),
    made_at: timestamp("made_at", { withTimezone: true })
      .notNull()
      .default(sql\`now()\`),
  },
  (t) => [primaryKey({ columns: [t.alpha_id] })],
);

export const gamma = pgTable("gamma", {
  weird: mysteryType("weird"),
});
`;

export function selfTestParser() {
  const { tables, unknownBuilders } = parseSchemaArtifact(FIXTURE);
  const a = tables.get("alpha");
  const b = tables.get("beta");
  const problems = [];
  if (tables.size !== 3) problems.push(`expected 3 tables, got ${tables.size}`);
  if (!a || a.export !== "alpha") problems.push("alpha export name lost");
  if (!a || [...a.columns.keys()].join(",") !== "id,name,note")
    problems.push(`alpha columns wrong: ${a ? [...a.columns.keys()].join(",") : "(none)"}`);
  if (!a?.columns.get("name")?.notNull) problems.push("alpha.name notNull missed");
  if (!a?.columns.get("name")?.unique) problems.push("alpha.name unique missed");
  if (a?.columns.get("note")?.notNull) problems.push("alpha.note wrongly notNull");
  if (!b || [...b.columns.keys()].join(",") !== "alpha_id,payload,made_at")
    problems.push(`beta columns wrong: ${b ? [...b.columns.keys()].join(",") : "(none)"}`);
  if (!b?.columns.get("made_at")?.notNull) problems.push("beta.made_at multi-line notNull missed");
  if (b?.columns.get("payload")?.notNull) problems.push("beta.payload wrongly notNull");
  if (!unknownBuilders.some((u) => u.includes("mysteryType")))
    problems.push("unknown builder not reported");
  return problems;
}
