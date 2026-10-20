#!/usr/bin/env node
// check-misparked-orders.mjs — READ-ONLY. Owner 2026-10-20 (先确定): why were
// these orders linked to another fair than the one the evening report names?
// (Project page "OPENED UNDER ANOTHER EVENT": HC-SO-2610-180/181/167 under
// Putrajaya [AKEMI] MALL MGT @ IOI CITY MALL PUTRAJAYA; HC-SO-2610-166 with no
// event.) For each order: the header, how it was made (scan or typed), what the
// slip said, every History row touching venue/fair, the fair it is linked to,
// the report that names it, and the fairs its salesperson stood at around then.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1),
//   DOCS (default the four), REFS (default their booklet numbers).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || 'HC-SO-2610-166,HC-SO-2610-167,HC-SO-2610-180,HC-SO-2610-181').split(',').map((s) => s.trim()).filter(Boolean);
const REFS = String(process.env.REFS || 'HC13317,HC13315,HC13316,HC13548').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const myt = (v) => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '); };
const back = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10); };
const INTERESTING = /venue|fair|project|event|ref|brand|branding|salesperson|source|scan|created|keyed|origin/i;

const fairLine = (p) => `#${p.id} ${p.name} | venue ${p.venue} | org ${p.organizer ?? '—'} | brand ${p.brand ?? '—'} | ${day(p.start_date)}→${day(p.end_date) || day(p.start_date)} | status ${p.status}${p.archived_at ? ' ARCHIVED' : ''} | type ${p.etype ?? '—'} | PIC ${p.pic_name ?? p.pic_id ?? '—'}`;

