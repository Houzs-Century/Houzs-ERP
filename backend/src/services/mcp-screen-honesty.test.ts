import { describe, it, expect } from "vitest";
import { frontendRoutes, labelInFrontend, routeExists } from "../../scripts/lib/frontend-honesty.mjs";
import { SCREENS } from "./mcp-screen-map";

const redirectOnly = (r: string) => ["/roles", "/scm/official-receipts", "/scm/deposit-invoices", "/scm/lorry-capacity", "/scm/lorry-live-map"].includes(r);

describe("screen map stays honest to the frontend", () => {
  it("every screen path is a route, and each route has one screen", () => {
    const bad = SCREENS.filter((s) => !routeExists(s.path)).map((s) => s.path);
    expect(bad).toEqual([]);
    const paths = SCREENS.map((s) => s.path.split("?")[0]);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(SCREENS.length);
    const missing = frontendRoutes().filter((r) => !redirectOnly(r) && !paths.includes(r));
    expect(missing).toEqual([]);
  });

  it("every action, tab and section label exists in frontend/src", () => {
    const bad: string[] = [];
    for (const s of SCREENS) {
      for (const a of s.actions) if (!labelInFrontend(a.label)) bad.push(`${s.path}: "${a.label}"`);
      for (const t of s.tabs) if (!labelInFrontend(t)) bad.push(`${s.path} tab: "${t}"`);
      for (const t of s.sections) if (!labelInFrontend(t)) bad.push(`${s.path} section: "${t}"`);
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it("every page has a purpose; high-traffic pages are in full detail", () => {
    for (const s of SCREENS) expect(s.purpose.length, s.path).toBeGreaterThan(0);
    const full = ["/scm/sales-orders", "/scm/sales-orders/new", "/scm/purchase-orders", "/scm/grns", "/scm/delivery-orders", "/scm/delivery-planning", "/scm/sales-invoices", "/scm/receipts", "/assr", "/scm/inventory", "/scm/products", "/mail-center", "/pos-admin", "/settings"];
    for (const p of full) expect(SCREENS.some((s) => s.path.split("?")[0] === p && s.detail === "full"), p).toBe(true);
  });

  it("is English only", () => {
    const bad = SCREENS.filter((s) => /[㐀-鿿]/.test(JSON.stringify({ ...s, keywords: [] }))).map((s) => s.path);
    expect(bad).toEqual([]);
  });
});
