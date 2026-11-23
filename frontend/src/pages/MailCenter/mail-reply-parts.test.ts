/* Owner 2026-11-21: Reply all fills Cc with everyone on the last message except
   our own mailboxes; a colleague's newer reply is recognised from the server's 409. */
import { describe, expect, it } from "vitest";
import { agoLabel, alreadyRepliedFrom, replyAllCc } from "./mail-reply-parts";

describe("reply box helpers", () => {
  const last = {
    fromAddress: "kw@example.com",
    toAddresses: ["operation@houzscentury.com"],
    ccAddresses: ["Mei@example.com", "sales@houzscentury.com", "kw@example.com"],
  };

  it("Reply all adds the others once, never us or whoever is already on To", () => {
    expect(replyAllCc(last, "kw@example.com", ["operation@houzscentury.com", "sales@houzscentury.com"])).toBe("Mei@example.com");
    expect(replyAllCc(last, "someone@else.com", ["OPERATION@houzscentury.com"])).toBe("kw@example.com, Mei@example.com, sales@houzscentury.com");
    expect(replyAllCc(null, "kw@example.com", [])).toBe("");
  });

  it("reads the already-replied 409 and nothing else", () => {
    const body = JSON.stringify({ code: "already_replied", by: "Ain", at: "2026-11-21T04:00:00Z" });
    expect(alreadyRepliedFrom({ status: 409, rawBody: body })).toEqual({ by: "Ain", at: "2026-11-21T04:00:00Z" });
    expect(alreadyRepliedFrom({ status: 400, rawBody: body })).toBeNull();
    expect(alreadyRepliedFrom({ status: 409, rawBody: "{}" })).toBeNull();
    expect(alreadyRepliedFrom(new Error("network"))).toBeNull();
  });

  it("says how long ago in words", () => {
    const now = Date.parse("2026-11-21T04:05:00Z");
    expect(agoLabel("2026-11-21T04:05:00Z", now)).toBe("just now");
    expect(agoLabel("2026-11-21T04:04:00Z", now)).toBe("1 minute ago");
    expect(agoLabel("2026-11-21T04:03:00Z", now)).toBe("2 minutes ago");
    expect(agoLabel("2026-11-21T02:05:00Z", now)).toBe("2 hours ago");
  });
});
