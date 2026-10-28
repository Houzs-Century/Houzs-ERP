// parseBulkEmails — the bulk-invite paste parser (owner 2026-08-26). The server
// does the authoritative validation; this only decides which tokens enter the
// send loop and the visible count, so the rules that matter are: it accepts the
// separators people actually paste, it survives "Name <addr>", and it never
// sends the same address (or an obvious non-email) twice.
import { describe, expect, it } from "vitest";
import { parseBulkEmails } from "./TeamInviteModal";

describe("parseBulkEmails", () => {
  it("splits on newlines, commas, semicolons and spaces", () => {
    expect(parseBulkEmails("a@x.my\nb@x.my, c@x.my; d@x.my e@x.my")).toEqual([
      "a@x.my",
      "b@x.my",
      "c@x.my",
      "d@x.my",
      "e@x.my",
    ]);
  });

  it("lower-cases and dedupes (case-insensitively)", () => {
    expect(parseBulkEmails("Sam@X.my\nsam@x.my\nSAM@X.MY")).toEqual(["sam@x.my"]);
  });

  it("extracts the address from a \"Name <addr>\" token", () => {
    expect(parseBulkEmails("Nico Tan <nico@houzscentury.com>")).toEqual([
      "nico@houzscentury.com",
    ]);
  });

  it("drops tokens that are not plausibly emails", () => {
    expect(parseBulkEmails("good@x.my\nnot-an-email\n@nope\nalso@nope\nfine@y.com")).toEqual([
      "good@x.my",
      "fine@y.com",
    ]);
  });

  it("is empty for blank / separator-only input", () => {
    expect(parseBulkEmails("")).toEqual([]);
    expect(parseBulkEmails("  ,\n; \t ")).toEqual([]);
  });
});
