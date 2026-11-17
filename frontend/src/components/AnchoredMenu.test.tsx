import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { AnchoredMenu } from "./AnchoredMenu";

afterEach(cleanup);

function StickyHeaderWithMenu({ onClose }: { onClose: () => void }): ReactElement {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <header data-testid="sticky-header" style={{ position: "sticky", zIndex: 20 }}>
      <div ref={anchorRef}>trigger</div>
      <AnchoredMenu anchorRef={anchorRef} onClose={onClose} menuStyle={{ minWidth: 220 }}>
        <button type="button">Sync to Connect</button>
      </AnchoredMenu>
    </header>
  );
}

describe("AnchoredMenu", () => {
  it("renders the menu outside the header that holds its trigger", () => {
    render(<StickyHeaderWithMenu onClose={vi.fn()} />);

    const menu = screen.getByRole("menu");

    expect(screen.getByTestId("sticky-header").contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
  });

  it("closes when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<StickyHeaderWithMenu onClose={onClose} />);

    fireEvent.click(screen.getByTestId("anchored-menu-backdrop"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
