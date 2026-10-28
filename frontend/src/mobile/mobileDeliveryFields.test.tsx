// ---------------------------------------------------------------------------
// mobileDeliveryFields — the mobile "Delivery details" card's PATCH builder.
//
// WHY A PURE HELPER IS THE THING UNDER TEST
// The desktop drawer (vendor/scm/components/DeliveryFieldsDrawer.tsx) decides
// three things before it ever calls the API: which keys go in the body, whether
// the DO-execution group is even eligible, and whether the Replacement /
// Disposal change must be diverted into an SO Amendment instead of the direct
// PATCH. Mobile had none of that — it sent the 8 DO-execution keys and nothing
// else. Reproducing the decision inside a component would make it testable only
// through a render; extracting it makes the RULE itself assertable, which is
// what actually has to match desktop.
//
// THE ROUTING THAT MATTERS
// backend/src/scm/routes/delivery-planning.ts returns 409 `so_locked_processing`
// for a GENUINE replacement_disposal change on a processing- or PO-locked SO.
// A client that just PATCHes the field gets a refusal with no way forward, so
// the client must recognise the lock and raise the amendment itself.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildDeliveryFieldsPatch,
  type DeliveryFieldsForm,
} from "./MobileDeliveryFieldsCard";

/* A form with every field blank — the shape a never-filled-in order seeds. */
const BLANK: DeliveryFieldsForm = {
  // SO-context
  possessionDate: "",
  houseType: "",
  referral: "",
  replacementDisposal: "",
  // DO-execution
  timeRange: "",
  timeConfirmed: false,
  arrivalAt: "",
  departureAt: "",
  shipoutDate: "",
  customerDeliveredDate: "",
  etaArrivingPort: "",
  deliverySubstatus: "",
};

const form = (over: Partial<DeliveryFieldsForm>): DeliveryFieldsForm => ({
  ...BLANK,
  ...over,
});

const UNLOCKED = { procLocked: false, hasDo: true };
const LOCKED = { procLocked: true, hasDo: true };

describe("buildDeliveryFieldsPatch — the four SO-context keys", () => {
  it("carries possessionDate / houseType / referral when they change", () => {
    const next = form({
      possessionDate: "2026-09-01",
      houseType: "New House",
      referral: "Walk-in KL",
    });

    const { body } = buildDeliveryFieldsPatch(BLANK, next, UNLOCKED);

    expect(body.possessionDate).toBe("2026-09-01");
    expect(body.houseType).toBe("New House");
    expect(body.referral).toBe("Walk-in KL");
  });

  it("omits an SO-context key that did not change (changed-only diff)", () => {
    const initial = form({ houseType: "Replacement", referral: "Agent Lim" });
    const next = form({ houseType: "Replacement", referral: "Agent Tan" });

    const { body } = buildDeliveryFieldsPatch(initial, next, UNLOCKED);

    expect(body).not.toHaveProperty("houseType");
    expect(body.referral).toBe("Agent Tan");
  });

  it("sends null (not empty string) when an SO-context field is cleared", () => {
    const initial = form({ possessionDate: "2026-09-01", referral: "Walk-in" });

    const { body } = buildDeliveryFieldsPatch(initial, BLANK, UNLOCKED);

    expect(body.possessionDate).toBeNull();
    expect(body.referral).toBeNull();
  });
});

