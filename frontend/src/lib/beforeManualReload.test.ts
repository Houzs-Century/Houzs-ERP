import { describe, expect, it, vi } from "vitest";
import { onBeforeManualReload, runBeforeManualReload } from "./beforeManualReload";

describe("beforeManualReload", () => {
  it("runs registered hooks, skips unregistered ones, and survives a throwing hook", () => {
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error("boom");
    });
    const c = vi.fn();
    const offA = onBeforeManualReload(a);
    const offB = onBeforeManualReload(b);
    const offC = onBeforeManualReload(c);
    offA();
    expect(() => runBeforeManualReload()).not.toThrow();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    offB();
    offC();
  });
});
