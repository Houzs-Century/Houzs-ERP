// Relationship Map links (owner 2026-11-09: "from the PO's relationship map I
// can't jump to my SO"). Every node opened a path with no route — /mfg-sales-orders,
// /grns, /purchase-invoices... — and landed on "not found"; only the PO link had
// the /scm prefix. Each route the map opens must be a path App.tsx declares.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.resolve(__dirname, p), "utf8");
const modal = read("./DocumentFlowModal.tsx");
const app = read("../../../App.tsx");

/* "route: (id) => `/scm/sales-orders/${encodeURIComponent(id)}`" -> "/scm/sales-orders/:x" */
const mapRoutes = [...modal.matchAll(/route:\s*\(id\)\s*=>\s*`([^`]+)`/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, ":x"));
const appRoutes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1].replace(/:[A-Za-z]+/g, ":x"));

describe("Relationship Map links", () => {
  it("reads every node route", () => {
    expect(mapRoutes.length).toBeGreaterThanOrEqual(14);
  });
  it.each(mapRoutes)("%s is a page the app has", (r) => {
    expect(appRoutes).toContain(r);
  });
});
