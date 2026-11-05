import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../api/client";
import { BooksGapButton } from "./BooksGapButton";

vi.mock("../../api/client", () => ({ api: { post: vi.fn() } }));
const post = vi.mocked(api.post);

describe("taking a gap off Books not complete", () => {
  beforeEach(() => post.mockReset());
  test("Remove saves the gap and the row does not open the event", async () => {
    post.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();
    const onRow = vi.fn();
    render(<div onClick={onRow}><BooksGapButton projectId={12} gap="size" waived={false} onSaved={onSaved} /></div>);
    fireEvent.click(screen.getByText("Remove"));
    expect(await screen.findByText("Saved, updating…")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/project-sales-bills/12/books-gap", { gap: "size", waived: true });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
  });
  test("Put back undoes it, and a failure says so", async () => {
    post.mockRejectedValueOnce(new Error("Only the Owner can do this."));
    render(<BooksGapButton projectId={12} gap="rental" waived onSaved={() => {}} />);
    fireEvent.click(screen.getByText("Put back"));
    expect(post).toHaveBeenCalledWith("/api/project-sales-bills/12/books-gap", { gap: "rental", waived: false });
    expect(await screen.findByText("Only the Owner can do this.")).toBeTruthy();
  });
});
