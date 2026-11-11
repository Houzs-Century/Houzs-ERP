#!/usr/bin/env node
// check-quote-areas.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11: 「他的地区和我的地区算是align 的？」 — BRIGHTSUN's price areas in its
// 30/3/2026 transport quotation (groups of towns per warehouse) against the system's
// own places: the localities master (scm.my_localities, Geo & Warehouses: state →
// city → postcode) and each state's delivery region. Prints place names and counts.
// Env: DATABASE_URL.
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/* BRIGHTSUN, AKEMI TRANSPORT DELIVERY quotation dated 30 March 2026, its areas as printed. */
const AREAS = [
  ['Kuching city', ['KUCHING', 'PETRA JAYA', 'BAKO', 'DEMAK LAUT', 'SEMARIANG', 'STAMPIN', 'SATOK', 'TABUAN', 'BINTAWA']],
  ['Kuching zone 3', ['PADAWAN', 'SENTOSA', 'SIBURAN', 'SERIAN', 'BATU KAWAH', 'BATU KITANG', 'KOTA SAMARAHAN']],
  ['Kuching zone 4', ['BAU', 'SINIAWAN', 'BIAWAK', 'SERIKIN', 'SERIAN']],
  ['Kuching zone 5', ['LUNDU', 'SEMATAN']],
  ['Kuching zone 6', ['SRI AMAN', 'TEBEDU']],
  ['Miri city', ['MIRI', 'LUTONG', 'PERMY', 'PIASAU', 'SENADIN', 'PUJUT', 'CANADA HILL', 'KUALA BARAM']],
  ['Miri zone 2', ['MARUDI', 'SUBIS']],
  ['Miri zone 3', ['BELURU', 'BEKENU', 'SIBUTI']],
  ['Miri zone 4', ['NIAH', 'NIAH SUAI']],
  ['Miri zone 5', ['BINTULU', 'TATAU']],
  ['KK city', ['KOTA KINABALU', 'PUTATAN']],
  ['KK zone 2', ['TUARAN', 'KINARUT', 'TAMPARULI', 'PAPAR']],
  ['KK zone 3', ['BEAUFORT', 'BONGAWAN', 'TAMBUNAN', 'KENINGAU', 'KIMANIS', 'SIPITANG', 'MEMBAKUT', 'MENUMBOK', 'KUALA PENYU', 'RANAU', 'KOTA BELUD', 'KOTA MARUDU']],
  ['KK zone 4', ['KUDAT', 'TELUPID', 'TONGOD', 'NABAWAN', 'SOOK', 'TENOM']],
  ['KK zone 5', ['SANDAKAN', 'LAHAD DATU', 'KUNAK', 'TAWAU', 'LABUAN']],
  ['KK zone 6', ['LAWAS', 'LIMBANG', 'BRUNEI']],
];

try {
  await sql.begin('read only', async (tx) => {
    const loc = await tx`SELECT DISTINCT upper(state) AS state, upper(city) AS city FROM scm.my_localities WHERE city IS NOT NULL`;
    const stateOf = new Map();
    for (const l of loc) { const c = norm(l.city); if (!stateOf.has(c)) stateOf.set(c, new Set()); stateOf.get(c).add(norm(l.state)); }
    const east = ['SARAWAK', 'SABAH', 'LABUAN', 'WILAYAH PERSEKUTUAN LABUAN'];
    const eastCities = [...stateOf].filter(([, s]) => [...s].some((x) => east.includes(x))).map(([c]) => c);
    row('SYSTEM', `East Malaysia cities ${eastCities.length}`, `by state ${east.map((s) => `${s} ${[...stateOf].filter(([, ss]) => ss.has(s)).length}`).join(', ')}`);

    const covered = new Set();
    for (const [name, towns] of AREAS) {
      const inSys = towns.filter((t) => stateOf.has(t));
      const missing = towns.filter((t) => !stateOf.has(t));
      inSys.forEach((t) => covered.add(t));
      row('AREA', name, `towns ${towns.length}`, `system cities ${inSys.length}: ${inSys.join(', ') || '—'}`, `not system cities ${missing.length}: ${missing.join(', ') || '—'}`,
        `states ${[...new Set(inSys.flatMap((t) => [...stateOf.get(t)]))].join(', ') || '—'}`);
    }
    const inTwo = AREAS.flatMap(([, t]) => t).filter((t, i, all) => all.indexOf(t) !== i);
    row('IN_TWO_AREAS', inTwo.join(', ') || '—');
    const uncovered = eastCities.filter((c) => !covered.has(c)).sort();
    row('SYSTEM_CITIES_NO_AREA', `count ${uncovered.length}`, uncovered.join(', '));
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
