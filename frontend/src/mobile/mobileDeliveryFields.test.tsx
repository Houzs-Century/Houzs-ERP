
import { describe, it, expect } from "vitest";
import {
  buildDeliveryFieldsPatch,
  type DeliveryFieldsForm,
} from "./MobileDeliveryFieldsCard";

const BLANK: DeliveryFieldsForm = {
  possessionDate: "",
  houseType: "",
  referral: "",
  replacementDisposal: "",
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
    expect(disposalViaAmendment).toBe(true);
    expect(amendmentDisposal).toBeNull();
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
    expect(body.houseType).toBe("New House");
  });

  it("includes DO-execution keys once a DO exists", () => {
    const next = form({ timeRange: "2pm-4pm", timeConfirmed: true });

    const { body } = buildDeliveryFieldsPatch(BLANK, next, UNLOCKED);

    expect(body.timeRange).toBe("2pm-4pm");
    expect(body.timeConfirmed).toBe(true);
  });
});

describe("buildDeliveryFieldsPatch — arrival / departure clock", () => {
  it("sends a typed Malaysian time with its +08:00 offset, not as a bare UTC clock", () => {
    const next = form({ arrivalAt: "2026-11-10T11:00", departureAt: "2026-11-10T09:30" });

    const { body } = buildDeliveryFieldsPatch(BLANK, next, UNLOCKED);

    expect(body.arrivalAt).toBe("2026-11-10T11:00:00+08:00");
    expect(body.departureAt).toBe("2026-11-10T09:30:00+08:00");
  });

  it("clears to null", () => {
    const { body } = buildDeliveryFieldsPatch(form({ arrivalAt: "2026-11-10T11:00" }), BLANK, UNLOCKED);
    expect(body.arrivalAt).toBeNull();
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
