// THROWAWAY (delete after UP-0). Staging-only: verify rebuilt schema + seed a
// known-password admin so the baseline app can be login-tested on staging.
// Hard guard: refuses to touch anything but the staging project.
import { pbkdf2Sync, randomBytes } from "node:crypto";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url || !url.includes("minnapsemfzjmtvnnvdd") || url.includes("anogrigyjbduyzclzjgn")) {
  console.error("REFUSE: DATABASE_URL is not the staging project. url=", url);
  process.exit(1);
}
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

// 1) schema sanity
const tables = (await sql`select count(*)::int n from information_schema.tables where table_schema='public'`)[0].n;
const totp = (await sql`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='users' and column_name='totp_enabled'`)[0].n;
const scm = (await sql`select string_agg(table_name, ', ') s from information_schema.tables where table_schema='public' and table_name like 'scm_%'`)[0].s;
console.log(`SCHEMA: public_tables=${tables}  totp_col=${totp ? "yes" : "NO"}  scm=[${scm || ""}]`);

// 2) discover the password column name
const passCols = (await sql`select column_name from information_schema.columns where table_schema='public' and table_name='users' and column_name ilike '%pass%'`).map((r) => r.column_name);
const passCol = passCols.includes("password_hash") ? "password_hash" : passCols[0];
console.log(`password column: ${passCol}  (candidates: ${passCols.join(", ")})`);
if (!passCol) { console.error("no password column on users — abort"); process.exit(1); }

// 3) find a full-access (wildcard) role
const wild = await sql`select id, name from roles where permissions like '%*%' order by id limit 1`;
console.log(`wildcard role: ${JSON.stringify(wild)}`);

// 4) choose the admin user to seed: prefer an existing wildcard-role user
let target = null;
if (wild.length) {
  const u = await sql`select id, email from users where role_id = ${wild[0].id} and email is not null order by id limit 1`;
  if (u.length) target = { id: u[0].id, email: u[0].email, role_id: wild[0].id };
}
if (!target) {
  const u = await sql`select id, email from users where email is not null order by id limit 1`;
  if (!u.length) { console.error("no users in staging — abort"); process.exit(1); }
  target = { id: u[0].id, email: u[0].email, role_id: wild.length ? wild[0].id : null };
}

// 5) seed: known password + active + (wildcard role) + totp off
const password = "houzs1234";
const salt = randomBytes(16);
const stored = salt.toString("base64") + "$" + pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64");

await sql.unsafe(`update users set ${passCol} = $1, status = 'active' where id = $2`, [stored, target.id]);
if (target.role_id) await sql`update users set role_id = ${target.role_id} where id = ${target.id}`;
if (totp) {
  try { await sql`update users set totp_enabled = false where id = ${target.id}`; }
  catch { try { await sql`update users set totp_enabled = 0 where id = ${target.id}`; } catch (e) { console.log("totp disable skipped:", e.message.slice(0, 50)); } }
}

console.log(`\nSEEDED STAGING ADMIN:\n  email    = ${target.email}\n  password = ${password}\n  user_id  = ${target.id}  role_id = ${target.role_id}`);
await sql.end();