try {
  const projCols = sql`p.id, p.name, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.status, p.archived_at, p.pic_id,
    (SELECT u.name FROM public.users u WHERE u.id = p.pic_id) AS pic_name,
    (SELECT et.slug FROM public.project_event_types et WHERE et.id = p.event_type_id) AS etype`;
  const attendees = async (ids) => {
    if (ids.length === 0) return new Map();
    const rows = await sql`SELECT a.project_id, sr.name, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id WHERE a.project_id IN ${sql(ids)} ORDER BY sr.name`;
    const m = new Map();
    for (const r of rows) { const k = Number(r.project_id); if (!m.has(k)) m.set(k, []); m.get(k).push(`${r.name}(u${r.user_id ?? '-'})`); }
    return m;
  };

  const sos = await sql`
    SELECT to_jsonb(so) AS j, st.name AS sp_name, st.user_id AS sp_user
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.doc_no IN ${sql(DOCS)} ORDER BY so.doc_no`;

  const bills = await sql`
    SELECT b.ref_token, b.ref_raw, b.amount_sen, b.salesperson_name, b.report_date, b.project_id, b.created_at
      FROM public.project_sales_bills b WHERE b.company_id = ${CO} AND b.ref_token IN ${sql(REFS)} ORDER BY b.ref_token`;
  console.log('== Evening report lines (project_sales_bills)');
  for (const b of bills) console.log(`${b.ref_token} (${b.ref_raw}) RM ${(Number(b.amount_sen) / 100).toFixed(2)} | ${b.salesperson_name} | report ${b.report_date ?? '—'} | project #${b.project_id} | saved ${myt(b.created_at)}`);
  const reportProjects = [...new Set(bills.map((b) => Number(b.project_id)))];

  const linkedIds = [...new Set(sos.map((r) => r.j.project_id).filter((x) => x != null).map(Number))];
  const ids = [...new Set([...reportProjects, ...linkedIds])];
  const projs = ids.length ? await sql`SELECT ${projCols} FROM public.projects p WHERE p.id IN ${sql(ids)}` : [];
  const att = await attendees(ids);
  console.log('\n== Fairs involved (report project + linked project)');
  for (const p of projs) console.log(`${fairLine(p)}\n   Sales Attending: ${(att.get(Number(p.id)) ?? []).join(', ') || '—'}${reportProjects.includes(Number(p.id)) ? '  <- REPORT' : ''}${linkedIds.includes(Number(p.id)) ? '  <- LINKED' : ''}`);

  const venues = await sql`SELECT id, name, active FROM public.project_venues WHERE company_id = ${CO} AND (name ILIKE '%IOI%' OR name ILIKE '%PUTRAJAYA%') ORDER BY name`;
  console.log('\n== Venue master rows with IOI / PUTRAJAYA');
  for (const v of venues) console.log(`#${v.id} ${v.name} active=${v.active}`);

  for (const r of sos) {
    const j = r.j;
    console.log(`\n================ ${j.doc_no}`);
    const keys = Object.keys(j).filter((k) => INTERESTING.test(k)).sort();
    console.log(`so_date ${day(j.so_date)} | status ${j.status} | RM ${(Number(j.local_total_sen ?? 0) / 100).toFixed(2)} | salesperson ${r.sp_name ?? '—'} (user ${r.sp_user ?? '—'})`);
    console.log(keys.map((k) => `${k}=${typeof j[k] === 'object' && j[k] !== null ? JSON.stringify(j[k]).slice(0, 120) : j[k]}`).join(' | '));

    const jobs = await sql`
      SELECT jb.id, jb.created_at, jb.salesperson, jb.houzs_user_id, jb.status,
             (SELECT u.name FROM public.users u WHERE u.id = jb.houzs_user_id) AS keyer,
             s.extracted->>'slipDate' AS slip_date, s.extracted->>'location' AS slip_location,
             coalesce(s.extracted->'locationMatch'->>'value', s.extracted->>'locationMatch') AS slip_match,
             s.extracted->'locationMatch' AS match_raw
        FROM scm.scan_jobs jb LEFT JOIN scm.so_scan_samples s ON s.id = jb.sample_id
       WHERE jb.so_doc_no = ${j.doc_no} ORDER BY jb.created_at`;
    if (jobs.length === 0) console.log('made by: typed (no scan job)');
    for (const jb of jobs) console.log(`made by: SCAN ${myt(jb.created_at)} by ${jb.keyer ?? jb.salesperson ?? '—'} (user ${jb.houzs_user_id ?? '—'}) status ${jb.status} | slip date ${jb.slip_date ?? '—'} | slip place "${jb.slip_location ?? '—'}" → matched ${jb.slip_match ?? '—'} ${jb.match_raw ? JSON.stringify(jb.match_raw).slice(0, 160) : ''}`);

    const audit = await sql`
      SELECT created_at, action, actor_name_snapshot, source, note, field_changes
        FROM scm.mfg_so_audit_log WHERE so_doc_no = ${j.doc_no} ORDER BY created_at`;
    console.log(`History (${audit.length} rows; venue/fair/project fields only):`);
    for (const a of audit) {
      const fc = Array.isArray(a.field_changes) ? a.field_changes : [];
      const hit = fc.filter((f) => /venue|fair|project|event/i.test(String(f?.field ?? f?.key ?? f?.name ?? JSON.stringify(f))));
      if (a.action === 'CREATE' || hit.length || /fair|venue/i.test(String(a.note ?? '')) || /FAIR/i.test(String(a.action))) {
        console.log(`  ${myt(a.created_at)} ${a.action} by ${a.actor_name_snapshot ?? '—'} [${a.source}] ${a.note ? `note: ${String(a.note).slice(0, 200)} ` : ''}${hit.length ? JSON.stringify(hit).slice(0, 400) : (a.action === 'CREATE' ? JSON.stringify(fc).slice(0, 300) : '')}`);
      }
    }

    // What the salesperson stood at in the 28 days to the order date (PIC or Sales Attending).
    const sd = day(j.so_date);
    if (r.sp_user != null && sd) {
      const own = await sql`
        SELECT ${projCols} FROM public.projects p
         WHERE p.company_id = ${CO} AND p.start_date IS NOT NULL AND p.start_date <= ${sd}
           AND coalesce(p.end_date, p.start_date) >= ${back(sd, 28)}
           AND (p.pic_id = ${r.sp_user} OR EXISTS (SELECT 1 FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id WHERE a.project_id = p.id AND sr.user_id = ${r.sp_user}))
         ORDER BY p.start_date DESC`;
      console.log(`Salesperson's fairs in the 28 days to ${sd} (PIC / Sales Attending): ${own.length}`);
      for (const p of own) console.log(`  ${fairLine(p)}`);
    }

    // Every live fair at an IOI / Putrajaya venue overlapping the picker window for this order date.
    if (sd) {
      const atIoi = await sql`
        SELECT ${projCols} FROM public.projects p
         WHERE p.company_id = ${CO} AND p.start_date IS NOT NULL AND p.start_date <= ${sd}
           AND coalesce(p.end_date, p.start_date) >= ${back(sd, 28)}
           AND (p.venue ILIKE '%IOI%' OR p.venue ILIKE '%PUTRAJAYA%')
         ORDER BY p.start_date DESC, p.brand`;
      console.log(`Fairs at IOI/Putrajaya venues in the picker window to ${sd}: ${atIoi.length}`);
      for (const p of atIoi) console.log(`  ${fairLine(p)}`);
    }
  }
} finally {
  await sql.end();
}
