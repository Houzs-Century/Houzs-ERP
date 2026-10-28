import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileVirtualList } from "./MobileVirtualList";

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
});

describe("MobileVirtualList scalability", () => {
  it("keeps the DOM bounded and reaches the final card in a variable-height 10,000-record list", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      const index = Number(this.dataset.vindex ?? 0);
      return index % 2 === 0 ? 80 : 140;
    });
    const items = Array.from({ length: 10_000 }, (_, index) => ({ id: index + 1 }));

    const { container, unmount } = render(
      <MobileVirtualList
        items={items}
        getKey={(item) => item.id}
        renderItem={(item) => <div>Order {item.id}</div>}
      />,
    );

    const mounted = container.querySelectorAll("[data-vcard]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(100);

    const list = container.querySelector<HTMLElement>("[data-mobile-virtual-list]")!;
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("aria-label")).toBe(
      "10000 loaded items. Only visible items are mounted; scroll to browse this loaded set.",
    );
    const initialCards = [...container.querySelectorAll<HTMLElement>("[data-vcard]")];
    expect(initialCards[0]?.getAttribute("role")).toBe("listitem");
    expect(initialCards[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(initialCards[0]?.getAttribute("aria-setsize")).toBe("10000");
    let top = 0;
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + 1_100_000,
      left: 0,
      right: 320,
      width: 320,
      height: 1_100_000,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    // Derive the maximum reachable scroll from the component's own rendered
    // spacer/card geometry. An over-scroll constant would clamp to the final
    // index even if the total-height calculation were wrong.
    const children = [...list.children] as HTMLElement[];
    const contentHeight = children.reduce((sum, child) => {
      const height = child.hasAttribute("data-vcard")
        ? child.offsetHeight
        : Number.parseFloat(child.style.height || "0");
      return sum + height;
    }, 0) + Math.max(0, children.length - 1) * 11;
    top = -Math.max(0, contentHeight - window.innerHeight);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(list.lastElementChild?.hasAttribute("data-vcard")).toBe(true);
    expect(container.querySelectorAll("[data-vcard]").length).toBeLessThanOrEqual(100);
    const tailCards = [...container.querySelectorAll<HTMLElement>("[data-vcard]")];
    expect(tailCards.at(-1)?.getAttribute("aria-posinset")).toBe("10000");
    expect(tailCards.at(-1)?.getAttribute("aria-setsize")).toBe("10000");

    // Leave a scheduled measurement pending so unmount must cancel it as
    // well as detaching the capturing scroll and resize listeners.
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(frames.length).toBeGreaterThan(0);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
