import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CJK_FONT_STYLESHEET, loadDeferredFontStylesheet } from "./deferredFonts";

const frontend = join(__dirname, "..", "..");
const links = () => document.head.querySelectorAll(`link[href="${CJK_FONT_STYLESHEET}"]`);

afterEach(() => {
  links().forEach((l) => l.remove());
  vi.restoreAllMocks();
});

describe("loadDeferredFontStylesheet", () => {
  it("waits for the load event while the page is still loading", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    loadDeferredFontStylesheet(document, CJK_FONT_STYLESHEET);
    expect(links()).toHaveLength(0);
    window.dispatchEvent(new Event("load"));
    expect(links()).toHaveLength(1);
    expect((links()[0] as HTMLLinkElement).rel).toBe("stylesheet");
  });

  it("attaches at once when the load event has already fired", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    loadDeferredFontStylesheet(document, CJK_FONT_STYLESHEET);
    expect(links()).toHaveLength(1);
  });

  it("does not attach the sheet twice", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    loadDeferredFontStylesheet(document, CJK_FONT_STYLESHEET);
    loadDeferredFontStylesheet(document, CJK_FONT_STYLESHEET);
    expect(links()).toHaveLength(1);
  });
});

describe("the font sheets on disk", () => {
  const read = (p: string) => readFileSync(join(frontend, p), "utf8");
  const html = read("index.html");
  const blocking = html.match(/<link rel="stylesheet" href="(\/fonts\/[^"]+)"/)?.[1];

  it("index.html blocks render on the Latin sheet only", () => {
    expect(blocking).toBe("/fonts/fonts-v3.css");
    expect(html).not.toContain(CJK_FONT_STYLESHEET);
    const latin = read(`public${blocking}`);
    expect(latin).not.toMatch(/font-family: 'Noto/);
    expect(latin.length).toBeLessThan(64 * 1024);
  });

  it("the deferred sheet holds every Chinese face and nothing else", () => {
    const cjk = read(`public${CJK_FONT_STYLESHEET}`);
    const families = [...cjk.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(families)).toEqual(new Set(["Noto Sans SC", "Noto Serif SC"]));
    const v2 = read("public/fonts/fonts-v2.css");
    const latin = read("public/fonts/fonts-v3.css");
    const faces = (s: string) => s.match(/@font-face/g)?.length ?? 0;
    expect(faces(latin) + faces(cjk)).toBe(faces(v2));
  });
});
