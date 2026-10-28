import { describe, expect, test } from "vitest";
import { app } from "../src/index";
import { auth, PUBLIC_API_PREFIXES } from "../src/middleware/auth";

/* The unauthenticated surfaces (/api/track, /api/portal, /api/supplier-portal,
   /api/survey) are protected by nothing but their token. Which paths are public
   is decided in TWO places that nothing forced to agree:

     1. index.ts mount ORDER — anything mounted above `app.use("/api/*", auth)`
        never reaches the gate. This is the real mechanism.
     2. middleware/auth.ts PUBLIC_API_PREFIXES — consulted only when a request
        DOES reach the gate.

   The two are allowed to differ (see the comment on PUBLIC_API_PREFIXES: the
   secret-guarded machine surfaces are pre-auth by order and deliberately absent
   from the list). Only one direction of divergence is dangerous, and it is the
   one that fails OPEN:

     an entry in PUBLIC_API_PREFIXES that no pre-auth router serves is a
     standing grant waiting for someone to mount a route there.

   "/api/supplier-auth" and "/api/supplier" sat in that list for months matching
   no mounted router — a future /api/supplier/* route mounted in the ordinary
   place (below the gate) would have been served to the internet unauthenticated,
   and nothing would have failed. These tests are what "nothing forced them to
   agree" is replaced with. The opposite divergence — public by mount order but
   not listed — fails CLOSED (/api/assr-form-intake 401'd every call until it was
   moved above the gate; its mount comment in index.ts records it) and is not an
   error here. */

/** Registration index of the /api/* auth gate — the mount-order watershed. */
function gateIndex(): number {
  const i = app.routes.findIndex((r) => r.handler === auth);
  // If this ever returns -1 the gate was renamed, re-wrapped or removed, and
  // every "is it mounted above the gate" claim below would silently pass
  // against a watershed that does not exist.
  expect(i, "app.use('/api/*', auth) not found in app.routes").toBeGreaterThan(-1);
  return i;
}

const isUnder = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + "/");

describe("PUBLIC_API_PREFIXES vs the pre-auth mounts in index.ts", () => {
  test("every entry is backed by a router mounted ABOVE the auth gate", () => {
    const gate = gateIndex();
    const preAuth = app.routes.slice(0, gate);

    for (const prefix of PUBLIC_API_PREFIXES) {
      const backing = preAuth.filter((r) => isUnder(r.path, prefix));
      expect(
        backing.length,
        `PUBLIC_API_PREFIXES has "${prefix}" but no router is mounted under it ` +
          `above the auth gate. Either the entry is dead (delete it — a future ` +
          `route mounted there would be silently public), or the router is ` +
          `mounted BELOW the gate and is only public because this list says so, ` +
          `which is the accident this test exists to prevent.`,
      ).toBeGreaterThan(0);
    }
  });

  test("no entry is a prefix of a DIFFERENT surface it does not mean to grant", () => {
    // The gate matches on `path === p || path.startsWith(p + "/")`, so
    // "/api/supplier" would NOT have granted "/api/supplier-portal" — but
    // "/api/portal" WOULD grant a future "/api/portal-admin/..." if someone
    // mounted it below the gate expecting staff auth. Pin that every entry is a
    // real mount point rather than a string that happens to lead somewhere.
    const gate = gateIndex();
    const preAuth = app.routes.slice(0, gate);

    for (const prefix of PUBLIC_API_PREFIXES) {
      const exact = preAuth.some((r) => r.path === prefix || r.path === prefix + "/*");
      const nested = preAuth.some((r) => r.path.startsWith(prefix + "/"));
      expect(
        exact || nested,
        `"${prefix}" grants access but matches no mount point exactly — it is ` +
          `only a string prefix of something else.`,
      ).toBe(true);
    }
  });

  test("the retired entries stay retired", () => {
    // Named, not just implied by the test above, so a re-add is rejected with
    // the reason rather than a generic "no router mounted" failure.
    expect(PUBLIC_API_PREFIXES).not.toContain("/api/supplier");
    expect(PUBLIC_API_PREFIXES).not.toContain("/api/supplier-auth");
  });

  test("/api/supplier-portal is public by mount ORDER, not by the list", () => {
    // Pins the documented divergence so the next reader does not "fix" it by
    // adding /api/supplier to the list — which is exactly the removed foot-gun.
    // supplierTrack resolves the token and 401s on its own; it must never
    // depend on a PUBLIC_API_PREFIXES entry.
    const gate = gateIndex();
    const mounted = app.routes.findIndex((r) => r.path.startsWith("/api/supplier-portal"));
    expect(mounted, "/api/supplier-portal is not mounted at all").toBeGreaterThan(-1);
    expect(
      mounted,
      "/api/supplier-portal must stay mounted ABOVE the auth gate — it is not in " +
        "PUBLIC_API_PREFIXES, so the gate would 401 every supplier before their " +
        "token was ever checked (the assr-form-intake bug).",
    ).toBeLessThan(gate);
    expect(PUBLIC_API_PREFIXES.some((p) => isUnder("/api/supplier-portal", p))).toBe(false);
  });
});
