
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";
import { lookupSgPostcode } from "../lib/onemap-sg";

export const sgPostcode = new Hono<{ Bindings: Env; Variables: Variables }>();

sgPostcode.use("*", supabaseAuth);

sgPostcode.get("/:code", async (c) => {
  const out = await lookupSgPostcode(
    { email: c.env.ONEMAP_EMAIL, password: c.env.ONEMAP_PASSWORD },
    c.req.param("code") ?? "",
  );
  const status =
    out.error === "invalid_postcode" ? 400 :
    out.error === "auth_failed" || out.error === "lookup_failed" ? 502 :
    200;
  return c.json(out, status);
});

export default sgPostcode;
