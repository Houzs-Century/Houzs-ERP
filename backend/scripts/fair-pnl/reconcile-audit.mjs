// READ-ONLY dump of in-scope PMS projects + pickers, for Excel<->PMS reconciliation.
// Writes NOTHING. One connection, SELECTs only. Prints JSON blocks with markers.
// Scope: projects.start_date in [2024-01-01, 2026-07-01), not archived.
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

async function main() {
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.state, p.organizer, p.start_date, p.end_date,
           p.name, p.status, p.stage, p.created_by,
           et.name AS event_type,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) nlines,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income'   AND l.archived_at IS NULL),0) income,
           COALESCE(SUM(l.amount) FILTER (WHERE l.category ILIKE 'cogs%' AND l.archived_at IS NULL),0) cogs,
           COALESCE(SUM(l.amount) FILTER (WHERE l.category ILIKE 'rental%' AND l.archived_at IS NULL),0) rental,
           (SELECT COUNT(*)::int FROM project_phase_photos ph WHERE ph.project_id = p.id) nphotos,
           (SELECT COUNT(*)::int FROM project_attachments a  WHERE a.project_id  = p.id) nattach
    FROM projects p
    LEFT JOIN project_finance_lines l ON l.project_id = p.id
    LEFT JOIN project_event_types et ON et.id = p.event_type_id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id, et.name
    ORDER BY p.start_date, p.brand`;

  const catlines = await sql`
    SELECT l.project_id AS pid, l.category AS cat, l.kind AS kind,
           COALESCE(SUM(l.amount),0) AS amt, COUNT(*)::int AS n
    FROM project_finance_lines l
    JOIN projects p ON p.id = l.project_id
    WHERE l.archived_at IS NULL AND p.archived_at IS NULL
      AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY l.project_id, l.category, l.kind`;

  const venues = await sql`SELECT name FROM project_venues ORDER BY name`;
  const brands = await sql`SELECT name FROM project_brands ORDER BY name`;
  let organizers = []; try { organizers = await sql`SELECT name FROM project_organizers ORDER BY name`; } catch (e) { organizers = [{ name: `__ERR__ ${e.message}` }]; }
  const etypes = await sql`SELECT name FROM project_event_types ORDER BY name`;

  const dump = projects.map((p) => ({
    id: p.id, brand: p.brand, venue: p.venue, state: p.state, organizer: p.organizer,
    start: p.start_date, end: p.end_date, event_type: p.event_type,
    status: p.status, stage: p.stage, name: p.name, by: p.created_by,
    income: Number(p.income), cogs: Number(p.cogs), rental: Number(p.rental),
    nlines: Number(p.nlines), nphotos: p.nphotos, nattach: p.nattach,
  }));

  const pickers = {
    venues: venues.map((v) => v.name), brands: brands.map((b) => b.name),
    organizers: organizers.map((o) => o.name), event_types: etypes.map((e) => e.name),
  };
  const catdump = catlines.map((r) => ({ pid: r.pid, cat: r.cat, kind: r.kind, amt: Number(r.amt), n: r.n }));
  const payload = Buffer.from(JSON.stringify({ projects: dump, pickers, catlines: catdump })).toString("base64");
  console.log(`PMS_INSCOPE_COUNT=${projects.length}`);
  console.log(`JB_LEN=${payload.length}`);
  for (let i = 0; i < payload.length; i += 180) console.log("JB:" + payload.slice(i, i + 180));
  console.log("JB_DONE");
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
