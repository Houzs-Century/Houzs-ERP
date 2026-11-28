import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");
export const ROUTE_GUARDS_JSON = "backend/src/services/mcp-route-guards.json";

const CONSTS = {
  BACKDATE_DECIDER_PERMS: () => {
    const src = fs.readFileSync(path.join(REPO, "frontend/src/vendor/scm/lib/payment-backdate-perms.ts"), "utf8");
    const key = /PAYMENT_BACKDATE_KEY\s*=\s*'([^']+)'/.exec(src)?.[1];
    const list = /BACKDATE_DECIDER_PERMS[^=]*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "";
    return list.split(",").map((s) => s.trim()).map((s) => (s === "PAYMENT_BACKDATE_KEY" ? key : s.replace(/^['"]|['"]$/g, "")));
  },
};

const strList = (s) => [...s.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]+)"`).exec(tag)?.[1];
const flag = (tag, name) => new RegExp(`\\b${name}(\\s|=\\{true\\}|/?>)`).test(tag);
const tagOf = (seg, name) => {
  const i = seg.indexOf(`<${name}`);
  if (i < 0) return null;
  const j = seg.indexOf(">", i);
  return seg.slice(i, j + 1);
};

/** The HowtoGate of one route element, read the way App.tsx writes it; null for a pure redirect. */
export function gateOfSegment(seg) {
  if (/<(Navigate|FoldRedirect|AliasRedirect)\b/.test(seg) && !/<(ScmGuard|PageGuard|Guard)\b/.test(seg)) return null;
  if (seg.includes("<DeliveryReturnsGuard")) return { kind: "deliveryReturns" };
  if (seg.includes("<FairReportGuard")) return { kind: "fairReport" };
  if (seg.includes("<SoMaintenanceGuard")) return { kind: "soMaintenance" };
  if (seg.includes("<ItPagesGuard")) return { kind: "itPages" };
  if (seg.includes("<AssistantGuard")) return { kind: "assistant" };
  if (seg.includes("<SalesRepCaseDetailRoute")) return { kind: "page", page: "service_cases", allowSales: true };
  const scm = tagOf(seg, "ScmGuard");
  if (scm) {
    const g = { kind: "scm", area: attr(scm, "area") };
    for (const f of ["allowSales", "allowDirector", "allowSalesDirector"]) if (flag(scm, f)) g[f] = true;
    return g;
  }
  const page = tagOf(seg, "PageGuard");
  if (page) {
    const g = { kind: "page", page: attr(page, "page") };
    const min = attr(page, "minLevel");
    if (min) g.minLevel = min;
    for (const f of ["allowSales", "allowSalesDirector"]) if (flag(page, f)) g[f] = true;
    return g;
  }
  const guard = tagOf(seg, "Guard");
  if (guard) {
    const any = [];
    const perm = attr(guard, "perm");
    if (perm) any.push(perm);
    const lit = /anyPerm=\{\[([^\]]*)\]\}/.exec(guard);
    if (lit) any.push(...strList(lit[1]));
    const named = /anyPerm=\{([A-Z_]+)\}/.exec(guard);
    if (named && CONSTS[named[1]]) any.push(...CONSTS[named[1]]());
    const g = { kind: "perm", any };
    const acc = /anyAccess=\{\[([^\]]*)\]\}/.exec(guard);
    if (acc) g.anyAccess = strList(acc[1]);
    if (flag(guard, "allowSales")) g.allowSales = true;
    return g;
  }
  return { kind: "open" };
}

/** Every route path in frontend/src/App.tsx with its guard, redirects left out. */
export function parseRouteGuards() {
  const app = fs.readFileSync(path.join(REPO, "frontend/src/App.tsx"), "utf8");
  const hits = [...app.matchAll(/path="([^"]+)"/g)];
  const out = {};
  hits.forEach((m, i) => {
    if (m[1] === "*") return;
    const nextPath = i + 1 < hits.length ? hits[i + 1].index : app.length;
    const nextRoute = app.indexOf("<Route", m.index);
    const end = nextRoute > 0 && nextRoute < nextPath ? nextRoute : nextPath;
    const seg = app.slice(m.index, end);
    const g = gateOfSegment(seg);
    if (g) out[m[1]] = g;
  });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export const routeGuardsJson = () => `${JSON.stringify(parseRouteGuards(), null, 2)}\n`;
