// Read-only probe: what does PRODUCTION actually enforce on
// `public.assr_cases.priority`, and which maintained priorities does it refuse?
//
// WHY THIS EXISTS
//
// Service Maintenance (Settings → Service → Priorities) lets an admin ADD a
// priority: `POST /api/assr/lookups/priorities` inserts a row into
// `assr_priorities`, and the intake picker on both desktop
// (`ServiceCases.tsx` → `priorityOptions`) and mobile (`MobileServiceCase.tsx`
// → `useLookupSlugs("priorities", …)`) is built from those slugs. Case create
// then stores that slug verbatim in `assr_cases.priority`
// (`services/assr.ts`, the INSERT column list).
//
// If `assr_cases.priority` still carries the original
// `CHECK (priority IN ('low','normal','high','urgent'))` then the settings
// screen offers a value the database refuses — the worst of both worlds. The
// D1 schema dump says that CHECK exists; a dump is not production, and
// `0000_baseline.sql` in this repo is 93 migrations stale and has misled two
// people. Only `pg_constraint` decides.
//
// The standing rule forbids putting the production DSN in front of a human for
// a SELECT, and Actions already holds `secrets.DATABASE_URL` for the deploy —
// so the probe runs here.
//
// It answers four questions:
//
//   1. THE CONSTRAINT — every CHECK on `public.assr_cases`, rendered by
//      `pg_get_constraintdef`. This is the fact the fix is shaped around: is
//      there a CHECK on `priority` at all, and what exactly does it admit?
//   2. WHO IT REFUSES — every slug in `assr_priorities` that the live CHECK
//      would reject. Non-empty = a priority already sitting in the picker that
//      cannot be used, i.e. the defect is not hypothetical.
//   3. WHAT IS ALREADY STORED — the distinct `priority` values on real cases,
//      so a widening/dropping decision knows what history contains.
//   4. THE SIBLING SHAPE — is `assr_priorities.sla_hours` (made live
//      2026-08-20) constrained in the same way for a NEWLY ADDED row? Its
//      column definition plus every CHECK on `assr_priorities`.
//
// READING, NOT A SETTING. SELECTs only — no DDL, no writes, no transaction, one
// statement per question. Exits 0 for every legitimate answer: the ANSWER is the
// output, and a red job would read as "the check broke". Only an unreachable
// database or a query error exits non-zero.
//
// RE-RUN: safe and identical. It writes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── 1. THE CONSTRAINT ────────────────────────────────────────────────────
  const checks = await pg`
    SELECT con.conname                        AS name,
           pg_get_constraintdef(con.oid)      AS definition
      FROM pg_constraint con
      JOIN pg_class     rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'assr_cases'
       AND con.contype = 'c'
     ORDER BY con.conname
  `;
  console.log("── 1. CHECK constraints on public.assr_cases ──");
  if (checks.length === 0) console.log("   (none)");
  for (const r of checks) console.log(`   ${r.name}\n      ${r.definition}`);

  const priorityChecks = checks.filter((r) =>
    /\bpriority\b/.test(String(r.definition)),
  );

  // ── 2. WHO IT REFUSES ────────────────────────────────────────────────────
  // Ask the DATABASE whether each maintained slug satisfies the live CHECK,
  // rather than re-parsing the constraint text in JavaScript. A regex over
  // `pg_get_constraintdef` output is a second implementation of Postgres'
  // own expression evaluator, and it would be wrong the first time the
  // constraint is written any way but the one shape we expected.
  //
  // This is still strictly a READ: the expression is evaluated in a SELECT
  // over `assr_priorities`, and nothing is inserted anywhere.
  console.log("");
  console.log("── 2. maintained priorities vs the live CHECK ──");
  const slugs = await pg`
    SELECT slug, name, active, sla_hours
      FROM assr_priorities
     ORDER BY sort_order, slug
  `;
  const refused = [];
  if (slugs.length === 0) {
    console.log("   assr_priorities is EMPTY in production.");
  } else if (priorityChecks.length === 0) {
    console.log("   No CHECK mentions `priority` — every maintained slug is accepted.");
    for (const s of slugs) console.log(`   ${String(s.slug).padEnd(16)} ${s.name}`);
  } else {
    // Rebuild the constraint expression with `priority` replaced by the
    // candidate slug, and let Postgres evaluate it.
    for (const s of slugs) {
      let admitted = null;
      for (const chk of priorityChecks) {
        // `$1` is written by a REPLACER FUNCTION, not a replacement string:
        // in a string replacement `$1` is dollar-sign syntax, and relying on
        // "there is no capture group so it stays literal" is exactly the kind
        // of cleverness that breaks the day someone adds a group.
        const expr = String(chk.definition)
          .replace(/^CHECK\s*/i, "")
          .replace(/\bpriority\b/g, () => "$1::text");
        try {
          const [row] = await pg.unsafe(`SELECT (${expr}) AS ok`, [s.slug]);
          // A CHECK is satisfied when it is TRUE **or** NULL; only FALSE refuses.
          admitted = row.ok === false ? false : admitted === false ? false : true;
        } catch (e) {
          console.log(`   (could not evaluate ${chk.name}: ${String(e.message).slice(0, 90)})`);
          admitted = admitted ?? null;
        }
      }
      const verdict = admitted === false ? "REFUSED" : admitted === true ? "accepted" : "unknown";
      if (admitted === false) refused.push(s.slug);
      console.log(
        `   ${String(s.slug).padEnd(16)} active=${String(s.active).padEnd(5)} sla=${String(s.sla_hours ?? "-").padEnd(5)} ${verdict}`,
      );
    }
  }

  // ── 3. WHAT IS ALREADY STORED ────────────────────────────────────────────
  console.log("");
  console.log("── 3. priority values already on real cases ──");
  const stored = await pg`
    SELECT COALESCE(priority, '(null)') AS priority, COUNT(*) AS cases
      FROM assr_cases
     GROUP BY priority
     ORDER BY COUNT(*) DESC
  `;
  for (const r of stored) {
    console.log(`   ${String(r.priority).padEnd(16)} ${r.cases}`);
  }

  // ── 4. THE SIBLING SHAPE ─────────────────────────────────────────────────
  console.log("");
  console.log("── 4. assr_priorities: column shape + its own CHECKs ──");
  const cols = await pg`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'assr_priorities'
     ORDER BY ordinal_position
  `;
  for (const r of cols) {
    console.log(
      `   ${String(r.column_name).padEnd(14)} ${String(r.data_type).padEnd(26)} nullable=${String(r.is_nullable).padEnd(4)} default=${r.column_default ?? "-"}`,
    );
  }
  const prioChecks = await pg`
    SELECT con.conname                   AS name,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class     rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'assr_priorities'
       AND con.contype IN ('c', 'u', 'p')
     ORDER BY con.contype, con.conname
  `;
  for (const r of prioChecks) console.log(`   ${r.name}\n      ${r.definition}`);

  // ── 5. THE OTHER WAY A MAINTAINED PRIORITY CAN GO WRONG ──────────────────
  // `pg_constraint` above cannot see a bare `CREATE UNIQUE INDEX` — an index
  // created outside a constraint has no `pg_constraint` row at all. This repo
  // has already been wrong about a unique index existing, in both directions
  // ("the unique index does not exist" — it did, four of them), so ask
  // `pg_indexes`, which sees every index however it was created.
  //
  // It matters here because `POST /api/assr/lookups/priorities` inserts with
  // `ON CONFLICT DO NOTHING`, a clause that silently does nothing at all when
  // there is no unique index for it to conflict ON — and the endpoint derives
  // the slug from the NAME, so adding a priority named "High" derives `high`.
  console.log("");
  console.log("── 5. indexes on assr_priorities (pg_indexes sees bare CREATE INDEX too) ──");
  const idx = await pg`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'assr_priorities'
     ORDER BY indexname
  `;
  for (const r of idx) console.log(`   ${r.indexname}\n      ${r.indexdef}`);
  const uniqueOnSlug = idx.some(
    (r) => /UNIQUE/i.test(String(r.indexdef)) && /\(\s*slug\s*\)/i.test(String(r.indexdef)),
  );
  console.log("");
  console.log(`   UNIQUE index on slug: ${uniqueOnSlug ? "YES" : "NO"}`);

  const dupes = await pg`
    SELECT slug, COUNT(*) AS rows
      FROM assr_priorities
     GROUP BY slug
    HAVING COUNT(*) > 1
     ORDER BY slug
  `;
  console.log(
    dupes.length === 0
      ? "   duplicate slugs today: none"
      : `   duplicate slugs today: ${dupes.map((d) => `${d.slug} x${d.rows}`).join(", ")}`,
  );

  console.log("");
  if (!uniqueOnSlug) {
    notice(
      "assr_priorities has NO unique index on `slug`, so the lookup POST's `ON CONFLICT DO NOTHING` has nothing to conflict on. Two rows can hold the same slug, and slaHoursForPriority's `WHERE slug = ? LIMIT 1` would then pick one arbitrarily. This is a SEPARATE finding from the CHECK question below.",
    );
  }
  notice(
    priorityChecks.length === 0
      ? "public.assr_cases.priority carries NO CHECK constraint in production. A priority added in Service Maintenance is accepted on case create — the reported defect does NOT exist on this database, and no migration is warranted."
      : refused.length > 0
        ? `public.assr_cases.priority is CHECK-constrained (${priorityChecks.map((r) => r.name).join(", ")}) and REFUSES ${refused.length} maintained priority slug(s): ${refused.join(", ")}. Creating a case with one of those fails at the database. The settings screen offers a value the system rejects.`
        : `public.assr_cases.priority is CHECK-constrained (${priorityChecks.map((r) => r.name).join(", ")}) but every slug currently in assr_priorities is admitted — so nothing is broken TODAY. The next priority an admin adds is refused, because the CHECK is a fixed list the maintenance screen cannot extend.`,
  );
  process.exit(0);
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