describe("buildDeliveryFieldsPatch — replacement_disposal routing", () => {
  it("puts a disposal change in the direct PATCH body on an UNLOCKED order", () => {
    const next = form({ replacementDisposal: "Dispose old 5ft set" });

    const { body, amendmentDisposal, disposalViaAmendment } =
      buildDeliveryFieldsPatch(BLANK, next, UNLOCKED);

    expect(body.replacementDisposal).toBe("Dispose old 5ft set");
    expect(disposalViaAmendment).toBe(false);
    expect(amendmentDisposal).toBeNull();
  });

  it("EXCLUDES a disposal change from the PATCH body on a LOCKED order and raises it as an amendment", () => {
    const next = form({ replacementDisposal: "Dispose old 5ft set" });

    const { body, amendmentDisposal, disposalViaAmendment } =
      buildDeliveryFieldsPatch(BLANK, next, LOCKED);

    // The backend 409s `so_locked_processing` on this exact write — it must not
    // be attempted.
    expect(body).not.toHaveProperty("replacementDisposal");
    expect(disposalViaAmendment).toBe(true);
    expect(amendmentDisposal).toBe("Dispose old 5ft set");
  });

  it("still saves the other fields directly while the disposal goes to amendment", () => {
    const next = form({
      replacementDisposal: "Take away old base",
      referral: "Referred by Ah Meng",
      timeRange: "10am-12pm",
    });

    const { body, amendmentDisposal } = buildDeliveryFieldsPatch(
      BLANK,
      next,
      LOCKED,
    );

    expect(body.referral).toBe("Referred by Ah Meng");
    expect(body.timeRange).toBe("10am-12pm");
    expect(body).not.toHaveProperty("replacementDisposal");
    expect(amendmentDisposal).toBe("Take away old base");
  });

  it("raises NO amendment on a locked order when the disposal is untouched", () => {
    const initial = form({ replacementDisposal: "Dispose old set" });
    const next = form({
      replacementDisposal: "Dispose old set",
      referral: "New tag",
    });

    const { body, amendmentDisposal, disposalViaAmendment } =
      buildDeliveryFieldsPatch(initial, next, LOCKED);

    expect(disposalViaAmendment).toBe(false);
    expect(amendmentDisposal).toBeNull();
    expect(body).not.toHaveProperty("replacementDisposal");
    expect(body.referral).toBe("New tag");
  });

  it("treats a whitespace-only edit as untouched (trimmed both sides)", () => {
    const initial = form({ replacementDisposal: "Dispose old set" });
    const next = form({ replacementDisposal: "  Dispose old set  " });

    const { amendmentDisposal, empty } = buildDeliveryFieldsPatch(
      initial,
      next,
      LOCKED,
    );

    expect(amendmentDisposal).toBeNull();
    expect(empty).toBe(true);
  });

  it("routes a CLEARED disposal on a locked order as an amendment carrying null", () => {
    const initial = form({ replacementDisposal: "Dispose old set" });

    const { body, amendmentDisposal, disposalViaAmendment, empty } =
      buildDeliveryFieldsPatch(initial, BLANK, LOCKED);

    expect(body).not.toHaveProperty("replacementDisposal");
    // The routing FLAG is what disambiguates "clear it" from "nothing to do" —
    // the value alone is null in both cases.
    expect(disposalViaAmendment).toBe(true);
    expect(amendmentDisposal).toBeNull();
    // A cleared disposal is still a change — `empty` must not swallow it.
    expect(empty).toBe(false);
  });
});

describe("buildDeliveryFieldsPatch — the DO-execution group needs a DO", () => {
  it("omits DO-execution keys when the order has no delivery order", () => {
    const next = form({
      timeRange: "2pm-4pm",
      deliverySubstatus: "Delivered",
      houseType: "New House",
    });

    const { body } = buildDeliveryFieldsPatch(BLANK, next, {
      procLocked: false,
      hasDo: false,
    });

    expect(body).not.toHaveProperty("timeRange");
    expect(body).not.toHaveProperty("deliverySubstatus");
    // The SO-context half is editable with or without a DO — the desktop rule.
    expect(body.houseType).toBe("New House");
  });

  it("includes DO-execution keys once a DO exists", () => {
    const next = form({ timeRange: "2pm-4pm", timeConfirmed: true });

    const { body } = buildDeliveryFieldsPatch(BLANK, next, UNLOCKED);

    expect(body.timeRange).toBe("2pm-4pm");
    expect(body.timeConfirmed).toBe(true);
  });
});

describe("buildDeliveryFieldsPatch — nothing to send", () => {
  it("reports empty when no field moved", () => {
    const { body, amendmentDisposal, empty } = buildDeliveryFieldsPatch(
      BLANK,
      BLANK,
      UNLOCKED,
    );

    expect(Object.keys(body)).toHaveLength(0);
    expect(amendmentDisposal).toBeNull();
    expect(empty).toBe(true);
  });

  it("is NOT empty when only the amendment lane carries a change", () => {
    const next = form({ replacementDisposal: "Dispose old set" });

    const { body, empty } = buildDeliveryFieldsPatch(BLANK, next, LOCKED);

    expect(Object.keys(body)).toHaveLength(0);
    expect(empty).toBe(false);
  });
});
