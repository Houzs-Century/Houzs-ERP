import { Hono } from "hono";
import type { Env } from "../types";
import { requireItPages } from "../middleware/auth";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { mytMonth } from "../services/agent-console";
import { loadOcrReport } from "../services/ocrStats";

// GET /api/admin/ocr?month=YYYY-MM — how well the AI read scanned documents in
// one month (MYT), for the active company. IT pages only. Read-only.
const app = new Hono<{ Bindings: Env }>();
app.use("*", requireItPages());

app.get("/", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const q = c.req.query("month");
  const month = q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : mytMonth(new Date());
  try {
    return c.json(await loadOcrReport(c.env, co.companyId, month));
  } catch (e) {
    console.error("[ocr-dashboard] report failed:", e);
    return c.json({ error: e instanceof Error ? e.message : "OCR report failed" }, 500);
  }
});

export default app;
