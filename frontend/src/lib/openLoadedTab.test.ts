import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLoadedTab, POPUP_BLOCKED_MESSAGE } from "./openLoadedTab";

function fakeTab() {
  return { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
}

describe("openLoadedTab", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the tab before the file has loaded, then points it at the file", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    let resolve!: (u: string) => void;
    const done = openLoadedTab(() => new Promise<string>((r) => { resolve = r; }), null);
    // Still inside the tap: the tab must already exist.
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.location.href).toBe("");
    resolve("blob:x");
    await done;
    expect(tab.location.href).toBe("blob:x");
    expect(tab.opener).toBeNull();
  });

  it("closes the empty tab and rethrows when the file fails to load", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await expect(openLoadedTab(() => Promise.reject(new Error("404")), null)).rejects.toThrow("404");
    expect(tab.close).toHaveBeenCalled();
  });

  it("says the popup was blocked instead of doing nothing", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const load = vi.fn(async () => "blob:x");
    await expect(openLoadedTab(load, null)).rejects.toThrow(POPUP_BLOCKED_MESSAGE);
    expect(load).not.toHaveBeenCalled();
  });
});

/* Every other window.open in the app runs synchronously in the click. A new one
   that follows an await would be silently blocked on phones: route it through
   openLoadedTab, or add it here only if it opens before any await. */
const SYNC_WINDOW_OPEN_FILES = new Set([
  "components/TopNavbar.tsx",
  "lib/openLoadedTab.ts",
  "mobile/RecordedPayments.tsx",
  "pages/ServiceCases.tsx",
  "pages/pos-admin/PosReportTab.tsx",
  "pages/pos-admin/labelPrint.ts",
  "vendor/scm/lib/pdf-common.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("no window.open after an await", () => {
  it("only the known synchronous call sites call window.open", () => {
    const src = join(__dirname, "..");
    const offenders = sourceFiles(src)
      .filter((f) => /window\.open\(/.test(readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")))
      .map((f) => relative(src, f).split(sep).join("/"))
      .filter((f) => !SYNC_WINDOW_OPEN_FILES.has(f));
    expect(offenders).toEqual([]);
  });
});
