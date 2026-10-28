import { beforeEach, describe, expect, test, vi } from "vitest";
import { readRememberedEmail, writeRememberedEmail } from "./rememberedEmail";

describe("remembered login email", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  test.each(["auth:lastEmail", "houzs_remember_email"])("migrates legacy key %s", (key) => {
    localStorage.setItem(key, " user@example.com ");
    expect(readRememberedEmail()).toBe("user@example.com");
    expect(localStorage.getItem(key)).toBeNull();
    expect(readRememberedEmail()).toBe("user@example.com");
  });

  test("uses one shared key for desktop and mobile and clears legacy values", () => {
    localStorage.setItem("auth:lastEmail", "old@example.com");
    writeRememberedEmail(" new@example.com ");
    expect(readRememberedEmail()).toBe("new@example.com");
    writeRememberedEmail(null);
    expect(readRememberedEmail()).toBe("");
  });
});
