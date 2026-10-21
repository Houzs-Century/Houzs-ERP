// One-off read-only probe: why can a named person not log in on the 2990 POS?
// Reports the POS cashier rows matching NAME, which events they are assigned
// to, each terminal's event and last Prepare time (a cashier added or edited
// after the device's last Prepare is not on the device), and any ERP user with
// that name plus their recent failed sign-ins. SELECTs only; exits 0 for every
// answer. Drop this file before merge.
import postgres from "postgres";

const name = (process.env.NAME ?? "james").trim();
const company = (process.env.COMPANY ?? "2990").trim();
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const mask = (e) => (e ? e.replace(/^(.).*(@.*)$/, "$1***$2") : null);
const like = `%${name}%`;

try {
  const [co] = await sql`SELECT id, code, name FROM public.companies WHERE code = ${company}`;
  console.log("company", co);
  const cid = co.id;

  const cashiers = await sql`
    SELECT id, code, name, role, active, length(pin_hash) AS pin_len, position('$' in pin_hash) > 0 AS pin_shape_ok,
           last_login_at, created_at, updated_at
      FROM pos_cashiers WHERE company_id = ${cid} AND (name ILIKE ${like} OR code ILIKE ${like})`;
  console.log("cashiers matching", cashiers);
  const allCashiers = await sql`SELECT id, code, name, active FROM pos_cashiers WHERE company_id = ${cid} ORDER BY code`;
  console.log("all cashiers (count)", allCashiers.length, allCashiers.map((c) => `${c.code}/${c.name}/${c.active ? "on" : "OFF"}`).join(", "));

  const links = await sql`
    SELECT l.id AS link_id, l.project_id, p.code, p.name, p.start_date, p.end_date, l.updated_at,
           (SELECT count(*) FROM pos_event_cashiers ec WHERE ec.link_id = l.id) AS assigned_n,
           (SELECT json_agg(c.name ORDER BY c.code) FROM pos_event_cashiers ec JOIN pos_cashiers c ON c.id = ec.cashier_id WHERE ec.link_id = l.id) AS assigned
      FROM pos_event_links l JOIN projects p ON p.id = l.project_id AND p.company_id = l.company_id
     WHERE l.company_id = ${cid} ORDER BY p.start_date DESC NULLS LAST`;
  console.log("events", JSON.stringify(links, null, 1));

  const terms = await sql`
    SELECT id, code, device_name, project_id, status, active, prepared_at, last_seen_at, last_sync_at, app_version
      FROM pos_terminals WHERE company_id = ${cid} ORDER BY id`;
  console.log("terminals", terms);

  const users = await sql`
    SELECT u.id, u.name, u.email, u.status, u.last_login_at, r.name AS role,
           (SELECT json_agg(c.code) FROM public.user_companies uc JOIN public.companies c ON c.id = uc.company_id WHERE uc.user_id = u.id) AS companies
      FROM public.users u LEFT JOIN public.roles r ON r.id = u.role_id
     WHERE u.name ILIKE ${like} OR u.email ILIKE ${like}`;
  console.log("erp users matching", users.map((u) => ({ ...u, email: mask(u.email) })));
  for (const u of users) {
    const fails = await sql`
      SELECT created_at, reason FROM auth_failed_logins
       WHERE user_id = ${u.id} OR lower(email) = lower(${u.email}) ORDER BY created_at DESC LIMIT 15`;
    console.log(`failed logins user ${u.id}`, fails);
    const invs = await sql`
      SELECT id, created_at, expires_at, accepted_at
        FROM invitations WHERE lower(email) = lower(${u.email}) ORDER BY id DESC LIMIT 5`;
    console.log(`invitations user ${u.id}`, invs);
  }
  // 2990 POS (pos.2990shome.com) = name picker + 6-digit PIN, routes/pos.ts.
  for (const u of users) {
    const st = await sql`
      SELECT s.id, s.staff_code, s.name, s.active, s.user_id, pn.slug AS position_slug,
             (p.staff_id IS NOT NULL) AS has_pin, p.updated_at AS pin_updated
        FROM scm.staff s
        LEFT JOIN public.users u ON u.id = s.user_id
        LEFT JOIN public.positions pn ON pn.id = u.position_id
        LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
       WHERE s.user_id = ${u.id} OR s.name ILIKE ${like}`;
    console.log(`staff/pin for user ${u.id}`, st);
    for (const s2 of st) {
      const att = await sql`SELECT * FROM scm.pos_pin_attempts WHERE staff_id = ${s2.id}`.catch((e) => e.message);
      console.log(`pin attempts staff ${s2.id}`, att);
    }
  }
  const picker = await sql`
    SELECT s.name, (p.staff_id IS NOT NULL) AS has_pin
      FROM scm.staff s
      JOIN public.user_companies uc ON uc.user_id = s.user_id AND uc.company_id = ${cid}
      LEFT JOIN public.users u ON u.id = s.user_id
      LEFT JOIN public.positions pn ON pn.id = u.position_id
      LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
     WHERE s.active = true AND s.user_id IS NOT NULL AND pn.slug LIKE 'sales%'
     ORDER BY s.name`;
  console.log("2990 POS picker", picker.length, picker.map((r) => `${r.name}${r.has_pin ? "" : "(NO PIN)"}`).join(", "));
  const anon = await sql`
    SELECT created_at, reason, email FROM auth_failed_logins
     WHERE email ILIKE ${like} AND created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT 15`;
  console.log("failed logins by typed email", anon.map((f) => ({ ...f, email: mask(f.email) })));
} catch (e) {
  console.error("probe error", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
