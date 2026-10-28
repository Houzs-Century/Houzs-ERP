// Backfill stored contact numbers to E.164, reversibly.
//
// Owner approved 2026-07-22 after the read-only audit reported 3788 values
// without a country code across 7 columns.
//
// WHY THIS IS A SCRIPT AND NOT A MIGRATION. pg-migrate runs on a push to main
// against production, and deploy-staging.yml runs on the same push against
// staging — so a migration file gives no "staging first", it gives "both at
// once". A workflow_dispatch script is the only shape where the staging run
// can be inspected before production is touched.
//
// SAFETY, in the order it matters:
//
//  1. DRY RUN IS THE DEFAULT. Writing needs --apply. A run with no flags
//     reports what it would do and changes nothing.
//  2. EVERY CHANGE IS RECORDED BEFORE IT IS MADE, in phone_normalisation_backup
//     (table, column, row id, old value, new value, run id). Reversing the
//     whole backfill is one UPDATE ... FROM that table. 3788 customer phone
//     numbers is not something to change without a way back.
//  3. THE SAME CONSERVATIVE GUARD THE API USES. canonicalizeSinglePhone
//     refuses anything that is not unambiguously ONE number — these are free
//     text columns and creditors.phone1 in particular has held "03-1234 5678 /
//     019-876 5432". Collapsing that into one string would destroy a supplier
//     contact, so a value we cannot canonicalise is LEFT ALONE and counted as
//     skipped, never guessed at.
//  4. NO ROW IS TOUCHED TWICE. Only rows whose canonical form actually differs
//     are updated, so re-running is a no-op and an interrupted run resumes
//     safely.
//  5. ONE TRANSACTION PER COLUMN. A failure rolls that column back whole
//     rather than leaving it half-converted.
//
// Usage:
//   node scripts/normalize-stored-phones.mjs             # dry run, changes nothing
//   node scripts/normalize-stored-phones.mjs --apply     # writes, with backup
//   node scripts/normalize-stored-phones.mjs --revert=<runId>
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { canonicalizeSinglePhone } from "./lib/phone-normalise.mjs";

// Curated dial codes, longest first so 673 wins over 6 — mirrors
// COUNTRY_DIAL_CODES in src/scm/shared/phone.ts.
const DIALS = ["673","855","856","880","886","852","971","966","995","60","65","62","66","84","63","95","86","91","92","94","61","64","81","82","44","1"]
  .sort((a, b) => b.length - a.length);

// The columns to normalise, named explicitly rather than introspected: a
// backfill must change exactly the set a human approved, not whatever a pattern
// happens to match on the day it runs. Every entry is existence-checked at run
// time (columnExists) and skipped-with-warning if absent, so listing a column a
// given database doesn't have is safe.
//
// 2026-07-23 EXPANSION. The first backfill only listed `sales_orders`, but the
// live SCM app writes customer phones to `mfg_sales_orders` (a DIFFERENT table)
// and to the consignment / delivery / invoice / delivery-planning tables — none
// of which were ever normalised. That is why SO phones still displayed unformatted
// (e.g. "60123456789" with no "+") after the first run. The active tables below
// are taken from the routes' own `.from('…')` targets.
const TARGETS = [
  // ── Customer / staff master ──
  { table: "users", column: "phone" },
  { table: "creditors", column: "phone1" },
  { table: "creditors", column: "mobile" },
  { table: "creditors", column: "phone2" },
  { table: "creditors", column: "whatsapp_number" },
  { table: "sales_entries", column: "customer_phone" },
  { table: "sales_entries", column: "customer_phone_2" },
  { table: "assr_cases", column: "phone" },
  { table: "drivers", column: "phone" },
  { table: "helpers", column: "contact" },
  // ── Legacy SO table (kept — may still hold rows) ──
  { table: "sales_orders", column: "phone" },
  // ── ACTIVE manufacturing sales orders (the table the app actually uses) ──
  { table: "mfg_sales_orders", column: "phone" },
  { table: "mfg_sales_orders", column: "emergency_contact_phone" },
  // ── Delivery-planning orders (the raw write path fixed in this same PR) ──
  { table: "dp_orders", column: "contact_phone" },
  // ── Consignment ──
  { table: "consignment_sales_orders", column: "phone" },
  { table: "consignment_sales_orders", column: "emergency_contact_phone" },
  { table: "consignment_delivery_orders", column: "phone" },
  { table: "consignment_delivery_orders", column: "emergency_contact_phone" },
  { table: "consignment_delivery_returns", column: "phone" },
  { table: "consignment_delivery_returns", column: "emergency_contact_phone" },
  // ── Delivery orders / returns (+ crew snapshot contacts) ──
  { table: "delivery_orders", column: "phone" },
  { table: "delivery_orders", column: "emergency_contact_phone" },
  { table: "delivery_orders", column: "driver_1_contact" },
  { table: "delivery_orders", column: "driver_2_contact" },
  { table: "delivery_orders", column: "helper_1_contact" },
  { table: "delivery_orders", column: "helper_2_contact" },
  { table: "delivery_returns", column: "phone" },
  { table: "delivery_returns", column: "emergency_contact_phone" },
  // ── Sales invoices ──
  { table: "sales_invoices", column: "phone" },
  { table: "sales_invoices", column: "emergency_contact_phone" },
];

