import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportClientError } = vi.hoisted(() => ({ reportClientError: vi.fn() }));
vi.mock("./errorReporter", () => ({ reportClientError }));

async function freshModule() {
  vi.resetModules();
  return await import("./staleBuild");
}

describe("staleBuild matchers", () => {
  const DEPLOY_PROOF = [
    "Failed to fetch dynamically imported module: https://erp.houzscentury.com/assets3/purchase-order-pdf-AbC123.js",
    "error loading dynamically imported module: /assets3/Foo-x.js",
    "Loading chunk 42 failed.",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets3/Foo-x.css",
    'Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
  ];

  const AMBIGUOUS = [
    "Cannot read properties of undefined (reading 'preload')",
    "usePreloadRows: module script registry is empty",
    "Unsupported MIME type in the uploaded attachment",
  ];

  it("treats the ambiguous wordings as recoverable but NOT as proof of a deploy", async () => {
    const { isStaleChunkError, isDeployStaleEvidence } = await freshModule();
    for (const message of AMBIGUOUS) {
      expect(isStaleChunkError(new Error(message)), message).toBe(true);
      expect(isDeployStaleEvidence(new Error(message)), message).toBe(false);
    }
  });

  it("treats a real module-fetch failure as both", async () => {
    const { isStaleChunkError, isDeployStaleEvidence } = await freshModule();
    for (const message of DEPLOY_PROOF) {
      expect(isStaleChunkError(new Error(message)), message).toBe(true);
      expect(isDeployStaleEvidence(new Error(message)), message).toBe(true);
    }
  });

  it("treats an ordinary render error as neither", async () => {
    const { isStaleChunkError, isDeployStaleEvidence } = await freshModule();
    const err = new Error("Cannot read properties of null (reading 'total_amount')");
    expect(isStaleChunkError(err)).toBe(false);
    expect(isDeployStaleEvidence(err)).toBe(false);
  });

  it("reads a thrown non-Error without throwing", async () => {
    const { errorMessage } = await freshModule();
    expect(errorMessage("Failed to fetch dynamically imported module: /a.js")).toContain("/a.js");
    expect(errorMessage(null)).toBe("");
    expect(errorMessage(undefined)).toBe("");
    expect(errorMessage({ message: 42 })).toBe("42");
  });
});

describe("installChunkFailureWatch", () => {
  const disposers: Array<() => void> = [];

  async function watching() {
    const mod = await freshModule();
    disposers.push(mod.installChunkFailureWatch());
    return mod;
  }

  beforeEach(() => {
    reportClientError.mockReset();
  });
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
    vi.restoreAllMocks();
  });

  function dispatchPreloadError(payload: unknown): Event {
    const event = new Event("vite:preloadError", { cancelable: true });
    (event as Event & { payload?: unknown }).payload = payload;
    window.dispatchEvent(event);
    return event;
  }

  it("latches and notifies on a failed dynamic import from an event handler", async () => {
    const mod = await watching();
    const onChange = vi.fn();
    mod.subscribeChunkFailure(onChange);

    expect(mod.chunkFailureSnapshot()).toBe(false);
    dispatchPreloadError(
      new Error(
        "Failed to fetch dynamically imported module: https://erp.houzscentury.com/assets3/purchase-order-pdf-AbC123.js",
      ),
    );

    expect(mod.chunkFailureSnapshot()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(reportClientError).toHaveBeenCalledTimes(1);
    expect(reportClientError.mock.calls[0][1]).toBe("chunk-load-failed");
  });

  it("never swallows the error — the caller's own catch still runs", async () => {
    const mod = await watching();
    const event = dispatchPreloadError(
      new Error("Failed to fetch dynamically imported module: /assets3/x.js"),
    );
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a module that threw during EVALUATION — that is a page bug, not a deploy", async () => {
    const mod = await watching();
    const onChange = vi.fn();
    mod.subscribeChunkFailure(onChange);

    dispatchPreloadError(new Error("Cannot read properties of undefined (reading 'jsPDF')"));

    expect(mod.chunkFailureSnapshot()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it("latches once — a second failure does not re-notify", async () => {
    const mod = await watching();
    const onChange = vi.fn();
    mod.subscribeChunkFailure(onChange);

    dispatchPreloadError(new Error("Failed to fetch dynamically imported module: /assets3/a.js"));
    dispatchPreloadError(new Error("Failed to fetch dynamically imported module: /assets3/b.js"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(reportClientError).toHaveBeenCalledTimes(1);
  });

  it("installs exactly one listener however many times it is called", async () => {
    const mod = await freshModule();
    const addEventListener = vi.spyOn(window, "addEventListener");
    disposers.push(mod.installChunkFailureWatch());
    disposers.push(mod.installChunkFailureWatch());
    disposers.push(mod.installChunkFailureWatch());
    const preloadListeners = addEventListener.mock.calls.filter(
      ([type]) => type === "vite:preloadError",
    );
    expect(preloadListeners).toHaveLength(1);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const mod = await watching();
    const onChange = vi.fn();
    mod.subscribeChunkFailure(onChange)();
    dispatchPreloadError(new Error("Failed to fetch dynamically imported module: /assets3/a.js"));
    expect(onChange).not.toHaveBeenCalled();
    expect(mod.chunkFailureSnapshot()).toBe(true);
  });
});

describe("the Vite contract this whole file rests on", () => {
  function viteBundleSources(): string[] {
    const root = join(process.cwd(), "node_modules", "vite", "dist", "node", "chunks");
    const files = readdirSync(root).filter((f) => f.endsWith(".js"));
    expect(files.length, `no vite chunk sources under ${root}`).toBeGreaterThan(0);
    return files.map((f) => readFileSync(join(root, f), "utf8"));
  }

  it("still dispatches vite:preloadError, and still wraps the module import itself", () => {
    const sources = viteBundleSources();
    expect(sources.some((s) => s.includes('new Event("vite:preloadError"'))).toBe(true);
    expect(sources.some((s) => s.includes("return baseModule().catch(handlePreloadError)"))).toBe(
      true,
    );
    expect(sources.some((s) => s.includes("if (!e.defaultPrevented) throw err"))).toBe(true);
  });
});
