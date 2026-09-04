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
  richTextToPlain,
  sanitizeAnnouncementHtml,
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
    ).toBe("<p>para</p><p>head</p><b>b</b><i>i</i><s>s</s>");
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
});

describe("hasRichFormatting", () => {
  test("plain paragraphs are not rich; any mark or list is", () => {
    expect(hasRichFormatting("<p>a</p><p>b<br>c</p>")).toBe(false);
    expect(hasRichFormatting("<p><b>a</b></p>")).toBe(true);
    expect(hasRichFormatting("<ol><li>a</li></ol>")).toBe(true);
    expect(hasRichFormatting('<span data-size="sm">a</span>')).toBe(true);
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
});
