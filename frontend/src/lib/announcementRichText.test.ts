// The announcement rich-body canonicaliser (lib/announcementRichText.ts).
//
// The renderer hands the stored HTML to innerHTML, so the ONLY thing standing
// between a hostile POST body and every reader's browser is this module. The
// fixtures below are the contract: what survives, what is folded, what is
// dropped whole, and that the plain-text shadow keeps list numbering. The
// backend twin (backend/tests/announcementRichText.test.ts) pins the SAME
// fixtures so the two copies cannot drift apart silently.
import { describe, expect, test } from "vitest";
import {
  hasRichFormatting,
  inlineImageKeys,
  richTextToPlain,
  sanitizeAnnouncementHtml,
  stripUnreferencedImages,
} from "./announcementRichText";

describe("sanitizeAnnouncementHtml", () => {
  test("keeps the allowed grammar verbatim", () => {
    const html =
      '<p>Hello <b>bold</b> <i>it</i> <u>u</u> <s>gone</s></p><ol><li>one</li><li><span data-size="xl">two</span></li></ol><ul><li>dot</li></ul>';
    expect(sanitizeAnnouncementHtml(html)).toBe(html);
  });

  test("is idempotent", () => {
    const once = sanitizeAnnouncementHtml(
      '<div>a<strong>b</strong><br><font size="7">c</font></div>',
    );
    expect(sanitizeAnnouncementHtml(once)).toBe(once);
  });

  test("folds browser spellings onto the canonical tags", () => {
    expect(
      sanitizeAnnouncementHtml(
        "<div>para</div><h2>head</h2><strong>b</strong><em>i</em><strike>s</strike>",
      ),
    ).toBe("<p>para</p><h2>head</h2><b>b</b><i>i</i><s>s</s>");
  });

  test("numeric point sizes are kept; a number off the list, or padded, is dropped", () => {
    expect(
      sanitizeAnnouncementHtml(
        '<span data-size="16">a</span><span data-size="36">b</span><span data-size="15">c</span><span data-size="16px">d</span><span data-size="999">e</span>',
      ),
    ).toBe('<span data-size="16">a</span><span data-size="36">b</span>cde');
  });

  test("drops every attribute except a valid data-size", () => {
    expect(
      sanitizeAnnouncementHtml(
        '<p style="color:red" onclick="x()">a</p><span data-size="lg" style="font-size:80px">b</span><span data-size="huge">c</span><span class="x">d</span>',
      ),
    ).toBe('<p>a</p><span data-size="lg">b</span>cd');
  });

  test("drops script/style WITH their contents, and unknown tags without", () => {
    expect(
      sanitizeAnnouncementHtml(
        '<p>x<script>alert(1)</script><style>p{}</style><img src=x onerror=alert(1)><a href="javascript:alert(1)">link</a></p>',
      ),
    ).toBe("<p>xlink</p>");
    expect(sanitizeAnnouncementHtml("<iframe src=x>")).toBe("");
  });

  test("escapes stray angle brackets and bare ampersands, keeps known entities", () => {
    expect(sanitizeAnnouncementHtml("a < b > c & d &amp; &nbsp; &#169; &#x1F600;")).toBe(
      "a &lt; b &gt; c &amp; d &amp; &nbsp; &#169; &#x1F600;",
    );
  });

  test("balances open tags and ignores orphan closes", () => {
    expect(sanitizeAnnouncementHtml("<b>a<i>b")).toBe("<b>a<i>b</i></b>");
    expect(sanitizeAnnouncementHtml("a</b></p>b")).toBe("ab");
    expect(sanitizeAnnouncementHtml("<ol><li>a<li>b</ol>")).toBe(
      "<ol><li>a</li><li>b</li></ol>",
    );
  });

  test("a duplicate inline mark is swallowed, its close eaten", () => {
    expect(sanitizeAnnouncementHtml("<b>a<b>b</b>c</b>")).toBe("<b>abc</b>");
  });

  test("a transparent span's close does not close a sized ancestor", () => {
    expect(
      sanitizeAnnouncementHtml('<span data-size="lg">a<span>b</span>c</span>'),
    ).toBe('<span data-size="lg">abc</span>');
  });

  test("a stray <li> outside a list is a paragraph; nested lists stay", () => {
    expect(sanitizeAnnouncementHtml("<li>x</li>")).toBe("<p>x</p>");
    expect(
      sanitizeAnnouncementHtml("<ul><li>a<ul><li>b</li></ul></li></ul>"),
    ).toBe("<ul><li>a<ul><li>b</li></ul></li></ul>");
  });

  test("a list opened inside a paragraph closes the paragraph first", () => {
    expect(sanitizeAnnouncementHtml("<p>a<ul><li>b</li></ul>")).toBe(
      "<p>a</p><ul><li>b</li></ul>",
    );
  });

  test("comments vanish, trailing blank paragraphs are trimmed", () => {
    expect(sanitizeAnnouncementHtml("<p>a</p><!-- hi --><p><br></p><p></p>")).toBe(
      "<p>a</p>",
    );
  });

  test("non-strings and empty input yield an empty string", () => {
    expect(sanitizeAnnouncementHtml(null)).toBe("");
    expect(sanitizeAnnouncementHtml(42)).toBe("");
    expect(sanitizeAnnouncementHtml("")).toBe("");
  });

  // ---- 2026-09-05 toolbar follow-up: headings, highlight, link, table, image

  test("keeps h1 / h2 / mark / a / table / img in canonical form", () => {
    const html =
      '<h1>Title</h1><h2>Sub</h2><p><mark>hi</mark> <a href="https://houzs.my/x?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">link</a></p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><img data-att="announcements/ann-1/1725500000000-0badf00d.png">';
    expect(sanitizeAnnouncementHtml(html)).toBe(html);
    expect(sanitizeAnnouncementHtml(sanitizeAnnouncementHtml(html))).toBe(html);
  });

  test("h3-h6 fold to h2; a heading closes an open paragraph and vice versa", () => {
    expect(sanitizeAnnouncementHtml("<h3>a</h3><h6>b</h6>")).toBe("<h2>a</h2><h2>b</h2>");
    expect(sanitizeAnnouncementHtml("<p>x<h1>y</h1>z")).toBe("<p>x</p><h1>y</h1>z");
    expect(sanitizeAnnouncementHtml("<h2>x<p>y</p>")).toBe("<h2>x</h2><p>y</p>");
  });

  test("a link survives only with an http(s) / mailto target, and never nests", () => {
    expect(sanitizeAnnouncementHtml('<a href="http://a.b/c">t</a>')).toBe(
      '<a href="http://a.b/c" rel="noopener noreferrer" target="_blank">t</a>',
    );
    expect(sanitizeAnnouncementHtml("<a href='mailto:hi@houzs.my'>m</a>")).toBe(
      '<a href="mailto:hi@houzs.my" rel="noopener noreferrer" target="_blank">m</a>',
    );
    // scheme tricks: javascript:, data:, protocol-relative, whitespace, entities
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "/relative",
      "&#106;avascript:alert(1)",
      "http://a.b/\tx",
      "",
    ]) {
      expect(sanitizeAnnouncementHtml(`<a href="${bad}">t</a>`)).toBe("t");
    }
    expect(
      sanitizeAnnouncementHtml('<a href="https://a.b" onclick="x" target="_top" rel="x">t</a>'),
    ).toBe('<a href="https://a.b" rel="noopener noreferrer" target="_blank">t</a>');
    expect(
      sanitizeAnnouncementHtml('<a href="https://a.b">x<a href="https://c.d">y</a>z</a>'),
    ).toBe('<a href="https://a.b" rel="noopener noreferrer" target="_blank">xyz</a>');
    // a rejected link's close tag does not close a real one around it
    expect(sanitizeAnnouncementHtml('<a href="https://a.b">x<a href="bad">y</a>z</a>')).toBe(
      '<a href="https://a.b" rel="noopener noreferrer" target="_blank">xyz</a>',
    );
  });

  test("an image survives only as an attachment key; src and URLs never do", () => {
    const key = "announcements/ann-6069c770b8f/1725500000000-0badf00d.jpg";
    expect(
      sanitizeAnnouncementHtml(
        `<img src="https://x/y.png" data-att="${key}" onerror="alert(1)">`,
      ),
    ).toBe(`<img data-att="${key}">`);
    expect(sanitizeAnnouncementHtml('<img src="https://x/y.png">')).toBe("");
    expect(sanitizeAnnouncementHtml('<img data-att="../../etc/passwd">')).toBe("");
    expect(sanitizeAnnouncementHtml('<img data-att="announcements/a/1-0badf00d.exe">')).toBe("");
    expect(
      sanitizeAnnouncementHtml('<img data-att="products/a/1725500000000-0badf00d.jpg">'),
    ).toBe("");
    expect(sanitizeAnnouncementHtml(`<p>a<img data-att="${key}"/>b</p>`)).toBe(
      `<p>a<img data-att="${key}">b</p>`,
    );
  });

  test("table structure is normalised: thead/tbody vanish, stray cells / rows do not create tables", () => {
    expect(
      sanitizeAnnouncementHtml(
        '<table border="1"><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
      ),
    ).toBe("<table><tr><th>h</th></tr><tr><td>c</td></tr></table>");
    expect(sanitizeAnnouncementHtml("<tr><td>x</td></tr>")).toBe("x");
    expect(sanitizeAnnouncementHtml("<table><td>x</td></table>")).toBe("<table>x</table>");
    // unclosed cells and rows are balanced by the next sibling
    expect(sanitizeAnnouncementHtml("<table><tr><td>a<td>b<tr><td>c</table>")).toBe(
      "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>",
    );
    // a paragraph inside a cell belongs to the cell; a table inside a paragraph closes it
    expect(
      sanitizeAnnouncementHtml("<table><tr><td><p>a</p><p>b</p></td></tr></table>"),
    ).toBe("<table><tr><td><p>a</p><p>b</p></td></tr></table>");
    expect(sanitizeAnnouncementHtml("<p>x<table><tr><td>y</td></tr></table>")).toBe(
      "<p>x</p><table><tr><td>y</td></tr></table>",
    );
  });

  test("an empty inline element is unwrapped; a <br> inside it survives", () => {
    expect(sanitizeAnnouncementHtml("<p><mark><br></mark></p><p>x</p>")).toBe("<p><br></p><p>x</p>");
    expect(sanitizeAnnouncementHtml("<p>a<b></b>b<span data-size=\"xl\"></span></p>")).toBe("<p>ab</p>");
    expect(sanitizeAnnouncementHtml("<p><b><i></i></b>c</p>")).toBe("<p>c</p>");
    expect(sanitizeAnnouncementHtml('<p><a href="https://a.b"></a>c</p>')).toBe("<p>c</p>");
    expect(sanitizeAnnouncementHtml("<p><mark> </mark></p>")).toBe("<p><mark> </mark></p>");
  });

  test("mark behaves like the other inline marks", () => {
    expect(sanitizeAnnouncementHtml("<mark>a<mark>b</mark>c</mark>")).toBe("<mark>abc</mark>");
    expect(sanitizeAnnouncementHtml('<mark style="background:red">a</mark>')).toBe(
      "<mark>a</mark>",
    );
  });
});

