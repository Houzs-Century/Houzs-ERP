import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MrpAsOf } from "./MrpAsOf";
import type { ListMrpMeta } from "../lib/listMrpStatus";

/* The line above the PO / GRN / PI / SO lists: how old the stored MRP plan is,
   a warning when the list had to compute live, and Refresh. */

const at = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const snap: ListMrpMeta = { asOf: "2026-11-10T06:05:00.000Z", source: "snapshot", fallback: null, failed: false };

describe("MrpAsOf", () => {
  it("renders nothing before the first answer", () => {
    const { container } = render(<MrpAsOf status={{ meta: null, refresh: () => {}, refreshing: false }} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the stored plan's time, and Refresh asks for one live run", () => {
    const refresh = vi.fn();
    render(<MrpAsOf status={{ meta: snap, refresh, refreshing: false }} />);
    expect(screen.getByTestId("mrp-as-of").textContent).toContain(`MRP as of ${at(snap.asOf!)}`);
    expect(screen.getByTestId("mrp-as-of").className).toContain("text-ink-muted");
    fireEvent.click(screen.getByRole("button", { name: "Refresh MRP" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("warns when the stored plan was too old and the list computed live", () => {
    render(<MrpAsOf status={{ meta: { ...snap, source: "live", fallback: "stale" }, refresh: () => {}, refreshing: false }} />);
    const el = screen.getByTestId("mrp-as-of");
    expect(el.textContent).toContain("stored plan over 30 min old");
    expect(el.className).toContain("text-warning-text");
  });

  it("while recomputing, the button is disabled so a second click cannot start another", () => {
    render(<MrpAsOf status={{ meta: snap, refresh: () => {}, refreshing: true }} />);
    expect(screen.getByTestId("mrp-as-of").textContent).toContain("Recomputing MRP");
    expect((screen.getByRole("button", { name: "Refresh MRP" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
