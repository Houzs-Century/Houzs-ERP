// One-off staging bootstrap: owner login + system showroom. Runs in GitHub
// Actions with STAGING_DATABASE_URL (local machines cannot reach the pooler).
import crypto from "node:crypto";
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const hashPw = (pw) => {
  const s = crypto.randomBytes(16);
  const b = crypto.pbkdf2Sync(pw, s, 100000, 32, "sha256");
  return s.toString("base64") + "$" + b.toString("base64");
};
await sql`select setval(pg_get_serial_sequence('users','id'), greatest((select coalesce(max(id),1) from users),1))`;
const roles = await sql`select id,name from roles order by id`;
const owner = roles.find((r) => /owner|super/i.test(r.name)) ?? roles[0];
const h = hashPw("houzs1234");
const ex = await sql`select id from users where lower(email)='hello@houzscentury.com' limit 1`;
if (ex.length) await sql`update users set password_hash=${h}, role_id=${owner.id}, status='active' where id=${ex[0].id}`;
else await sql`insert into users (email,name,password_hash,role_id,status) values ('hello@houzscentury.com','Lim Wei Siang',${h},${owner.id},'active')`;
await sql`insert into scm.showrooms (id, showroom_code, name, active, sort_order)
  values ('00000000-0000-4000-9000-000000000001','HOUZS-HQ','Houzs Century HQ', true, 0)
  on conflict (id) do nothing`;
console.log("staging account ready (role:", owner.name + ") + showroom seeded");
await sql.end();