/* WHICH STORED VALUES MAY BE ASSUMED MALAYSIAN.
 *
 * canonicalizeSinglePhone is the API's rule, and for LIVE INPUT it is right: a
 * person typing into a form with a country picker set to Malaysia means
 * Malaysia. For a BACKFILL over rows nobody is looking at, the same rule is
 * dangerous, because normalizePhone treats any bare 8+ digit string as
 * Malaysian:
 *
 *     "61234567"  ->  "+6061234567"
 *
 * If that row was a Singapore landline (6123 4567) the migration has just
 * turned an obviously-broken number into a CONFIDENTLY WRONG one. Before, a
 * human looking at it would ask the customer. After, it looks like a normal
 * +60 number and nobody ever questions it — and the customer is unreachable.
 * That is strictly worse than leaving it alone.
 *
 * So the backfill converts only what is UNAMBIGUOUSLY Malaysian local:
 *   - leading trunk 0  ("0123456789")      — the ordinary local form
 *   - leading 60       ("60123456789")     — already says Malaysia
 *   - bare 9-10 digits starting with 1     — a mobile written without the 0,
 *                                            the shape the OCR rule produces
 * Everything else is REPORTED, not guessed at. A number a human must look at
 * is not a number a script should decide.
 */
function malaysianLocalShape(raw) {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (digits.startsWith('0')) return true;
  if (digits.startsWith('60')) return true;
  if (digits.startsWith('1') && (digits.length === 9 || digits.length === 10)) return true;
  return false;
}

/* A value that is NOT Malaysian-local may still be perfectly good: the whole
 * point of the 2026-07-22 dry run was that most of them already carry a country
 * code and are only missing the "+".
 *
 *     "6590254610"  =  +65 9025 4610   a complete Singapore mobile
 *     "880-1843395337" = +880 …        a complete Bangladeshi number
 *
 * Calling those "needs a human" wastes real phone calls on numbers that are
 * already right. So they are split:
 *
 *   RECOVERABLE — the digits start with a dial code we know, and what follows
 *     is a plausible national number (4-12 digits). Adding "+" is not a guess:
 *     a Malaysian mobile is 01X and a landline 0X, so a string opening with 65
 *     or 880 cannot be a Malaysian local number in the first place.
 *
 *   UNKNOWABLE — everything else. "NA", "#ERROR!", two numbers in one field, a
 *     length that matches nothing. These are the ones worth a phone call.
 *
 * Returns the E.164 form for a recoverable value, or null. */
