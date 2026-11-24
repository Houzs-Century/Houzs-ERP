// Meeting emails through this ERP's Mail Center (services/meetingMail.ts): collect from the hub with the
// company's key, send each one, report each result. The hub is faked; what matters is what leaves the Worker.
import { afterEach, describe, expect, test, vi } from "vitest";
import { collectAndSend, sendAllMeetingMail, type HubMail } from "../src/services/meetingMail";

type Call = { url: string; auth: string | null; reporter: string | null; body: unknown };
function fakeHub(mail: HubMail[], claimStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    calls.push({ url: String(url), auth: h.get("Authorization"), reporter: h.get("X-Reporter-Id"), body: init.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith("/mail/claim")) return new Response(JSON.stringify({ mail }), { status: claimStatus });
    return new Response(JSON.stringify({ ok: true, updated: 1 }), { status: 200 });
  });
  return calls;
}
const MAIL: HubMail = { id: 7, from: "Houzs Meetings <hello@houzscentury.com>", to: ["hana@example.com"], subject: "Invitation: Weekly", html: "<table></table>", text: "Weekly" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("meeting emails through the Mail Center", () => {
  test("collects with the company's key, sends each, and reports sent", async () => {
    const calls = fakeHub([MAIL]);
    const sent: HubMail[] = [];
    const r = await collectAndSend("https://hub.example", "hub_hc_key", async (m) => (sent.push(m), null));
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([MAIL]);
    expect(calls.map((c) => c.url)).toEqual(["https://hub.example/api/v1/sys/meetings/mail/claim", "https://hub.example/api/v1/sys/meetings/mail/results"]);
    expect(calls[0].auth).toBe("Bearer hub_hc_key");
    expect(calls[0].reporter).toBe("mail");
    expect(calls[1].body).toEqual({ results: [{ id: 7, error: null }] });
  });

  test("a send that fails or throws is reported with its reason, and the rest still go", async () => {
    const calls = fakeHub([MAIL, { ...MAIL, id: 8 }, { ...MAIL, id: 9 }]);
    const r = await collectAndSend("https://hub.example", "k", async (m) => {
      if (m.id === 7) return "channel disabled";
      if (m.id === 8) throw new Error("Resend answered 403");
      return null;
    });
    expect(r).toEqual({ sent: 1, failed: 2 });
    expect(calls[1].body).toEqual({ results: [{ id: 7, error: "channel disabled" }, { id: 8, error: "Resend answered 403" }, { id: 9, error: null }] });
  });

  test("nothing waiting: no report call", async () => {
    const calls = fakeHub([]);
    expect(await collectAndSend("https://hub.example", "k", async () => null)).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  test("the hub refusing the claim is an error, not a silent zero", async () => {
    fakeHub([], 401);
    await expect(collectAndSend("https://hub.example", "k", async () => null)).rejects.toThrow("401");
  });

  test("the cron asks once per company that has a hub key, and skips when meetings is not connected", async () => {
    const calls = fakeHub([]);
    await sendAllMeetingMail({ IT_HUB_URL: "https://hub.example/", IT_HUB_API_KEY_HOUZS: "hub_hc_key", IT_HUB_API_KEY_2990: "hub_2990_key", OTHER: "x" } as never);
    expect(calls.map((c) => c.auth).sort()).toEqual(["Bearer hub_2990_key", "Bearer hub_hc_key"]);
    const none = fakeHub([]);
    await sendAllMeetingMail({ IT_HUB_API_KEY_HOUZS: "hub_hc_key" } as never);
    expect(none).toHaveLength(0);
  });
});
