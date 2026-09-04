import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AnnouncementRichBody } from "./AnnouncementRichBody";

afterEach(cleanup);

describe("AnnouncementRichBody", () => {
  test("plain notice (no html) keeps the whitespace-preserving text path", () => {
    const { container } = render(<AnnouncementRichBody text={"line one\nline two"} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("whitespace-pre-wrap");
    expect(el.textContent).toBe("line one\nline two");
    expect(container.querySelector(".ann-rich")).toBeNull();
  });

  test("rich notice renders the canonical fragment inside .ann-rich", () => {
    const { container } = render(
      <AnnouncementRichBody
        text="ignored"
        html={'<p><b>Bold</b></p><ol><li><span data-size="xl">One</span></li></ol>'}
      />,
    );
    const el = container.querySelector(".ann-rich") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.querySelector("b")?.textContent).toBe("Bold");
    expect(el.querySelector("ol > li > span[data-size='xl']")?.textContent).toBe("One");
  });

  test("re-sanitises on render: hostile html never reaches the DOM", () => {
    const { container } = render(
      <AnnouncementRichBody
        text=""
        html={'<p>ok<script>window.x=1</script><img src=x onerror="window.y=1"></p>'}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("ok");
  });

  test("empty text and no html renders nothing", () => {
    const { container } = render(<AnnouncementRichBody text="" html={null} />);
    expect(container.firstChild).toBeNull();
  });
});
