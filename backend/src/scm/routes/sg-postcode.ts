// ----------------------------------------------------------------------------
// sg-postcode — live Singapore 6-digit postcode -> address via OneMap.
//
// GET /sg-postcode/:code — resolve a real SG postcode. Thin wrapper over
// lookupSgPostcode (scm/lib/onemap-sg.ts, which holds the testable logic).
//
// INERT until configured: with no ONEMAP_EMAIL / ONEMAP_PASSWORD Worker secret
// it returns { configured: false } and the SG address forms keep the seeded
// 55-area picker (mig 0181). Shared reference lookup, not company-scoped — a
// postcode resolves the same for every caller — so it sits with the other
// shared-read helpers (staff / localities / fabric-colours) in index.ts.
// ----------------------------------------------------------------------------

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
