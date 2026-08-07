// ----------------------------------------------------------------------------
// Branding — the TWO logo slots (owner 2026-08-06).
//
// The app chrome is dark and paper is white, so one file cannot serve both:
// 2990's on-screen logo is the white variant, correct in the sidebar and a
// near-invisible watermark on a printed Delivery Order. `logoR2Key` stays the
// ON-SCREEN logo; `printLogoR2Key` is the optional one documents use.
//
// What's pinned here is the ISOLATION between the slots, in both directions —
// that is the whole bug this exists to prevent. Writing one slot must never
// move the other's pointer, and must never delete bytes the other still points
// at (an R2 delete is not recoverable: the letterhead would go blank on the
// next print with no error anywhere).
//
// Harness: the REAL router over the isolated D1 + real R2 binding, with a bare
// middleware standing in for companyContext — the configCache.test.ts pattern.
// Storage isolation in this pool is per FILE, so each test clears both slots
// first instead of inheriting the previous flow's row.
// ----------------------------------------------------------------------------

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import brandingRoutes from "../src/routes/branding";
import { letterheadLogoKey } from "../src/services/branding";

const state = {
  companyCode: undefined as string | undefined,
  user: undefined as any,
};
const app = new Hono();
app.use("*", async (c: any, next: any) => {
  c.set("user", state.user);
  if (state.companyCode) c.set("companyCode", state.companyCode);
  await next();
});
app.route("/api/branding", brandingRoutes);

const ADMIN = { id: 1, email: "it@test.local", permissions: ["*"], permissions_set: new Set(["*"]) };
// Non-numeric code resolveCompanyCode passes through without a companies
// master, so this file's rows ('branding:LOGO') never collide with another
// suite's.
const CO = "LOGO";

const PNG_APP = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]); // "screen" bytes
const PNG_PRINT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02]); // "paper" bytes

function request(path: string, init?: RequestInit) {
  state.companyCode = CO;
  state.user = ADMIN;
  return app.request(path, init as any, env as any);
}

/** Storage isolation in this pool is per FILE, not per test — so each flow
 *  starts from both slots empty rather than inheriting the last one's row. */
async function resetSlots() {
  await request("/api/branding/logo?variant=print", { method: "DELETE" });
  await request("/api/branding/logo", { method: "DELETE" });
}

