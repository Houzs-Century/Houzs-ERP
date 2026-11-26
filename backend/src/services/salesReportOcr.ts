// Read a sales-report image (a photo or screenshot the floor pasted into the
// project chat) and return the text in the same shape as a typed report, so
// parseSalesReport counts it the same way.
//
// Owner 2026-11-25 ("if sales man upload picture of sales report can chat
// read?"): sometimes the floor snaps a photo of a handwritten tally or a
// WhatsApp screenshot from another group instead of typing the report in.
// Before this, those images sat in the chat as pictures; the parser only
// reads text, so the books never counted them. This reads the image with
// Claude vision and gives the chat composer back the text — the salesperson
// previews it, corrects anything the model misread, and sends the message
// through the same /notes path as a typed paste.
//
// Not persisted: the image is OCR'd in-flight, never stored to R2 here. The
// note that eventually posts carries the text; the image itself is not kept.
// If owner later asks for an audit trail of the original picture, that is a
// column on project_activity, not a change to this service.
import type { Env } from "../types";
import { recordAi } from "./aiUsage";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(binary);
}

const SALES_REPORT_OCR_PROMPT = `You are reading a WhatsApp sales-report message pasted into a floor-sales chat at Houzs Century. It may be a screenshot of a chat, a photo of a handwritten tally, or a scan of a printed tally. Your job is to transcribe it back to the text the sender wrote, in the format the parser expects.

Return ONLY minified JSON, no prose:
{"ok": <boolean>, "text": "<transcription or empty>", "reason": "<empty_if_ok | not_a_sales_report | unreadable>"}

The report format:
- Date header line, like "20/11 Akemi @ SCCC" (DD/MM, then brand/venue).
- Bill lines, one per bill: "N. REF RM<amount> <salesperson>". N is the bill number. REF is 1–5 letters then 3–6 digits, no space or dash between them (HC11694, ZNT6042). Amount uses comma as thousands separator (RM10,200). Salesperson is a short name (Yuny, James, CH, Melvin).
- Optional transport/disposal on a bill: "+<amount>(T)" or "+<amount>(D)" right after the main amount, before the name — keep the tag.
- A day-summary line, like "20/11 - RM12,150", for all-days postings at fair end.
- A Total line at the end of a section or the whole post: "Total: RM<amount>" (or "Total sales: RM..." or "Total jualan: RM...").

Transcribe EXACTLY what is written. Do not add bills that aren't there. Do not reword. Do not add commentary. Keep every bill, every day line, every Total line.

Clean up only:
- Replace full-width Chinese punctuation with ASCII: "：" → ":", "，" → ",", "（" → "(", "）" → ")", "、" → ",".
- If a numeral is clearly 0 but looks like O, write 0.
- If a numeral is clearly 1 but looks like l or I, write 1.
- Drop stray hand-drawn marks (underlines, boxes) that are not part of the text.

Rules:
- Set ok: false and text: "" if the image is not a sales report (a floor plan, a receipt, a product photo, a selfie, a blurry page of nothing). reason: "not_a_sales_report".
- Set ok: false and text: "" if the image is a sales report but you cannot read enough of it to be useful (half the bills unreadable, numbers obscured by shadow). reason: "unreadable".
- Otherwise ok: true and text contains the full transcription. reason: "".
- Do NOT guess digits you cannot see. If a single digit is ambiguous, leave the bill out rather than risk a wrong amount reaching books.
- Use the exact layout the sender used: date header first, bills next, Total last. One line per bill. Blank lines between day sections.

Example output text:
20/11 Akemi @ SCCC

1. HC11694 RM10,200 Yuny
2. HC13801 RM1,950 Yuny
3. HC11695 RM6,888 James

Total: RM19,038`;

export type SalesReportOcrResult =
  | { ok: false; status: 400 | 502 | 503; error: string }
  | {
      ok: true;
      text: string;
      /** The model's reason field; "" when it returned text. */
      reason: string;
    };

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function readSalesReportImage(
  env: Env,
  args: {
    buf: ArrayBuffer;
    mime: string;
    userId: number | null;
    companyId: number | null;
  },
): Promise<SalesReportOcrResult> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: "Reading sales-report images isn't configured on this server." };
  }
  const mime = (args.mime || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, status: 400, error: "Upload a JPG, PNG, WEBP or GIF image." };
  }
  if (args.buf.byteLength === 0) {
    return { ok: false, status: 400, error: "Image is empty." };
  }
  if (args.buf.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, status: 400, error: "Image is over 5MB. Please shoot or crop a smaller one." };
  }
  const b64 = arrayBufferToBase64(args.buf);
  const mediaType =
    mime === "image/png" ? "image/png" :
    mime === "image/webp" ? "image/webp" :
    mime === "image/gif" ? "image/gif" :
    "image/jpeg";

  try {
    const usage = {
      env,
      feature: "sales_report_ocr",
      model: "claude-sonnet-4-6",
      companyId: args.companyId,
      userId: args.userId,
      waitUntil: null,
    };
    const resp = await recordAi(
      usage,
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
                { type: "text", text: SALES_REPORT_OCR_PROMPT },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      }),
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("[sales-report-ocr] anthropic", resp.status, detail.slice(0, 300));
      return { ok: false, status: 502, error: "Couldn't read the image just now. Please try again." };
    }
    const data = await resp.json<{ content?: { type: string; text?: string }[] }>();
    const raw = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { ok: false, status: 502, error: "Couldn't understand the image. Please try a clearer one." };
    }
    const parsed = JSON.parse(jsonMatch[0]) as { ok?: boolean; text?: string; reason?: string };
    if (!parsed.ok || !parsed.text) {
      const reason = (parsed.reason ?? "").trim();
      const msg =
        reason === "not_a_sales_report"
          ? "The image doesn't look like a sales report. Please attach the sales-report photo or screenshot."
          : reason === "unreadable"
            ? "Too hard to read. Please shoot again in better light or crop to just the report."
            : "Couldn't read the image. Please try a clearer one.";
      return { ok: false, status: 400, error: msg };
    }
    return { ok: true, text: String(parsed.text), reason: String(parsed.reason ?? "") };
  } catch (e) {
    console.error("[sales-report-ocr] failed", e);
    return { ok: false, status: 502, error: "Couldn't read the image just now. Please try again." };
  }
}