describe("inlineImageKeys / stripUnreferencedImages", () => {
  const k1 = "announcements/ann-1/1725500000000-0badf00d.png";
  const k2 = "announcements/ann-1/1725500000001-deadbeef.jpg";
  const html = `<p>a</p><img data-att="${k1}"><p>b<img data-att="${k2}"></p>`;

  test("lists every referenced key in order", () => {
    expect(inlineImageKeys(html)).toEqual([k1, k2]);
    expect(inlineImageKeys("<p>none</p>")).toEqual([]);
  });

  test("drops images outside the allowed manifest, keeps the rest untouched", () => {
    expect(stripUnreferencedImages(html, [k1])).toBe(
      `<p>a</p><img data-att="${k1}"><p>b</p>`,
    );
    expect(stripUnreferencedImages(html, [])).toBe("<p>a</p><p>b</p>");
    expect(stripUnreferencedImages(html, [k1, k2])).toBe(html);
  });
});

describe("hasRichFormatting", () => {
  test("plain paragraphs are not rich; any mark or list is", () => {
    expect(hasRichFormatting("<p>a</p><p>b<br>c</p>")).toBe(false);
    expect(hasRichFormatting("<p><b>a</b></p>")).toBe(true);
    expect(hasRichFormatting("<ol><li>a</li></ol>")).toBe(true);
    expect(hasRichFormatting('<span data-size="sm">a</span>')).toBe(true);
    expect(hasRichFormatting("<h1>a</h1>")).toBe(true);
    expect(hasRichFormatting("<p><mark>a</mark></p>")).toBe(true);
    expect(
      hasRichFormatting(
        '<p><a href="https://a.b" rel="noopener noreferrer" target="_blank">a</a></p>',
      ),
    ).toBe(true);
    expect(hasRichFormatting("<table><tr><td>a</td></tr></table>")).toBe(true);
    expect(
      hasRichFormatting('<img data-att="announcements/a/1725500000000-0badf00d.png">'),
    ).toBe(true);
  });
});

