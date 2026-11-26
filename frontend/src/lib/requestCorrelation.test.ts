import { describe, expect, it } from "vitest";
import { correlateError, requestIdFromError } from "./requestCorrelation";

const ID = "abcdef0123456789";

describe("correlateError", () => {
  it("preserves a DOMException's name (jsdom does not make it an Error)", () => {
    const abort = new DOMException("Aborted", "AbortError");
    const correlated = correlateError(abort, ID);

    expect(correlated).toBe(abort);
    expect(correlated.name).toBe("AbortError");
    expect(requestIdFromError(correlated)).toBe(ID);
  });

  it("preserves a plain Error's identity and cause", () => {
    const cause = new Error("root");
    const original = new Error("boom", { cause });
    const correlated = correlateError(original, ID);

    expect(correlated).toBe(original);
    expect(correlated.cause).toBe(cause);
    expect(requestIdFromError(correlated)).toBe(ID);
  });

  it("still wraps a non-error throw so callers always get an Error", () => {
    const correlated = correlateError("just a string", ID);
    expect(correlated).toBeInstanceOf(Error);
    expect(correlated.message).toBe("just a string");
    expect(requestIdFromError(correlated)).toBe(ID);
  });

  it("returns the error untouched when there is no usable id", () => {
    const abort = new DOMException("Aborted", "AbortError");
    const correlated = correlateError(abort, "not a valid id!!");
    expect(correlated).toBe(abort);
    expect(requestIdFromError(correlated)).toBeUndefined();
  });
});
