/* Editing an event on the phone must expose EVERY field at once and actually
 * save the DATES — the bug it fixes (owner 2026-09-21) was a six-prompt flow
 * that ended the moment any one prompt was dismissed, so the operator edited the
 * title, skipped a field, and never reached the date prompts.
 *
 * FAILS ON THE PRE-FIX CODE — the sheet did not exist; the date lived behind a
 * dismissible prompt that the flow never guaranteed reaching.
 *
 * Drives the REAL sheet and the REAL DateField. Nothing is faked: the sheet is
 * pure props (an onSave spy is the assertion).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditProjectSheet, type EditableProject } from "./MobileEditProjectSheet";

afterEach(cleanup);

const PROJECT: EditableProject = {
  name: "PENANG [AKEMI] HOMELOVE @ SETIA SPICE",
  booth_no: "A01-A04",
  venue: "SETIA SPICE CONVENTION CENTRE",
  organizer: "HOMELOVE",
  start_date: "2026-09-04",
  end_date: "2026-09-06",
};

function renderSheet(project: EditableProject = PROJECT) {
  const onSave = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(<EditProjectSheet project={project} onClose={onClose} onSave={onSave} />);
  return { onSave, onClose };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("EditProjectSheet — every event field is editable at once", () => {
  it("shows all six fields, dates included, pre-filled from the project", () => {
    renderSheet();
    expect(field("Event name").value).toBe("PENANG [AKEMI] HOMELOVE @ SETIA SPICE");
    expect(field("Booth number").value).toBe("A01-A04");
    expect(field("Venue").value).toBe("SETIA SPICE CONVENTION CENTRE");
    expect(field("Organizer").value).toBe("HOMELOVE");
    // DateField shows the canonical ISO as dd/mm/yyyy.
    expect(field("Start date").value).toBe("2026/09/04");
    expect(field("End date").value).toBe("2026/09/06");
  });

  it("saves a changed DATE — the field the old prompt flow never reached", () => {
    const { onSave } = renderSheet();
    fireEvent.change(field("End date"), { target: { value: "2026/09/08" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith({ end_date: "2026-09-08" });
  });

  it("sends ONLY the changed fields", () => {
    const { onSave } = renderSheet();
    fireEvent.change(field("Booth number"), { target: { value: "B10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith({ booth_no: "B10" });
  });

  it("edits the title AND a date in one save (the reported gap)", () => {
    const { onSave } = renderSheet();
    fireEvent.change(field("Event name"), { target: { value: "PENANG [AKEMI] HOMELOVE @ SETIA SPICE (REV)" } });
    fireEvent.change(field("Start date"), { target: { value: "2026/09/05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith({
      name: "PENANG [AKEMI] HOMELOVE @ SETIA SPICE (REV)",
      start_date: "2026-09-05",
    });
  });

  it("blocks a blank name", () => {
    renderSheet();
    fireEvent.change(field("Event name"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("The event name can't be blank.")).toBeTruthy();
  });

  it("blocks an end date before the start date", () => {
    renderSheet();
    fireEvent.change(field("End date"), { target: { value: "2026/09/01" } });
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("End date must be on or after the start date.")).toBeTruthy();
  });

  it("clearing an optional field sends null", () => {
    const { onSave } = renderSheet();
    fireEvent.change(field("Organizer"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith({ organizer: null });
  });

  it("hides name + organizer when the solo organizer is masked, and never sends them", () => {
    // A user who may not see a solo event's organizer (owner 2026-09-18): the
    // composed name embeds the organizer, so both fields are withheld — but the
    // dates, venue and booth stay editable.
    const onSave = vi.fn().mockResolvedValue(true);
    render(<EditProjectSheet project={PROJECT} hideNameOrganizer onClose={vi.fn()} onSave={onSave} />);
    expect(screen.queryByLabelText("Event name")).toBeNull();
    expect(screen.queryByLabelText("Organizer")).toBeNull();
    expect(screen.getByLabelText("Venue")).toBeTruthy();
    expect(screen.getByLabelText("Start date")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026/09/08" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith({ end_date: "2026-09-08" });
  });
});
