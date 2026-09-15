// Seeds REAL Malaysian State -> City -> Postcode reference rows into
// scm.my_localities so SupplierDetail's StateSelect + the SO delivery-address
// cascade (useLocalities -> GET /api/scm/localities) work. All 13 states + 3
// federal territories, each with a few real city+postcode rows.
//
// REAL data (NOT sample-marked) per the task — this is the canonical MY locality
// reference the cascade needs. Idempotent: skips a row if the exact
// (state_code, city, postcode) triple already exists (no DB unique constraint on
// my_localities, so we check-first rather than ON CONFLICT).
//
//   node scripts/scm-schema/seed-my-localities.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

// [state, stateCode, [ [city, postcode], ... ]]
const DATA = [
  ["Johor", "JHR", [["Johor Bahru", "80000"], ["Johor Bahru", "81100"], ["Batu Pahat", "83000"], ["Muar", "84000"]]],
  ["Kedah", "KDH", [["Alor Setar", "05000"], ["Sungai Petani", "08000"], ["Kulim", "09000"]]],
  ["Kelantan", "KTN", [["Kota Bharu", "15000"], ["Kota Bharu", "16100"], ["Tanah Merah", "17500"]]],
  ["Melaka", "MLK", [["Melaka", "75000"], ["Ayer Keroh", "75450"], ["Alor Gajah", "78000"]]],
  ["Negeri Sembilan", "NSN", [["Seremban", "70000"], ["Port Dickson", "71000"], ["Nilai", "71800"]]],
  ["Pahang", "PHG", [["Kuantan", "25000"], ["Temerloh", "28000"], ["Bentong", "28700"]]],
  ["Penang", "PNG", [["George Town", "10000"], ["Bayan Lepas", "11900"], ["Butterworth", "12000"], ["Bukit Mertajam", "14000"]]],
  ["Perak", "PRK", [["Ipoh", "30000"], ["Ipoh", "31400"], ["Taiping", "34000"], ["Teluk Intan", "36000"]]],
  ["Perlis", "PLS", [["Kangar", "01000"], ["Arau", "02600"]]],
  ["Sabah", "SBH", [["Kota Kinabalu", "88000"], ["Sandakan", "90000"], ["Tawau", "91000"]]],
  ["Sarawak", "SWK", [["Kuching", "93000"], ["Miri", "98000"], ["Sibu", "96000"]]],
  ["Selangor", "SGR", [["Shah Alam", "40000"], ["Petaling Jaya", "46000"], ["Petaling Jaya", "47301"], ["Klang", "41000"], ["Subang Jaya", "47500"], ["Kajang", "43000"]]],
  ["Terengganu", "TRG", [["Kuala Terengganu", "20000"], ["Kemaman", "24000"], ["Dungun", "23000"]]],
  ["W.P. Kuala Lumpur", "KUL", [["Kuala Lumpur", "50000"], ["Cheras", "56000"], ["Setapak", "53000"], ["Bangsar", "59000"]]],
  ["W.P. Putrajaya", "PJY", [["Putrajaya", "62000"], ["Putrajaya", "62100"]]],
  ["W.P. Labuan", "LBN", [["Labuan", "87000"], ["Victoria", "87007"]]],
];

try {
  let inserted = 0;
  let skipped = 0;
  for (const [state, stateCode, cities] of DATA) {
    for (const [city, postcode] of cities) {
      const existing = await sql`
        select 1 from scm.my_localities
        where state_code = ${stateCode} and city = ${city} and postcode = ${postcode}
        limit 1`;
      if (existing.length > 0) { skipped++; continue; }
      await sql`
        INSERT INTO scm.my_localities (postcode, city, state, state_code, country)
        VALUES (${postcode}, ${city}, ${state}, ${stateCode}, 'Malaysia')`;
      inserted++;
    }
  }
  const total = await sql`select count(*)::int c from scm.my_localities`;
  const states = await sql`select count(distinct state)::int c from scm.my_localities`;
  console.log(`DONE — scm.my_localities: +${inserted} inserted, ${skipped} skipped, ${total[0].c} total rows across ${states[0].c} states.`);
} catch (e) {
  console.error("seed failed:", String(e?.message || e).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();
