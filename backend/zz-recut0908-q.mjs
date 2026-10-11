/* recut0908-q — READ-ONLY prod query helper. DSN read from file, never printed.
   Usage: node recut0908-q.mjs "<sql>"   (or SQL_FILE=<path>) */
import fs from "node:fs";
import postgres from "postgres";
const dsnFile = process.env.DSN_FILE || "C:/Users/User/Desktop/.db-align/connection.txt";
const raw = fs.readFileSync(dsnFile, "utf8");
const m = raw.match(/postgres(?:ql)?:\/\/\S+/);
if (!m) { console.error("no DSN found in " + dsnFile); process.exit(2); }
const DSN = m[0].trim();
const scrub = (t) => String(t).split(DSN).join("<dsn>");
const q = process.argv[2] || (process.env.SQL_FILE ? fs.readFileSync(process.env.SQL_FILE, "utf8") : "");
if (!q) { console.error("no sql"); process.exit(2); }
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  await sql.unsafe("SET default_transaction_read_only = on");
  const rows = await sql.unsafe(q);
  console.log(JSON.stringify(rows, null, 1));
} catch (e) {
  console.error("QUERY FAILED: " + scrub(e.message || String(e)).slice(0, 600));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 5 }); }
