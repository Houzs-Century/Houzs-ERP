import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./errorReporter", () => ({ reportClientError: vi.fn() }));

/* Module-level state (the in-flight intent, the registered openers) is the
   point of this module, so every test gets a FRESH copy. */
async function freshModule() {
  vi.resetModules();
  return await import("./chunkActionRecovery");
}

const STALE =
  "Failed to fetch dynamically imported module: https://erp.houzscentury.com/assets3/sales-order-pdf-C9QaiR37.js";
const T0 = new Date("2026-09-14T03:00:00.000Z").getTime();

function staleError(message = STALE): Error {
  return new Error(message.replace("https://erp.houzscentury.com", window.location.origin));
}

type Mod = Awaited<ReturnType<typeof freshModule>>;

function deps(over: Partial<Parameters<Mod["handleActionChunkFailure"]>[1]> = {}) {
  return {
    reload: vi.fn(),
    probe: vi.fn(async () => "absent" as const),
    now: () => T0,
    location: { pathname: "/scm/sales-orders/HC-SO-012016", search: "" },
    ...over,
  };
}

describe("chunkActionRecovery — a chunk that 404s during a print reloads once and resumes", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads and stores a resume for the page's own print preview", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const d = deps();
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);

    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("reload");
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(mod.peekPrintResume("/scm/sales-orders/HC-SO-012016", T0 + 1_000)).toEqual({
      kind: "preview",
      path: "/scm/sales-orders/HC-SO-012016",
      at: T0,
    });
  });

  it("reloads a list's right-click print and carries the document it was printing", async () => {
    const mod = await freshModule();
    const target = { doc: "so", docNo: "HC-SO-012016", key: "HC-SO-012016" } as const;
    const d = deps({ location: { pathname: "/scm/sales-orders", search: "?q=012016" } });
    void mod.trackPrintAction({ kind: "chain", target }, () => new Promise(() => {}), d.now);

    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("reload");
    expect(mod.peekPrintResume("/scm/sales-orders?q=012016", T0)).toEqual({
      kind: "chain",
      path: "/scm/sales-orders?q=012016",
      at: T0,
      target,
    });
  });

  it("does NOT reload a failure that no user action started (a background prefetch)", async () => {
    const mod = await freshModule();
    const d = deps();
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("ignore");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("does NOT reload once the action has settled", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const d = deps();
    await mod.trackPrintAction({ kind: "preview", open }, () => Promise.resolve(), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("ignore");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a message that is not proof of a missing module", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const d = deps();
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(new Error("Cannot read properties of undefined (reading 'preload')"), d)).toBe("ignore");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("shows the banner instead when the page cannot reopen that print", async () => {
    const mod = await freshModule();
    const d = deps();
    // A preview whose page never registered a URL opener (the phone's SO detail).
    void mod.trackPrintAction({ kind: "preview", open: vi.fn() }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("shows the banner instead when a form holds unsaved work", async () => {
    const mod = await freshModule();
    const unsaved = await import("./unsavedWork");
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const release = unsaved.holdUnsavedWork();
    const d = deps();
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    expect(d.reload).not.toHaveBeenCalled();
    release();
  });

  it("shows the banner instead on an editor URL", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const d = deps({ location: { pathname: "/scm/sales-orders/HC-SO-012016", search: "?edit=1" } });
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("reloads at most once per cooldown window — no loop", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    let now = T0;
    const d = deps({ now: () => now });

    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("reload");

    // The reload landed on a build that STILL cannot fetch it.
    now = T0 + 60_000;
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");

    now = T0 + mod.ACTION_RELOAD_COOLDOWN_MS + 1;
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("reload");
    expect(d.reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload into a dead network — a probe that cannot answer shows the banner", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const d = deps({ probe: vi.fn(async () => "unknown" as const) });
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("never reloads when sessionStorage refuses — an attempt it cannot remember could repeat forever", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const d = deps();
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("the banner's Refresh reopens a print the automatic path declined (unsaved work)", async () => {
    const mod = await freshModule();
    const unsaved = await import("./unsavedWork");
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const release = unsaved.holdUnsavedWork();
    const d = deps();
    expect(mod.rememberBlockedPrintForReload(T0, d.location)).toBe(false);
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    expect(mod.rememberBlockedPrintForReload(T0 + 1_000, d.location)).toBe(true);
    expect(mod.peekPrintResume("/scm/sales-orders/HC-SO-012016", T0 + 2_000)?.kind).toBe("preview");
    // A click is not a loop: it leaves no cooldown behind.
    expect(sessionStorage.getItem(mod.ACTION_RELOAD_KEY)).toBeNull();
    release();
  });

  it("forgets a click after the intent window", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    let now = T0;
    const d = deps({ now: () => now });
    void mod.trackPrintAction({ kind: "preview", open }, () => undefined, d.now);
    now = T0 + mod.ACTION_INTENT_TTL_MS + 1;
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("ignore");
  });

  it("an unregistered opener stops being resumable", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    const unregister = mod.registerUrlPrintOpener(open);
    unregister();
    const d = deps();
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
  });

  it("returns the action's own value untouched, and a rejection stays the caller's", async () => {
    const mod = await freshModule();
    const failing = Promise.reject(new Error("boom"));
    const returned = mod.trackPrintAction({ kind: "chain", target: { doc: "po", docNo: "PO-1", key: "k" } }, () => failing, () => T0);
    expect(returned).toBe(failing);
    await expect(returned).rejects.toThrow("boom");
  });

  it("a resume is read only on the page it was written for, and only while fresh", async () => {
    const mod = await freshModule();
    sessionStorage.setItem(mod.PRINT_RESUME_KEY, JSON.stringify({ kind: "preview", path: "/a", at: T0 }));
    expect(mod.peekPrintResume("/b", T0)).toBeNull();
    expect(mod.peekPrintResume("/a", T0 + mod.PRINT_RESUME_TTL_MS + 1)).toBeNull();
    expect(mod.peekPrintResume("/a", T0 + 5_000)).not.toBeNull();
    mod.clearPrintResume();
    expect(mod.peekPrintResume("/a", T0 + 5_000)).toBeNull();
    sessionStorage.setItem(mod.PRINT_RESUME_KEY, "{not json");
    expect(mod.peekPrintResume("/a", T0)).toBeNull();
  });

  it("the first tracked print installs the listener by itself", async () => {
    const mod = await freshModule();
    const add = vi.spyOn(window, "addEventListener");
    const open = vi.fn();
    void mod.trackPrintAction({ kind: "preview", open }, () => undefined, () => T0);
    void mod.trackPrintAction({ kind: "preview", open }, () => undefined, () => T0);
    expect(add.mock.calls.filter(([name]) => name === "vite:preloadError")).toHaveLength(1);
  });

  it("the banner's Refresh hook stores the declined print", async () => {
    const mod = await freshModule();
    const reloadHooks = await import("./beforeManualReload");
    const unsaved = await import("./unsavedWork");
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const release = unsaved.holdUnsavedWork();
    window.history.replaceState({}, "", "/scm/sales-orders/HC-SO-012016");
    const d = deps({ now: () => Date.now() });
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    expect(await mod.handleActionChunkFailure(staleError(), d)).toBe("banner");
    reloadHooks.runBeforeManualReload();
    expect(mod.peekPrintResume("/scm/sales-orders/HC-SO-012016", Date.now())?.kind).toBe("preview");
    release();
    window.history.replaceState({}, "", "/");
  });

  it("the installed listener acts on Vite's own event and never preventDefaults it", async () => {
    const mod = await freshModule();
    const open = vi.fn();
    mod.registerUrlPrintOpener(open);
    const d = deps();
    const dispose = mod.installActionChunkRecovery(d);
    void mod.trackPrintAction({ kind: "preview", open }, () => new Promise(() => {}), d.now);
    const event = new Event("vite:preloadError", { cancelable: true });
    (event as Event & { payload?: unknown }).payload = staleError();
    window.dispatchEvent(event);
    await vi.waitFor(() => expect(d.reload).toHaveBeenCalledTimes(1));
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });
});
