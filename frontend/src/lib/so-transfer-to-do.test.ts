import { describe, expect, it } from "vitest";
import { soOffersTransferToDo } from "./so-transfer-to-do";

describe("soOffersTransferToDo", () => {
  it("offers it on a live order with something left to deliver", () => {
    expect(soOffersTransferToDo({ status: "CONFIRMED", on_hold: false, has_undelivered: true })).toBe(true);
  });

  /* Conts #699: the fully delivered order that opened an empty DO form. */
  it("does not offer it when nothing is left to deliver", () => {
    expect(soOffersTransferToDo({ status: "DELIVERED", on_hold: false, has_undelivered: false })).toBe(false);
    expect(soOffersTransferToDo({ status: "CONFIRMED", on_hold: false, has_undelivered: false })).toBe(false);
  });

  it("a DELIVERED order with goods returned (remainder re-opened) is offered again", () => {
    expect(soOffersTransferToDo({ status: "DELIVERED", on_hold: false, has_undelivered: true })).toBe(true);
  });

  it("a row without the field (older worker) keeps the status rule alone", () => {
    expect(soOffersTransferToDo({ status: "CONFIRMED", on_hold: false })).toBe(true);
  });

  it("the status rule still refuses drafts, cancelled, closed and held orders", () => {
    for (const status of ["DRAFT", "CANCELLED", "CLOSED", "ON_HOLD"]) {
      expect(soOffersTransferToDo({ status, on_hold: false, has_undelivered: true })).toBe(false);
    }
    expect(soOffersTransferToDo({ status: "CONFIRMED", on_hold: true, has_undelivered: true })).toBe(false);
  });
});