/* A leading 6 typed twice. Owner, 2026-07-23, on "660196657356": "這個是6019
 * 馬來西亞 我們大部分還是馬來西亞的."
 *
 * This is decidable, not a lean: drop ONE leading 6 and ask whether what
 * remains is a valid Malaysian number.
 *
 *     "660196657356" -> "60196657356" -> +60 19-665 7356   valid   => doubled 6
 *     "6590254610"   -> "590254610"   -> not a MY number   invalid => really +65
 *
 * So it cannot misfire on the Singapore rows: dropping their 6 leaves nothing
 * Malaysian behind. "most of ours are Malaysian" is the reason to look for this
 * pattern, never the reason to conclude it. */
function doubledLeadingSix(digits) {
  if (!digits.startsWith('66')) return null;
  const dropped = digits.slice(1);
  if (!dropped.startsWith('60')) return null;
  const national = dropped.slice(2);
  const ok = (national.startsWith('1') && (national.length === 9 || national.length === 10))
    || (!national.startsWith('1') && (national.length === 8 || national.length === 9));
  return ok ? `+${dropped}` : null;
}

function recoverableForeign(raw, dials) {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const six = doubledLeadingSix(digits);
  if (six) return six;
  // A "1" prefix is US/Canada (+1) OR the start of a Chinese mobile (+86 1[3-9]
  // …, 11 digits). "13362748640" is a valid +1 336-274-8640 AND a valid +86 133
  // 6274 8640, and nothing in the digits decides which. The creditors table
  // holds exactly this shape (133/132/158/157 openings), almost certainly
  // Chinese suppliers, but "almost certainly" is a population statistic, not
  // evidence about the row. So an 11-digit string that fits a Chinese mobile is
  // NOT auto-prefixed to +1 — it goes to the human pile until the owner says
  // whether these are +86. (If the owner confirms, add "86" handling above the
  // caller, not a guess here.)
  const looksLikeCnMobile = digits.length === 11 && /^1[3-9]/.test(digits);

  for (const d of dials) {
    if (!digits.startsWith(d)) continue;
    if (d === '1' && looksLikeCnMobile) return null; // undecidable US vs CN
    const national = digits.slice(d.length);
    // An E.164 national part never keeps the local trunk 0. If it does, the
    // dial-code match is probably an accident: "660196657356" reads as
    // +66 0196657356 (Thailand) but is far more likely "60196657356" — a real
    // Malaysian number — with a 6 typed twice. Guessing Thailand there is the
    // same mistake as guessing Malaysia for a Singapore number. Send it to a
    // human.
    if (national.startsWith('0')) return null;
    if (national.length >= 4 && national.length <= 12) return `+${digits}`;
  }
  return null;
}

/* Values a human has LOOKED AT and resolved, because the digits alone could
 * not. Keyed by exact stored value so it can only ever touch the row it names.
 *
 * The four below are creditors whose 11-digit 1[3-9] phone is US-or-Chinese by
 * shape (see #1051). The read-only lookup (who-are-ambiguous-phones.mjs) pulled
 * their names and currency on 2026-07-23:
 *   400-C005  创艺色智能科技(江苏)          CNY
 *   400-J002  9513家具 (JIUWUYISAN)         CNY
 *   405-N001  NANTONG YOURUI TEXTILE        CNY
 *   400-N003  南通友瑞纺织品                 MYR
 * All Jiangsu / Nantong Chinese suppliers — so +86, confirmed, not guessed. */
const CONFIRMED = {
  "creditors.phone1": {
    "13262989777": "+8613262989777",
    "15817803288": "+8615817803288",
    "13362748640": "+8613362748640",
    "15733777221": "+8615733777221",
  },
};

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.find((a) => a.startsWith("--revert="))?.slice(9);

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

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

