import { describe, expect, it } from "vitest";
import type { DirectoryEntry } from "./RecipientPicker";
import {
  replaceTypedTerm,
  suggestRecipients,
  typedTerm,
  type KnownRecipient,
} from "./mail-recipient-suggest";

const known = (email: string, name = ""): KnownRecipient => ({ email, name, timesUsed: 1, lastUsedAt: "" });
const staff = (email: string, name: string): DirectoryEntry => ({
  key: `user:${email}`,
  userId: 1,
  name,
  email,
  position: "Clerk",
  department: "Operation",
});

describe("typedTerm", () => {
  it("returnsTheTextAfterTheLastSeparator", () => {
    expect(typedTerm("a@b.com, si")).toBe("si");
    expect(typedTerm("a@b.com; si ")).toBe("si");
    expect(typedTerm("siti")).toBe("siti");
    expect(typedTerm("a@b.com, ")).toBe("");
  });
});

describe("replaceTypedTerm", () => {
  it("swapsOnlyTheLastAddressAndLeavesRoomForTheNext", () => {
    expect(replaceTypedTerm("si", "siti@x.com")).toBe("siti@x.com, ");
    expect(replaceTypedTerm("a@b.com, si", "siti@x.com")).toBe("a@b.com, siti@x.com, ");
  });
});

describe("suggestRecipients", () => {
  it("matchesPastAddressesByEmailOrNameBeforeStaff", () => {
    const suggestions = suggestRecipients(
      "hook",
      [known("hookka@supplier.test", "Hookka Industries")],
      [staff("hook.staff@houzs.test", "Hook Staff")],
    );
    expect(suggestions.map((s) => s.email)).toEqual(["hookka@supplier.test", "hook.staff@houzs.test"]);
    expect(suggestRecipients("industries", [known("hookka@supplier.test", "Hookka Industries")], [])).toHaveLength(1);
  });

  it("putsAddressesThatStartWithTheTermFirst", () => {
    const suggestions = suggestRecipients("si", [known("mail.si@a.test"), known("siti@a.test")], []);
    expect(suggestions.map((s) => s.email)).toEqual(["siti@a.test", "mail.si@a.test"]);
  });

  it("skipsAddressesAlreadyOnTheFieldAndListsEachAddressOnce", () => {
    const suggestions = suggestRecipients(
      "siti@a.test, si",
      [known("siti@a.test"), known("simon@a.test")],
      [staff("SIMON@a.test", "Simon")],
    );
    expect(suggestions.map((s) => s.email)).toEqual(["simon@a.test"]);
  });

  it("returnsNothingWhenNothingIsTyped", () => {
    expect(suggestRecipients("a@b.com, ", [known("x@a.test")], [])).toEqual([]);
  });
});
