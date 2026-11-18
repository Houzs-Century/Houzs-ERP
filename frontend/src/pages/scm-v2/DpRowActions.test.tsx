/* DP Orders list: Edit on a row opened the job panel too (the row click), and the
   panel stacked over the Edit drawer, half covering it. A row button must reach
   only its own handler. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DpRowActions } from "./DpRowActions";

const renderInRow = (status: string) => {
  const onRow = vi.fn();
  const onRowDouble = vi.fn();
  const onEdit = vi.fn();
  const onSchedule = vi.fn();
  const onCancel = vi.fn();
  render(
    <div onClick={onRow} onDoubleClick={onRowDouble}>
      <DpRowActions status={status} cancelling={false} onEdit={onEdit} onSchedule={onSchedule} onCancel={onCancel} />
    </div>,
  );
  return { onRow, onRowDouble, onEdit, onSchedule, onCancel };
};

describe("DpRowActions", () => {
  test("Edit, Schedule and Cancel do not reach the row's click", () => {
    const h = renderInRow("PENDING_SCHEDULE");
    fireEvent.click(screen.getByText("Edit…"));
    fireEvent.click(screen.getByText("Schedule…"));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.doubleClick(screen.getByText("Edit…"));
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onSchedule).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onRow).not.toHaveBeenCalled();
    expect(h.onRowDouble).not.toHaveBeenCalled();
  });

  test("a cancelled job offers no buttons", () => {
    renderInRow("CANCELLED");
    expect(screen.queryByText("Edit…")).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });
});
