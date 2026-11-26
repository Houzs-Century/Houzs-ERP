// Sales-report image OCR (owner 2026-11-25): the chat composer uploads a
// photo or screenshot, this returns the transcription, and the composer
// prefills the draft box so the salesperson reviews, edits and sends via the
// ordinary /notes path. No image is persisted here — the note that ends up in
// project_activity carries the text, same as a typed paste.
//
// Lives in its own router so projects.ts stays under its file-size ceiling;
// the service is in ../services/salesReportOcr.
import { Hono } from "hono";
import type { Env } from "../types";
import { requireAnyPermission } from "../middleware/auth";
import { activeCompanyId } from "../scm/lib/companyScope";
import { refuseForeignProject } from "./lib/project-company-gate";
import { readSalesReportImage } from "../services/salesReportOcr";

const app = new Hono<{ Bindings: Env }>();

app.post(
  "/:id/sales-report-image/ocr",
  requireAnyPermission(["projects.write", "projects.chat"]),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
    const user = c.get("user");
    const mime = (c.req.header("content-type") || "").toLowerCase().split(";")[0]!.trim();
    const buf = await c.req.arrayBuffer();
    const result = await readSalesReportImage(c.env, {
      buf,
      mime,
      userId: user?.id ?? null,
      companyId: activeCompanyId(c) ?? null,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ text: result.text });
  },
);

export default app;
