import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AnnouncementRichEditor,
  TABLE_TEMPLATE,
  normalizeLinkHref,
} from "./AnnouncementRichEditor";

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

  // ---- 2026-09-05 toolbar follow-up

  test("heading buttons drive formatBlock, and the active heading toggles back to a paragraph", () => {
    const onChange = vi.fn();
    render(<AnnouncementRichEditor value="<p>t</p>" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Heading 1" }));
    expect(execCommand).toHaveBeenCalledWith("formatBlock", false, "<h1>");
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    expect(execCommand).toHaveBeenCalledWith("formatBlock", false, "<h2>");
    // Put the caret inside an h2 and click H2 again → back to <p>.
    const el = editor();
    el.innerHTML = "<h2>head</h2>";
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("h2")!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    execCommand.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    expect(execCommand).toHaveBeenCalledWith("formatBlock", false, "<p>");
  });

  test("highlight folds the browser's styled span into <mark>, and toggles off inside one", () => {
    const onChange = vi.fn();
    render(<AnnouncementRichEditor value="" onChange={onChange} />);
    const el = editor();
    execCommand.mockImplementation((cmd) => {
      if (cmd === "hiliteColor")
        el.innerHTML = '<p>a<span style="background-color: rgb(243, 236, 224);">hi</span>b</p>';
      return true;
    });
    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    expect(onChange).toHaveBeenLastCalledWith("<p>a<mark>hi</mark>b</p>");

    // Caret inside the mark → the click removes it.
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("mark")!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    execCommand.mockImplementation(() => true);
    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    expect(onChange).toHaveBeenLastCalledWith("<p>ahib</p>");
  });

  test("highlight at a caret beside an emptied mark unwraps it instead of styling", () => {
    const onChange = vi.fn();
    render(<AnnouncementRichEditor value="<p>a</p>" onChange={onChange} />);
    const el = editor();
    el.focus();
    el.innerHTML = "<p>a</p><p><mark><br></mark></p>";
    const p2 = el.querySelectorAll("p")[1];
    const range = document.createRange();
    range.setStart(p2, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    execCommand.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    expect(execCommand.mock.calls.map((c) => c[0])).not.toContain("hiliteColor");
    expect(el.querySelector("mark")).toBeNull();
  });

  test("Link is offered only with a prompt; a typed address is normalised before createLink", async () => {
    const { unmount } = render(<AnnouncementRichEditor value="" onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    unmount();

    const onChange = vi.fn();
    const onPromptLink = vi.fn(async () => "houzs.my/sop");
    render(<AnnouncementRichEditor value="<p>read this</p>" onChange={onChange} onPromptLink={onPromptLink} />);
    const el = editor();
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("p")!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(execCommand).toHaveBeenCalledWith("createLink", false, "https://houzs.my/sop"),
    );

    // A refused target never reaches the browser command.
    execCommand.mockClear();
    onPromptLink.mockImplementation(async () => "javascript:alert(1)");
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onPromptLink).toHaveBeenCalledTimes(2));
    expect(execCommand.mock.calls.map((c) => c[0])).not.toContain("createLink");
    expect(execCommand.mock.calls.map((c) => c[0])).not.toContain("insertHTML");
  });

  test("table inserts the canonical starter through insertHTML", () => {
    render(<AnnouncementRichEditor value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    expect(execCommand).toHaveBeenCalledWith("insertHTML", false, TABLE_TEMPLATE);
  });

  test("image: the picked file goes through onInsertImage and only the KEY is emitted", async () => {
    const onChange = vi.fn();
    const onInsertImage = vi.fn(async () => ({
      key: "announcements/compose/1725500000000-0badf00d.jpg",
      src: "blob:local",
    }));
    render(<AnnouncementRichEditor value="" onChange={onChange} onInsertImage={onInsertImage} />);
    const el = editor();
    execCommand.mockImplementation((cmd, _ui, arg) => {
      if (cmd === "insertHTML") el.innerHTML = "<p>x</p>" + (arg ?? "");
      return true;
    });
    const input = screen.getByLabelText("Image file") as HTMLInputElement;
    const file = new File(["img"], "a.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onInsertImage).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        '<p>x</p><img data-att="announcements/compose/1725500000000-0badf00d.jpg">',
      ),
    );
    // The DOM keeps the local src for the author to see; the value never does.
    expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:local");
  });

  test("an incoming value's images are hydrated through imageSrc", () => {
    const key = "announcements/compose/1725500000000-0badf00d.jpg";
    render(
      <AnnouncementRichEditor
        value={`<p>a</p><img data-att="${key}">`}
        onChange={() => {}}
        imageSrc={(k) => (k === key ? "blob:preview" : undefined)}
      />,
    );
    expect(editor().querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  });

  test("Clear removes marks, links and sizes touching the selection", () => {
    const onChange = vi.fn();
    render(
      <AnnouncementRichEditor
        value={'<p><mark>a</mark> <a href="https://a.b" rel="noopener noreferrer" target="_blank">b</a> <span data-size="xl">c</span></p>'}
        onChange={onChange}
      />,
    );
    const el = editor();
    // Focus first: jsdom (like a browser) parks the caret at the start on the
    // FIRST focus of an editing host; a real author has already clicked in.
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("p")!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "Clear formatting" }));
    expect(execCommand).toHaveBeenCalledWith("removeFormat", false, undefined);
    expect(onChange).toHaveBeenLastCalledWith("<p>a b c</p>");
  });

  test("disabled editor is not editable and ignores the toolbar", () => {
    render(<AnnouncementRichEditor value="" onChange={() => {}} disabled />);
    expect(editor().getAttribute("contenteditable")).toBe("false");
    execCommand.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(execCommand.mock.calls.map((c) => c[0])).not.toContain("bold");
  });
});

describe("normalizeLinkHref", () => {
  test("accepts web and mail targets, fills in the scheme, refuses the rest", () => {
    expect(normalizeLinkHref(" https://a.b/c?x=1 ")).toBe("https://a.b/c?x=1");
    expect(normalizeLinkHref("http://a.b")).toBe("http://a.b");
    expect(normalizeLinkHref("houzs.my/sop")).toBe("https://houzs.my/sop");
    expect(normalizeLinkHref("intranet.houzs.my:8080/x")).toBe("https://intranet.houzs.my:8080/x");
    expect(normalizeLinkHref("hello@houzs.my")).toBe("mailto:hello@houzs.my");
    expect(normalizeLinkHref("mailto:hello@houzs.my")).toBe("mailto:hello@houzs.my");
    for (const bad of [
      "",
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://a.b",
      "just words",
      "a b.com",
      "mailto:nope",
      'https://a.b/"x',
    ]) {
      expect(normalizeLinkHref(bad)).toBeNull();
    }
  });
});
