// translate-announcement.ts — every model attempt is bounded (2026-09-06).
//
// The four-language call used to run with no timeout at all, on the request
// path. It now runs in the background, and each attempt carries an
// AbortSignal.timeout so a stuck socket cannot pin the job for as long as
// the platform allows. An aborted attempt rejects, which the existing catch
// turns into the null "no translation" outcome — never a throw.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  TRANSLATE_ATTEMPT_TIMEOUT_MS,
  translateAnnouncement,
} from "../src/lib/translate-announcement";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("translateAnnouncement attempt timeout", () => {
  test("each attempt carries an abort signal", async () => {
    const signals: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal);
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  en: { title: "T", body: "B" },
                  ms: { title: "T", body: "B" },
                  zh: { title: "T", body: "B" },
                  bn: { title: "T", body: "B" },
                }),
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const out = await translateAnnouncement({ title: "T", body: "B", apiKey: "k" });
    expect(out?.en.title).toBe("T");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(TRANSLATE_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("an aborted attempt yields null instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    await expect(
      translateAnnouncement({ title: "T", body: "B", apiKey: "k" }),
    ).resolves.toBeNull();
  });
});