// A run id ties every backup row to the run that wrote it, so a revert can
// target one run rather than "everything ever backfilled".
const RUN_ID = process.env.GITHUB_RUN_ID
  ? `gh-${process.env.GITHUB_RUN_ID}`
  : `local-${process.env.RUN_ID ?? "manual"}`;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function ensureBackupTable() {
  await pg`
    CREATE TABLE IF NOT EXISTS phone_normalisation_backup (
      id          bigserial PRIMARY KEY,
      run_id      text        NOT NULL,
      table_name  text        NOT NULL,
      column_name text        NOT NULL,
      pk_column   text        NOT NULL DEFAULT 'id',
      row_id      text        NOT NULL,
      old_value   text,
      new_value   text,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await pg`
    CREATE INDEX IF NOT EXISTS idx_phone_backup_run
      ON phone_normalisation_backup (run_id)`;
}

async function revert(runId) {
  const rows = await pg`
    SELECT table_name, column_name, pk_column, row_id, old_value
    FROM phone_normalisation_backup
    WHERE run_id = ${runId}`;
  if (rows.length === 0) {
    warn(`No backup rows for run ${runId} — nothing to revert.`);
    return;
  }
  let n = 0;
  for (const r of rows) {
    await pg`
      UPDATE ${pg(r.table_name)}
      SET ${pg(r.column_name)} = ${r.old_value}
      WHERE ${pg(r.pk_column)}::text = ${r.row_id}`;
    n += 1;
  }
  notice(`Reverted ${n} values from run ${runId}.`);
}

/* The primary-key column of a table, resolved rather than assumed.
 *
 * This script used to hardcode `id`. creditors does not have one — it is keyed
 * by creditor_code — so the staging dry run died with `column "id" does not
 * exist` AFTER three tables had already been reported. In apply mode that would
 * have been worse: each column commits in its own transaction, so the first
 * three tables would have been written and creditors would not, leaving a
 * half-done backfill whose only record of how far it got is a failed job log.
 *
 * Returns null for a table with no single-column primary key; the caller skips
 * it loudly rather than guessing at a row identifier. */
async function primaryKeyColumn(pg, table) {
  const rows = await pg`
    SELECT a.attname AS col
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND n.nspname = 'public' AND c.relname = ${table}`;
  return rows.length === 1 ? rows[0].col : null;
}

/* Does public.<table>.<column> actually exist?
 *
 * The active SO/delivery/consignment tables were added to TARGETS long after the
 * first backfill (which only knew the legacy `sales_orders`, NOT the real
 * `mfg_sales_orders` the app writes to — the reason SO phones stayed unnormalised
 * after the first run). Staging and production can also drift. So every target is
 * existence-checked and SKIPPED-with-warning when absent, rather than throwing
 * mid-run and half-completing. */
async function columnExists(pg, table, column) {
  const rows = await pg`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    LIMIT 1`;
  return rows.length === 1;
}

async function processColumn({ table, column }) {
  if (!(await columnExists(pg, table, column))) {
    warn(`SKIPPED ${table}.${column} — no such column in this database (schema drift / renamed table). Not an error.`);
    return { table, column, skipped: true };
  }
  const pk = await primaryKeyColumn(pg, table);
  if (!pk) {
    warn(`SKIPPED ${table}.${column} — no single-column primary key, so a row cannot be identified for the backup. Fix by hand or extend this script deliberately.`);
    return { table, column, skipped: true };
  }

  const rows = await pg`
    SELECT ${pg(pk)}::text AS pk, ${pg(column)} AS value
    FROM ${pg(table)}
    WHERE ${pg(column)} IS NOT NULL
      AND btrim(${pg(column)}) <> ''
      AND left(btrim(${pg(column)}), 1) <> '+'`;

  const changes = [];
  const refusedRows = [];
  const ambiguous = [];
  const recoverable = [];
  const confirmedMap = CONFIRMED[`${table}.${column}`] ?? {};
  for (const r of rows) {
    // A human already resolved this exact value — highest priority.
    const conf = confirmedMap[String(r.value).trim()];
    if (conf) { changes.push({ pk: r.pk, old: r.value, next: conf }); continue; }

    if (!malaysianLocalShape(r.value)) {
      // Not Malaysian-local. Foreign-but-recoverable ones (missing only a "+")
      // are written too — the owner asked to fix these in the same pass, and
      // adding "+" to a value that already carries a known dial code is not a
      // guess. Truly unknowable values are still left for a human.
      const rec = recoverableForeign(r.value, DIALS);
      if (rec) {
        recoverable.push({ pk: r.pk, old: r.value, next: rec });
        changes.push({ pk: r.pk, old: r.value, next: rec });
      } else {
        ambiguous.push(r);
      }
      continue;
    }
    const next = canonicalizeSinglePhone(r.value);
    if (next === r.value || next === "" || !next.startsWith("+")) {
      refusedRows.push(r);
      continue;
    }
    changes.push({ pk: r.pk, old: r.value, next });
  }
  const refused = refusedRows.length;

  notice(
    `${table}.${column}: ${rows.length} without a country code — ` +
      `${changes.length} to write ` +
      `(incl. ${recoverable.length} foreign recovered by adding "+"), ` +
      `${refused} unparseable, ${ambiguous.length} UNKNOWABLE (a human must call)`,
  );

  // A count does not prove correctness. Show what would actually change, so a
  // human can see that no number is being mangled before any of it is written.
  for (const c of changes.slice(0, 8)) {
    notice(`    ${JSON.stringify(c.old)}  ->  ${c.next}`);
  }
  if (changes.length > 8) notice(`    … and ${changes.length - 8} more of the same shapes`);

  for (const r of recoverable.slice(0, 6)) {
    notice(`    recoverable: ${JSON.stringify(r.old)}  ->  ${r.next}`);
  }
  if (recoverable.length > 6) notice(`    … and ${recoverable.length - 6} more recoverable`);

  for (const a of ambiguous.slice(0, 8)) {
    notice(`    UNKNOWABLE, untouched: ${JSON.stringify(a.value)}`);
  }
  if (ambiguous.length > 8) notice(`    … and ${ambiguous.length - 8} more ambiguous`);

  for (const r of refusedRows.slice(0, 3)) {
    notice(`    unparseable, untouched: ${JSON.stringify(r.value)}`);
  }

  if (!APPLY || changes.length === 0) return { table, column, would: changes.length, refused };

  await pg.begin(async (tx) => {
    for (const c of changes) {
      await tx`
        INSERT INTO phone_normalisation_backup
          (run_id, table_name, column_name, pk_column, row_id, old_value, new_value)
        VALUES (${RUN_ID}, ${table}, ${column}, ${pk}, ${c.pk}, ${c.old}, ${c.next})`;
      await tx`
        UPDATE ${tx(table)} SET ${tx(column)} = ${c.next}
        WHERE ${tx(pk)}::text = ${c.pk}`;
    }
  });

  notice(`  APPLIED ${changes.length} to ${table}.${column}`);
  return { table, column, applied: changes.length, refused };
}

try {
  if (REVERT) {
    await revert(REVERT);
  } else {
    notice(APPLY ? `APPLY mode — run id ${RUN_ID}` : "DRY RUN — nothing will be written");
    if (APPLY) await ensureBackupTable();

    let total = 0;
    let refusedTotal = 0;
    for (const t of TARGETS) {
      const r = await processColumn(t);
      total += r.applied ?? r.would ?? 0;
      refusedTotal += r.refused ?? 0;
    }

    if (APPLY) {
      notice(`DONE — ${total} values normalised, ${refusedTotal} left alone.`);
      notice(`To undo this run: node scripts/normalize-stored-phones.mjs --revert=${RUN_ID}`);
    } else {
      notice(`DRY RUN — would normalise ${total}, would leave ${refusedTotal} alone.`);
      notice("Re-run with --apply to write. Nothing has been changed.");
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
