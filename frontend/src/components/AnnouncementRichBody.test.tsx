import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnnouncementRichBody } from "./AnnouncementRichBody";

const fetchBlobUrl = vi.fn<(path: string) => Promise<string>>();
vi.mock("../api/client", () => ({ api: { fetchBlobUrl: (p: string) => fetchBlobUrl(p) } }));

beforeEach(() => {
  fetchBlobUrl.mockReset();
  if (!("revokeObjectURL" in URL)) {
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
  }
});
afterEach(cleanup);

const KEY = "announcements/ann-1/1725500000000-0badf00d.png";

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

  test("an inline image streams from the notice's attachment route, full size", async () => {
    fetchBlobUrl.mockResolvedValue("blob:served");
    const { container } = render(
      <AnnouncementRichBody text="" annId="ann-1" html={`<p>a</p><img data-att="${KEY}">`} />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("data-att")).toBe(KEY);
    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:served"));
    expect(fetchBlobUrl).toHaveBeenCalledWith(`/api/announcements/ann-1/attachments/${KEY}`);
    expect(fetchBlobUrl).toHaveBeenCalledTimes(1); // no .thumb probe
  });

  test("imageSrc (composer preview) wins over the route; no annId = no fetch", async () => {
    const { container } = render(
      <AnnouncementRichBody
        text=""
        html={`<img data-att="${KEY}">`}
        imageSrc={(k) => (k === KEY ? "blob:local" : undefined)}
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:local");
    expect(fetchBlobUrl).not.toHaveBeenCalled();
  });

  test("a key the route refuses leaves the text intact and the image marked missing", async () => {
    fetchBlobUrl.mockRejectedValue(new Error("404"));
    const { container } = render(
      <AnnouncementRichBody text="" annId="ann-1" html={`<p>ok</p><img data-att="${KEY}">`} />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("data-missing")).toBe("true"),
    );
    expect(container.textContent).toBe("ok");
  });

  test("links come out with the constant rel / target the grammar pins", () => {
    const { container } = render(
      <AnnouncementRichBody text="" html={'<p><a href="https://a.b">x</a></p>'} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  test("empty text and no html renders nothing", () => {
    const { container } = render(<AnnouncementRichBody text="" html={null} />);
    expect(container.firstChild).toBeNull();
  });
});
