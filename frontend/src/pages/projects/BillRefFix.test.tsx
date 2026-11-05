import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BillRefFix } from "./BillRefFix";

vi.mock("../../api/client", () => ({ api: { post: vi.fn().mockResolvedValue({ ok: true }) } }));

describe("changing a bill's reference", () => {
  test("the row says it saved while the report recounts", async () => {
    const onSaved = vi.fn();
    render(<BillRefFix projectId={12} from="ZNF6767" onSaved={onSaved} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("New reference for ZNF6767"), { target: { value: "znt6767" } });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("Saved as ZNT6767, updating…")).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Edit")).toBeNull();
  });
});
