// Read-only probe: does the fabric library actually contain the colour codes
// the sofa SO import could not resolve? (owner 2026-08-10: "BOOBOO315-31、
// grafield1-softlinen、ZL-6 Lether 这个没有?") Prints, for each queried name,
// the exact/typo-folded hit or the nearest library entries, so the answer is
// evidence rather than assumption. Read-only — no writes anywhere.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const strip = (s) => norm(s).replace(/[^A-Z0-9]/g, "");
const fold = (x) => strip(x).replace(/([A-Z])\1+/g, "$1").replace(/O/g, "0");

const QUERY = (process.env.NAMES || [
  "BOOBOO315-31", "grafield1-softlinen", "ZL-6 Lether", "ZL-20 BLACK",
  "J9883-2-Chic", "J9226-2-buttercream", "M2402-8", "Wowsons-8877-3 Hazelnut",
  "CHANTIC 141-2", "NX007", "NX010 Ivory", "NX011-Beige", "GD2502#04-OAK",
  "GD2502#18-Grey", "GD 2502#09- sandy", "HR805-40", "HR805-31", "KN390-2",
  "Mordenza 06", "Modenza 06", "Modenza 02 Barley", "modenza 01- Houston cream",
  "B0315-2 feather", "B0315-23 Beige", "BOO315-11", "BOO315-25", "BO315-4",
].join("|")).split("|");

const rows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
note(`fabric_colours rows: ${rows.length}`);
const exact = new Map(), folded = new Map(), dup = new Set();
for (const r of rows) {
  for (const k of [norm(r.colour_id), norm(r.label), strip(r.colour_id), strip(r.label)]) if (k && !exact.has(k)) exact.set(k, r);
  for (const k of [fold(r.colour_id), fold(r.label)]) { if (!k) continue; if (folded.has(k) && folded.get(k) !== r) dup.add(k); else folded.set(k, r); }
}
for (const k of dup) folded.delete(k);
note(`ambiguous folds dropped: ${dup.size}`);

for (const q of QUERY) {
  const e = exact.get(norm(q)) || exact.get(strip(q));
  if (e) { note(`EXACT   ${q}  ->  ${e.fabric_id} / ${e.colour_id} (${e.label})`); continue; }
  const f = folded.get(fold(q));
  if (f) { note(`TYPO-OK ${q}  ->  ${f.fabric_id} / ${f.colour_id} (${f.label})`); continue; }
  const fq = fold(q);
  let pre = null;
  for (let n = Math.min(fq.length, 14); n >= 6 && !pre; n--) pre = folded.get(fq.slice(0, n));
  if (pre) { note(`PREFIX  ${q}  ->  ${pre.fabric_id} / ${pre.colour_id} (${pre.label})`); continue; }
  // nearest neighbours by shared prefix, for the owner to eyeball
  const near = rows
    .map((r) => ({ r, k: fold(r.colour_id) }))
    .filter((x) => x.k && (x.k.startsWith(fq.slice(0, 4)) || fq.startsWith(x.k.slice(0, 4))))
    .slice(0, 4)
    .map((x) => `${x.r.colour_id}(${x.r.label})`);
  note(`MISSING ${q}  ->  库里没有;最接近: ${near.length ? near.join(", ") : "(无同系列)"}`);
}
await sql.end({ timeout: 5 });
