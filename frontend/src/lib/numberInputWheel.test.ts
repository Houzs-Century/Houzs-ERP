// Sister-ERP gap review G23: the wheel must not change a focused number input.
import { afterEach, describe, expect, it } from "vitest";
import { installNumberInputWheelGuard } from "./numberInputWheel";

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = "";
});

const wheelOn = (el: Element) => el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));

describe("number input wheel guard", () => {
  it("blurs a focused number input when the wheel turns over it", () => {
    uninstall = installNumberInputWheelGuard();
    document.body.innerHTML = '<input type="number" value="5" id="q">';
    const input = document.getElementById("q") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    wheelOn(input);
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("5");
  });

  it("leaves text inputs and unfocused number inputs alone", () => {
    uninstall = installNumberInputWheelGuard();
    document.body.innerHTML = '<input type="text" id="t"><input type="number" id="n">';
    const text = document.getElementById("t") as HTMLInputElement;
    text.focus();
    wheelOn(text);
    expect(document.activeElement).toBe(text);
    wheelOn(document.getElementById("n")!);
    expect(document.activeElement).toBe(text);
  });

  it("main.tsx installs it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../main.tsx"), "utf8");
    expect(src).toMatch(/^void import\("\.\/lib\/numberInputWheel"\)\.then\(\(m\) => m\.installNumberInputWheelGuard\(\)\);$/m);
  });
});
