import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermissionOrSalesView } from "../middleware/auth";

/**
 * Retained headless after the strip-to-core cutover ONLY for the Projects
 * Setup/Dismantle + Logistics crew pickers, which call GET /api/fleet/staff.
 * The rest of the Fleet module (clock, salary, inspections, lorry maintenance/
 * incidents, compliance) was deleted — do not re-add it here.
 */
const app = new Hono<{ Bindings: Env }>();

// List drivers / helpers / storekeepers for the Projects crew dropdowns.
// Read gate is ADDITIVE (owner 2026-07): users.read OR a code-keyed
// Sales/director. The PMS project "Setup & Dismantle" crew editor is READ-ONLY
// for Sales but must SHOW the scheduled driver/helper names — a Sales Director's
// position holds no users.read, so this list used to 403 and blank the
// dropdowns. View-only; no write route is opened.
//
// Because that gate is WIDE, the payload stays narrow: only what the crew
// pickers actually render. Compensation (base_salary / trip_allowance_rate /
// ot_rate) and ic_number are NEVER served here — widening a gate for a dropdown
// is not a reason to hand every Sales rep the payroll.
app.get("/staff", requirePermissionOrSalesView("users.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.phone, u.company_phone, u.user_type,
            r.name as role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.name IN ('Driver','Helper','Storekeeper')
        AND u.status IN ('active','invited')
      ORDER BY r.name, u.name`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

export default app;
