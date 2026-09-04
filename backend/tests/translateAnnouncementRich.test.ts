// translate-announcement.ts — the rich-body leg.
//
// When a notice was composed with formatting, the translator is sent the
// canonical HTML instead of the plain text and asked to translate only the
// text between the tags. Whatever comes back is UNTRUSTED (it is model output)
// and is re-canonicalised, then split into the row's body / bodyHtml pair per
// language. A language whose translation lost its tags falls back to plain.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  splitRichTranslations,
  translateAnnouncement,
  type AnnouncementTranslations,
} from "../src/lib/translate-announcement";

const RICH = '<p><b>Meeting</b></p><ol><li>Bring the file</li></ol>';

function claudeReply(body: Record<string, { title: string; body: string }>) {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(body) }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitRichTranslations", () => {
  test("re-canonicalises model html and derives the plain shadow per language", () => {
    const parsed: AnnouncementTranslations = {
      en: { title: "Meeting", body: RICH },
      ms: {
        title: "Mesyuarat",
        body: '<p><strong>Mesyuarat</strong></p><ol><li>Bawa fail<script>x</script></li></ol>',
      },
      zh: { title: "会议", body: "会议\n1. 带文件" }, // tags lost → plain only
      bn: { title: "সভা", body: "" },
    };
    const out = splitRichTranslations(parsed);
    expect(out.en).toEqual({ title: "Meeting", body: "Meeting\n1. Bring the file", bodyHtml: RICH });
    expect(out.ms).toEqual({
      title: "Mesyuarat",
      body: "Mesyuarat\n1. Bawa fail",
      bodyHtml: "<p><b>Mesyuarat</b></p><ol><li>Bawa fail</li></ol>",
    });
    expect(out.zh).toEqual({ title: "会议", body: "会议\n1. 带文件" });
    expect(out.bn).toEqual({ title: "সভা", body: "" });
  });
});

describe("translateAnnouncement with bodyHtml", () => {
  test("sends the html as the body and splits the reply", async () => {
    let sent: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return claudeReply({
          en: { title: "Meeting", body: RICH },
          ms: { title: "Mesyuarat", body: '<p><b>Mesyuarat</b></p><ol><li>Bawa fail</li></ol>' },
          zh: { title: "会议", body: "<p><b>会议</b></p><ol><li>带文件</li></ol>" },
          bn: { title: "সভা", body: "<p><b>সভা</b></p><ol><li>ফাইল আনুন</li></ol>" },
        });
      }),
    );
    const out = await translateAnnouncement({
      title: "Meeting",
      body: "Meeting\n1. Bring the file",
      bodyHtml: RICH,
      apiKey: "k",
    });
    const userText = (sent as { messages: Array<{ content: Array<{ text: string }> }> })
      .messages[0].content[0].text;
    expect(userText).toContain(JSON.stringify({ title: "Meeting", body: RICH }));
    expect(out?.zh).toEqual({
      title: "会议",
      body: "会议\n1. 带文件",
      bodyHtml: "<p><b>会议</b></p><ol><li>带文件</li></ol>",
    });
  });

  test("without bodyHtml the plain contract is unchanged (no bodyHtml key)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        claudeReply({
          en: { title: "T", body: "B" },
          ms: { title: "T", body: "B" },
          zh: { title: "T", body: "B" },
          bn: { title: "T", body: "B" },
        }),
      ),
    );
    const out = await translateAnnouncement({ title: "T", body: "B", apiKey: "k" });
    expect(out?.en).toEqual({ title: "T", body: "B" });
    expect("bodyHtml" in (out?.en ?? {})).toBe(false);
  });
});
