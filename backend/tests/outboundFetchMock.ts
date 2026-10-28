import { expect, vi } from "vitest";

type FetchSpy = ReturnType<typeof vi.spyOn>;

/**
 * Vitest Pool Workers 0.18 removed the old Undici `fetchMock` export.  This
 * small fail-closed replacement follows Cloudflare's current guidance: mock
 * `globalThis.fetch` in the test isolate and reject every unregistered call.
 */
export function createOutboundFetchMock() {
  const pending: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`Unexpected outbound fetch: ${String(input)}`);
  }) as FetchSpy;

  return {
    replyOnce(url: string, method: string, status: number, body: unknown) {
      const label = `${method.toUpperCase()} ${url}`;
      pending.push(label);
      spy.mockImplementationOnce(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(url);
        expect(request.method).toBe(method.toUpperCase());
        pending.splice(pending.indexOf(label), 1);
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        return new Response(payload, {
          status,
          headers: { "content-type": "application/json" },
        });
      });
    },
    assertDone() {
      try {
        expect(pending).toEqual([]);
      } finally {
        // Teardown must restore fetch even when the pending-call assertion
        // fails, otherwise one failed test poisons every later test in-file.
        spy.mockRestore();
      }
    },
  };
}