async function upload(variant: "app" | "print", bytes: Uint8Array) {
  const res = await request(
    `/api/branding/logo${variant === "print" ? "?variant=print" : ""}`,
    { method: "POST", headers: { "content-type": "image/png" }, body: bytes },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

// ── The resolver every print surface shares ─────────────────────────────────

describe("letterheadLogoKey", () => {
  test("print slot wins, blank falls back to the on-screen logo, blank/blank prints text-only", () => {
    expect(letterheadLogoKey({ logoR2Key: "screen.png", printLogoR2Key: "paper.png" })).toBe("paper.png");
    // The pre-2026-08 behaviour every existing company keeps: no print logo
    // uploaded ⇒ documents print the one logo there is.
    expect(letterheadLogoKey({ logoR2Key: "screen.png", printLogoR2Key: "" })).toBe("screen.png");
    expect(letterheadLogoKey({ logoR2Key: "screen.png" })).toBe("screen.png");
    // Whitespace is not a logo.
    expect(letterheadLogoKey({ logoR2Key: "screen.png", printLogoR2Key: "   " })).toBe("screen.png");
    expect(letterheadLogoKey({ logoR2Key: "", printLogoR2Key: "" })).toBe("");
  });
});

describe("branding logo slots", () => {
  test("uploading one slot never moves the other's pointer — both directions", async () => {
    await resetSlots();
    const a = await upload("app", PNG_APP);
    expect(a.branding.logoR2Key).toMatch(/^branding\/logo-logo-\d+\.png$/);
    expect(a.branding.printLogoR2Key).toBe("");

    // Direction 1: adding a print logo leaves the on-screen one exactly as it
    // was — otherwise the sidebar would go dark-on-dark the moment the owner
    // uploads the paper variant, which is the bug this feature exists to fix.
    const b = await upload("print", PNG_PRINT);
    expect(b.branding.logoR2Key).toBe(a.branding.logoR2Key);
    expect(b.branding.printLogoR2Key).toMatch(/^branding\/logo-print-logo-\d+\.png$/);
    expect(b.branding.printLogoR2Key).not.toBe(b.branding.logoR2Key);

    // Direction 2: replacing the on-screen logo leaves the print one alone.
    const c = await upload("app", PNG_APP);
    expect(c.branding.printLogoR2Key).toBe(b.branding.printLogoR2Key);
    expect(c.branding.logoR2Key).not.toBe(a.branding.logoR2Key);
    // The replaced object is cleaned up; the OTHER slot's bytes survive.
    expect(await env.POD_BUCKET.get(a.branding.logoR2Key)).toBeNull();
    expect(await env.POD_BUCKET.get(b.branding.printLogoR2Key)).not.toBeNull();
  });

  test("GET serves the requested slot, and 404s rather than serving the wrong one", async () => {
    // No print logo yet: a print-variant read must MISS, not silently hand back
    // the screen logo — the client memoises by key and decides the fallback.
    await resetSlots();
    await upload("app", PNG_APP);
    expect((await request("/api/branding/logo?variant=print")).status).toBe(404);

    await upload("print", PNG_PRINT);
    const paper = await request("/api/branding/logo?variant=print");
    expect(paper.status).toBe(200);
    expect(new Uint8Array(await paper.arrayBuffer())).toEqual(PNG_PRINT);

    // No variant = the on-screen slot, i.e. every pre-existing caller.
    const screen = await request("/api/branding/logo");
    expect(screen.status).toBe(200);
    expect(new Uint8Array(await screen.arrayBuffer())).toEqual(PNG_APP);
  });

  test("DELETE clears only the addressed slot and leaves the other's bytes intact", async () => {
    await resetSlots();
    const a = await upload("app", PNG_APP);
    const b = await upload("print", PNG_PRINT);

    const res = await request("/api/branding/logo?variant=print", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.branding.printLogoR2Key).toBe("");
    expect(body.branding.logoR2Key).toBe(a.branding.logoR2Key);
    // The print object is gone; the screen one is untouched and still served.
    expect(await env.POD_BUCKET.get(b.branding.printLogoR2Key)).toBeNull();
    expect(await env.POD_BUCKET.get(a.branding.logoR2Key)).not.toBeNull();
    expect((await request("/api/branding/logo")).status).toBe(200);
    // Documents fall back to the on-screen logo again.
    expect(letterheadLogoKey(body.branding)).toBe(a.branding.logoR2Key);
  });

  test("the served bytes name their company, so a client can refuse a mismatch", async () => {
    /* The client memoises the letterhead logo by R2 key alone, which cannot say
       WHOSE image arrived. This header is what lets it refuse one company's mark
       on another company's document (frontend lib/branding.ts) — and it must be
       on the response for BOTH slots, since the letterhead may resolve to
       either. */
    await resetSlots();
    await upload("app", PNG_APP);
    const screen = await request("/api/branding/logo");
    expect(screen.headers.get("x-company-code")).toBe(CO);

    await upload("print", PNG_PRINT);
    const paper = await request("/api/branding/logo?variant=print");
    expect(paper.headers.get("x-company-code")).toBe(CO);

    /* The response is cacheable AND company-dependent, and the company arrives
       in a header — so it must say so, or a cache may serve one company the
       copy it stored for another. A browser did exactly that to the PDF
       letterhead on 2026-08-07. */
    expect(paper.headers.get("cache-control")).toContain("max-age");
    expect(paper.headers.get("vary")?.toLowerCase()).toContain("x-company-id");
    expect(screen.headers.get("vary")?.toLowerCase()).toContain("x-company-id");
  });

  test("an unknown variant is treated as the on-screen slot, never as a third one", async () => {
    await resetSlots();
    const a = await upload("app", PNG_APP);
    const res = await request("/api/branding/logo?variant=banana");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_APP);
    expect(letterheadLogoKey(a.branding)).toBe(a.branding.logoR2Key);
  });
});