describe("richTextToPlain", () => {
  test("numbers ordered items, bullets unordered, newlines per block", () => {
    expect(
      richTextToPlain(
        "<p>Intro</p><ol><li>one</li><li>two<ul><li>sub</li></ul></li></ol><p>a<br>b</p>",
      ),
    ).toBe("Intro\n1. one\n2. two\n  • sub\na\nb");
  });

  test("decodes entities and strips marks", () => {
    expect(richTextToPlain("<p><b>Tom &amp; Jerry</b> &lt;3 &#169;</p>")).toBe(
      "Tom & Jerry <3 ©",
    );
  });

  test("sanitises first, so hostile input is text-only", () => {
    expect(richTextToPlain("<script>x</script><p>ok</p>")).toBe("ok");
  });

  test("headings, tables, links and images have a plain-text shape", () => {
    expect(richTextToPlain("<h1>Head</h1><h2>Sub</h2><p>body</p>")).toBe("Head\nSub\nbody");
    expect(
      richTextToPlain(
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>after</p>",
      ),
    ).toBe("A | B\n1 | 2\nafter");
    expect(
      richTextToPlain('<p>see <a href="https://a.b/?x=1&amp;y=2">the guide</a>.</p>'),
    ).toBe("see the guide (https://a.b/?x=1&y=2).");
    expect(richTextToPlain('<p><a href="https://a.b">https://a.b</a></p>')).toBe("https://a.b");
    expect(
      richTextToPlain(
        '<p>Photo:</p><img data-att="announcements/a/1725500000000-0badf00d.png"><p><mark>note</mark></p>',
      ),
    ).toBe("Photo:\n[image]note");
  });
});
