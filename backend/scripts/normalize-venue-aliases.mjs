#!/usr/bin/env node
// Normalize the AutoCount-era venue aliases on imported company-1 orders to the
// project_venues master names (owner 2026-08-10: 归并 approved list; AEON ALMA
// = AEON BUKIT MERTAJAM 同一个; BUTTERWORTH ARENA + ZANOTTI LIVING (KELANA
// JAYA) get NEW venue rows). After this every imported order's venue resolves
// in the Edit dropdown. Rule order: exact alias dict → strip trailing " SOLO"
// then exact master match → report anything left.
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. A venue that already reads its canonical name is skipped, and only missing venues are created.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

const NEW_VENUES = ["BUTTERWORTH ARENA", "ZANOTTI LIVING (KELANA JAYA)"];

const ALIASES = {
  "AEON ALMA SOLO": "AEON BUKIT MERTAJAM",
  "AEON KOTA BHARU KELANTAN": "AEON KOTA BHARU",
  "AEON MALL STATION 18 IPOH": "AEON STATION 18",
  "AEON PERMAS SOLO": "AEON PERMAS JAYA",
  "AEON TERBAU CITY SOLO": "AEON TEBRAU CITY",
  "AICC AUSTIN JB": "AUSTIN INTERNATIONAL CONVENTION CENTRE",
  "AMANJAYA MALL SP SOLO": "AMANJAYA MALL SUNGAI PETANI",
  "AUTO CITY CONCEPT HALL": "AUTO CITY",
  "BLOOMSVALE MALL SOLO": "BLOOMSVALE",
  "BUKIT JALIL STADIUM": "STADIUM BUKIT JALIL",
  "CENTRE POINT SABAH SOLO": "CENTRE POINT",
  "DATARAN CENTRIO SEREMBAN": "DATARAN CENTRIO",
  "DATARAN PAHLAWAN MELAKA SOLO": "DATARAN PAHLAWAN MELAKA MEGAMALL",
  "DUNLOPILLO SUITE SUNWAY CARNIVAL": "SUNWAY CARNIVAL",
  "EKO CHERAS SOLO": "EKO CHERAS MALL",
  "IOI DAMANSARA": "IOI MALL DAMANSARA",
  "IOI KULAI JOHOR SOLO": "IOI MALL KULAI",
  "IOI PUTRAJAYA": "IOI MALL PUTRAJAYA",
  "ITCC SABAH SOLO": "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE",
  "JB PERSADA": "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE",
  "KB MALL KELANTAN SOLO": "KB MALL",
  "KL BASE EXHIBITION CENTRE": "KL BASE EXHIBITION CENTER",
  "KSL CITY MALL JOHOR SOLO": "KSL CITY MALL",
  "MAHKOTA PARADE MELAKA SOLO": "MAHKOTA PARADE",
  "METROCITY PARK KUCHING": "KUCHING METROCITY CONVENTION CENTRE",
  "MIDVALLEY EXHIBITION CENTRE": "MID VALLEY",
  "MIDVALLEY SOUTHKEY JB": "MVEC SOUTHKEY",
  "MITC MELAKA": "MELAKA INTERNATIONAL TRADE CENTRE",
  "MITEC": "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE",
  "MITEC KL": "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE",
  "MLE KUCHING METROCITY CONVENTION CENTRE": "KUCHING METROCITY CONVENTION CENTRE",
  "NU EMPIRE SOLO": "NU EMPIRE SUBANG",
  "PALM MALL SEREMBAN SOLO": "PALM MALL",
  "PAVILLION BUKIT JALIL": "PAVILION BUKIT JALIL",
  "PERSADA JB": "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE",
  "PISA SPICE ARENA": "PISA SPICE ARENA CONVENTION CENTRE",
  "PWTC": "WORLD TRADE CENTRE KUALA LUMPUR",
  "SABAH AKEMI MEGAHOME SICC": "SABAH INTERNATIONAL CONVENTION CENTRE",
  "SABAH CONVENTION CENTRE": "SABAH INTERNATIONAL CONVENTION CENTRE",
  "SCCC": "SETIA CITY CONVENTION CENTRE",
  "SCCC SHAH ALAM": "SETIA CITY CONVENTION CENTRE",
  "SEREMBAN 2": "AEON SEREMBAN 2",
  "SP ARENA": "PISA SPICE ARENA CONVENTION CENTRE",
  "SPICE ARENA": "PISA SPICE ARENA CONVENTION CENTRE",
  "STADIUM INDERA MULIA IPOH": "STADIUM INDERA MULIA",
  "STRAIT QUAY SOLO": "STRAITS QUAY",
  "SULTAN AHMAD SHAH CONVENTION CENTRE SASICC": "SULTAN AHMAD SHAH CONVENTION CENTRE",
  "SUNSHINE PENANG SOLO": "SUNSHINE CENTRAL",
  "SUNWAY PYRAMID SOLO": "SUNWAY PYRAMID CONVENTION CENTRE",
  "SUTRA JOHOR SOLO": "SUTERA SQUARE",
  "SUTRA SQUARE JOHOR": "SUTERA SQUARE",
  "THE STARLING": "THE STARLING MALL",
  "VIVACITY KUCHING SOLO": "VIVACITY MEGAMALL",
  "ZANOTTI LIVING(KELANA JAYA)": "ZANOTTI LIVING (KELANA JAYA)",
  "ZANOTTI LIVING (KELANA JAYA)": "ZANOTTI LIVING (KELANA JAYA)",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const venues = await sql`SELECT id, name, active FROM public.project_venues`;
  const vByName = new Map(venues.map((v) => [norm(v.name), v]));
  const missingNew = NEW_VENUES.filter((n) => !vByName.has(norm(n)));
  log(`master venues: ${venues.length}; new venues to create: ${missingNew.join(", ") || "none"}`);

  const rows = await sql`SELECT venue, COUNT(*) n FROM scm.mfg_sales_orders
    WHERE company_id = 1 AND linked_ac_docno IS NOT NULL AND venue IS NOT NULL AND venue <> ''
    GROUP BY venue`;
  const plan = []; const leftover = [];
  for (const r of rows) {
    const v = norm(r.venue);
    if (vByName.has(v)) continue; // already canonical
    let target = ALIASES[v] ?? null;
    if (!target) {
      const stripped = v.replace(/\s*SOLO\s*$/, "").trim();
      if (vByName.has(stripped)) target = vByName.get(stripped).name;
    }
    if (!target && NEW_VENUES.some((n) => norm(n) === v)) target = NEW_VENUES.find((n) => norm(n) === v);
    if (target) plan.push({ from: r.venue, to: target, n: Number(r.n) });
    else leftover.push(`${r.venue} (${r.n})`);
  }
  const total = plan.reduce((s, p) => s + p.n, 0);
  log(`alias values to normalize: ${plan.length} (${total} orders); leftover unmapped: ${leftover.length}${leftover.length ? ` -> ${leftover.join("; ")}` : ""}`);
  for (const p of plan) log(`   "${p.from}" -> "${p.to}" (${p.n})`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (const n of missingNew) {
    await sql`INSERT INTO public.project_venues (name, active) VALUES (${n}, 1)`;
    log(`  created venue "${n}"`);
  }
  let orders = 0;
  for (const p of plan) {
    const r = await sql`UPDATE scm.mfg_sales_orders SET venue = ${p.to}
      WHERE company_id = 1 AND linked_ac_docno IS NOT NULL AND venue = ${p.from}`;
    orders += r.count;
  }
  log(`DONE. venues created ${missingNew.length}; orders normalized ${orders}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
