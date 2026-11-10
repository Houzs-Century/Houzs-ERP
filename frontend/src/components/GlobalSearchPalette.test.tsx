import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({ api: { get: vi.fn().mockResolvedValue({ hits: [] }) } }));

afterEach(cleanup);

describe("the palette loads after first paint", () => {
  it("opens even when nobody preloaded it: the slot waits for the chunk, then shows the search box", async () => {
    vi.resetModules();
    const { GlobalSearchProvider, GlobalSearchTrigger } = await import("./GlobalSearch");
    render(
      <MemoryRouter>
        <GlobalSearchProvider>
          <GlobalSearchTrigger />
        </GlobalSearchProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    expect(await screen.findByRole("combobox", { name: /search orders/i })).toBeTruthy();
  });

  it("the overlay module renders on its own and closes on Esc", async () => {
    const { Palette } = await import("./GlobalSearchPalette");
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <Palette onClose={onClose} />
      </MemoryRouter>,
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: /search orders/i }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
