import { describe, it, expect } from "vitest";
import { labelInFrontend, repoFileSize, routeExists } from "../../scripts/lib/frontend-honesty.mjs";
import { SHOTS } from "./mcp-help-shots";
import { annotatedHtml, annotatedSvg, resolveShot, SHOT_NOTE, showMeText } from "./mcp-show-me";
import { MCP_TOOLS } from "../routes/mcp";

const RECAPTURE = "re-capture screenshots: npm run capture:help-shots";
const pages = Object.keys(SHOTS);

describe("help screenshots stay fresh", () => {
  it("every boxed label still exists in frontend/src", () => {
    const bad: string[] = [];
    for (const p of pages) for (const l of Object.keys(SHOTS[p].boxes)) if (!labelInFrontend(l)) bad.push(`${p}: "${l}"`);
    expect(bad, RECAPTURE).toEqual([]);
  }, 60_000);

  it("every shot's page is a route and its picture is in frontend/public/help-shots", () => {
    const bad = pages.filter((p) => !routeExists(p) || repoFileSize(`frontend/public/help-shots/${SHOTS[p].file}`) <= 0);
    expect(bad, RECAPTURE).toEqual([]);
  });

  it("the pictures stay under 8 MB in total", () => {
    const total = pages.reduce((n, p) => n + Math.max(0, repoFileSize(`frontend/public/help-shots/${SHOTS[p].file}`)), 0);
    expect(total).toBeLessThan(8 * 1024 * 1024);
  });
});

describe("show_me", () => {
  it("resolves a page + label, a label alone and a guide step", () => {
    const p = pages.find((x) => Object.keys(SHOTS[x].boxes).length > 0) ?? "";
    const label = Object.keys(SHOTS[p].boxes)[0];
    expect(resolveShot({ path: p, label })?.label).toBe(label);
    expect(resolveShot({ path: `https://erp.test${p}`, label: label.toUpperCase() })?.page).toBe(p);
    expect(resolveShot({ label })).not.toBeNull();
    expect(resolveShot({ path: "/no/such", label: "x" })).toBeNull();
  });

  it("draws a red box, an arrow and the caption over the screenshot", () => {
    const p = pages[0];
    const label = Object.keys(SHOTS[p].boxes)[0];
    const hit = resolveShot({ path: p, label });
    expect(hit).not.toBeNull();
    if (!hit) return;
    const svg = annotatedSvg(hit, "QUJD", 'Press "New <x>"');
    expect(svg).toContain('href="data:image/webp;base64,QUJD"');
    expect(svg).toContain('stroke="#e11d48"');
    expect(svg).toContain("<polygon");
    expect(svg).toContain("Press &quot;New &lt;x&gt;&quot;");
    expect(annotatedHtml(svg, "t")).toContain("<svg");
    const t = showMeText(hit, "https://erp.test", "https://erp.test/api/mcp/export/k");
    expect(t.note).toBe(SHOT_NOTE);
    expect(t.openThePage).toContain("highlight=");
  });

  it("is registered as a read-only tool", () => {
    const tool = MCP_TOOLS.find((x) => x.name === "show_me");
    expect(tool?.annotations.readOnlyHint).toBe(true);
  });
});
