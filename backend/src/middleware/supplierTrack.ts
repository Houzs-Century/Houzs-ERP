/**
 * Supplier portal auth — proposal §6.3.
 *
 * Mirrors customer portal's caseTrack middleware (middleware/caseTrack.ts)
 * but reads from the supplier-token table. A valid bearer token
 * resolves to exactly one case (and one supplier creditor), which the
 * downstream routes read via c.get("supplierScope").
 */
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
