import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnnouncementRichEditor } from "./AnnouncementRichEditor";

// jsdom has no editing commands. Stub the two the editor relies on so a click
// on the toolbar is observable, and so the fontSize path can be exercised by
// hand-planting the <font size="7"> the real browser would have produced.
const execCommand = vi.fn<(cmd: string, ui?: boolean, arg?: string) => boolean>(() => true);
const queryCommandState = vi.fn<(cmd: string) => boolean>(() => false);

beforeEach(() => {
  execCommand.mockClear();
  queryCommandState.mockClear();
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  Object.defineProperty(document, "queryCommandState", {
    value: queryCommandState,
    configurable: true,
  });
});
afterEach(cleanup);

function editor() {
  return screen.getByRole("textbox") as HTMLDivElement;
}

describe("AnnouncementRichEditor", () => {
  test("mounts the incoming value as canonical html and flags empty state", () => {
    const { rerender } = render(<AnnouncementRichEditor value="" onChange={() => {}} placeholder="Write…" />);
    expect(editor().getAttribute("data-empty")).toBe("true");
    expect(editor().getAttribute("data-placeholder")).toBe("Write…");

    rerender(<AnnouncementRichEditor value="<div>hi <strong>b</strong></div>" onChange={() => {}} />);
    expect(editor().innerHTML).toBe("<p>hi <b>b</b></p>");
    expect(editor().getAttribute("data-empty")).toBe("false");
  });

  test("typing reports the canonicalised innerHTML, never the browser's spelling", () => {
    const onChange = vi.fn();
    render(<AnnouncementRichEditor value="" onChange={onChange} />);
    const el = editor();
    el.innerHTML = '<div style="color:red">a<span style="font-weight:bold">b</span></div>';
    fireEvent.input(el);
    expect(onChange).toHaveBeenLastCalledWith("<p>ab</p>");
    expect(el.getAttribute("data-empty")).toBe("false");
  });

  test("a blank document reports an empty string", () => {
    const onChange = vi.fn();
    render(<AnnouncementRichEditor value="" onChange={onChange} />);
    const el = editor();
    el.innerHTML = "<p><br></p>";
    fireEvent.input(el);
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(el.getAttribute("data-empty")).toBe("true");
  });

  test("toolbar buttons drive the browser editing commands", () => {
    render(<AnnouncementRichEditor value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Numbered list" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulleted list" }));
    const cmds = execCommand.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("bold");
    expect(cmds).toContain("insertOrderedList");
    expect(cmds).toContain("insertUnorderedList");
  });

  test("size buttons fold the fontSize sentinel into data-size spans", () => {
    const onChange = vi.fn();
    render(<AnnouncementRichEditor value="" onChange={onChange} />);
    const el = editor();
    // Simulate what execCommand('fontSize', '7') leaves behind in a browser.
    execCommand.mockImplementation((cmd) => {
      if (cmd === "fontSize") el.innerHTML = '<p>a<font size="7">big</font></p>';
      return true;
    });
    fireEvent.click(screen.getByRole("button", { name: "Extra-large text" }));
    expect(onChange).toHaveBeenLastCalledWith('<p>a<span data-size="xl">big</span></p>');

    // "Normal" unwraps instead of wrapping.
    execCommand.mockImplementation((cmd) => {
      if (cmd === "fontSize")
        el.innerHTML = '<p>a<font size="7"><span data-size="xl">big</span></font></p>';
      return true;
    });
    fireEvent.click(screen.getByRole("button", { name: "Normal text" }));
    expect(onChange).toHaveBeenLastCalledWith("<p>abig</p>");
  });

  test("paste is forced to plain text", () => {
    render(<AnnouncementRichEditor value="" onChange={() => {}} />);
    const el = editor();
    const clipboardData = {
      getData: (type: string) => (type === "text/plain" ? "plain words" : "<b>rich</b>"),
    };
    fireEvent.paste(el, { clipboardData });
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "plain words");
  });

  test("disabled editor is not editable and ignores the toolbar", () => {
    render(<AnnouncementRichEditor value="" onChange={() => {}} disabled />);
    expect(editor().getAttribute("contenteditable")).toBe("false");
    execCommand.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(execCommand.mock.calls.map((c) => c[0])).not.toContain("bold");
  });
});
