import { Hono } from "hono";
import type { Env } from "../types";


const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  const all = (c.get("companies") as { id: number }[] | undefined) ?? [];
  const allowed = c.get("allowedCompanyIds") as number[] | undefined;
  const companies = allowed ? all.filter((co) => allowed.includes(co.id)) : all;
  return c.json({
    companies,
    activeCompanyId: c.get("companyId") ?? null,
    activeCompanyCode: c.get("companyCode") ?? null,
  });
});

export default app;
