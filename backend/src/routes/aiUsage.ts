import { Hono } from "hono";
import type { Env } from "../types";
import { requireItPages } from "../middleware/auth";
import { loadAiUsageReport } from "../services/aiUsage";

// GET /api/admin/ai-usage?months=6 — monthly Anthropic spend for the IT AI Usage
// page: total RM, per feature and per company, oldest month first. Months before
// recording started are back-filled from agent_runs and marked partial.
const app = new Hono<{ Bindings: Env }>();
app.use("*", requireItPages());

// company-scope: IT-wide report across every company by design (DEV-35); the
// IT pages gate above is the boundary, and per-company spend is the output.
app.get("/", async (c) => {
  const n = Number(c.req.query("months") ?? 6);
  const months = Number.isInteger(n) ? Math.min(24, Math.max(1, n)) : 6;
  try {
    return c.json(await loadAiUsageReport(c.env, months, new Date()));
  } catch (e) {
    console.error("[ai-usage] report failed:", e);
    return c.json({ error: e instanceof Error ? e.message : "AI usage report failed" }, 500);
  }
});

export default app;
