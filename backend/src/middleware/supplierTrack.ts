import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { resolveSupplierToken, type SupplierPortalScope } from "../services/supplierPortal";

declare module "hono" {
  interface ContextVariableMap {
    supplierScope: SupplierPortalScope;
  }
}

export const supplierTrack: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "This link is no longer valid. Please request a new one." }, 401);

  const scope = await resolveSupplierToken(c.env, token);
  if (!scope) return c.json({ error: "This link is no longer valid. Please request a new one." }, 401);

  c.set("supplierScope", scope);
  await next();
};
