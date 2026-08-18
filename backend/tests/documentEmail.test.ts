import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { documentEmailHtml, sendEmail } from "../src/services/email";
import { buildDeliveryOrderEmail, type DoEmailRow } from "../src/scm/lib/do-email";
import {
  base64DecodedBytes,
  buildPurchaseOrderEmail,
  isSendableEmail,
  poSendRefusalForStatus,
  validatePoAttachment,
  type PoEmailRow,
} from "../src/scm/lib/po-email";
import { createOutboundFetchMock } from "./outboundFetchMock";

// Document-email TEMPLATE + customer-channel gating (mig 098/0009) + the
// Delivery Order message builder.
//
// History, because it explains the shape of this file: the auto-send features
// (delivery order / invoice / report) shipped fully wired on 2026-06-14
// (e7654e4) against the CORE delivery module, and the strip-to-core cutover
// (dfa1111) then deleted that module — services/delivery.ts took the trigger,
// the guard and 8 of these tests with it, leaving only the template + gating.
// feat/r1-do-email re-wires the DO half onto the LIVE document (scm.
// delivery_orders); scm/lib/do-email.ts is its home.
//
// buildDeliveryOrderEmail is pure (row -> message | null), so it is tested
// directly here — the same split so-delivery-sync.ts uses for isSoFullyCovered.
// maybeSendDeliveryOrderEmail's claim/stamp path needs a PostgREST client and is
// not covered here; the gate it depends on IS (fail-closed, below). Resend is
// mocked.

const doRow = (over: Partial<DoEmailRow> = {}): DoEmailRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  company_id: 1,
  do_number: "DO-2607-001",
  email: "cust@example.com",
  debtor_name: "ACME Sdn Bhd",
  do_email_sent_at: null,
  address1: "12 Jalan Satu",
  address2: null,
  city: "Petaling Jaya",
  postcode: "47800",
  state: "Selangor",
  customer_delivery_date: "2026-07-20",
  expected_delivery_at: null,
  driver_name: "Ah Meng",
  vehicle: "WXY 1234",
  ...over,
});

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as typeof env;

let outbound: ReturnType<typeof createOutboundFetchMock>;
beforeEach(() => {
  outbound = createOutboundFetchMock();
});
afterEach(() => outbound.assertDone());

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_log`);
  await env.DB.exec(`DELETE FROM email_outbox`);
});

describe("document email template", () => {
  test("renders the doc no, recipient, and every row", () => {
    const html = documentEmailHtml({
      docTypeLabel: "Delivery Order",
      docNo: "SO-1",
      recipientName: "ACME Sdn Bhd",
      rows: [
        { label: "Order No", value: "SO-1" },
        { label: "Time", value: "9am - 12pm" },
      ],
      note: "On its way",
    });
    expect(html).toContain("Delivery Order SO-1");
    expect(html).toContain("ACME Sdn Bhd");
    expect(html).toContain("9am - 12pm");
    expect(html).toContain("On its way");
  });

  test("escapes HTML metacharacters in interpolated values (no markup injection)", () => {
    const html = documentEmailHtml({
      docTypeLabel: "Delivery Order",
      docNo: "SO-1",
      recipientName: 'ACME <b>&"x',
      rows: [{ label: "Note", value: "<script>alert(1)</script> & more" }],
    });
    // Raw customer markup must NOT survive into the email body.
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    // Escaped forms are present instead.
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });
});

describe("delivery order email builder", () => {
  test("no recipient => null (never an error; the goods still ship)", () => {
    expect(buildDeliveryOrderEmail(doRow({ email: null }), "Houzs Century")).toBeNull();
    expect(buildDeliveryOrderEmail(doRow({ email: "   " }), "Houzs Century")).toBeNull();
    // Garbage that isn't an address must not reach the provider either.
    expect(buildDeliveryOrderEmail(doRow({ email: "not-an-address" }), "Houzs Century")).toBeNull();
  });

  test("renders the DO number, recipient, address, schedule and crew", () => {
    const msg = buildDeliveryOrderEmail(doRow(), "Houzs Century")!;
    expect(msg.to).toBe("cust@example.com");
    expect(msg.subject).toBe("Houzs Century — Delivery Order DO-2607-001");
    expect(msg.html).toContain("DO-2607-001");
    expect(msg.html).toContain("ACME Sdn Bhd");
    expect(msg.html).toContain("12 Jalan Satu, Petaling Jaya, 47800, Selangor");
    expect(msg.html).toContain("2026-07-20");
    expect(msg.html).toContain("Ah Meng");
    expect(msg.html).toContain("WXY 1234");
  });

  test("falls back to the expected date, then to 'To be confirmed'", () => {
    const viaExpected = buildDeliveryOrderEmail(
      doRow({ customer_delivery_date: null, expected_delivery_at: "2026-07-22" }),
      "Houzs Century",
    )!;
    expect(viaExpected.html).toContain("2026-07-22");
    const neither = buildDeliveryOrderEmail(
      doRow({ customer_delivery_date: null, expected_delivery_at: null }),
      "Houzs Century",
    )!;
    expect(neither.html).toContain("To be confirmed");
  });

  test("omits crew rows it has no data for (no empty 'Driver:' line)", () => {
    const msg = buildDeliveryOrderEmail(
      doRow({ driver_name: null, vehicle: null }),
      "Houzs Century",
    )!;
    expect(msg.html).not.toContain("Driver");
    expect(msg.html).not.toContain("Lorry");
  });

  test("carries the company identity into the subject and body (2990 DO)", () => {
    // escapeHtml escapes & < > " and deliberately NOT ' — so the apostrophe
    // rides through literally. Asserted as-is rather than as an entity.
    const msg = buildDeliveryOrderEmail(doRow({ company_id: 2 }), "2990's Home")!;
    expect(msg.subject).toBe("2990's Home — Delivery Order DO-2607-001");
    expect(msg.html).toContain("2990's Home");
  });

  test("a customer name carrying markup is escaped, not interpolated raw", () => {
    const msg = buildDeliveryOrderEmail(
      doRow({ debtor_name: '<script>alert(1)</script>' }),
      "Houzs Century",
    )!;
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });
});

describe("customer channel gating", () => {
  test("a customer channel FAILS CLOSED when the toggle row is missing", async () => {
    // A missing customer-channel toggle must resolve to OFF (never auto-email a
    // real customer on a fresh/restored DB). The toggles are still surfaced by
    // the Settings email page.
    await env.DB.exec(`DELETE FROM app_settings WHERE key='email.delivery_order'`);
    const res = await sendEmail(liveEnv, {
      to: "cust@example.com",
      subject: "x",
      html: "<p>x</p>",
      purpose: "delivery_order",
    });
    expect(res.status).toBe("skipped");
  });

  // The PO channel is supplier-facing and is in the same FAIL_CLOSED_PURPOSES
  // set. Asserted separately from the DO because mig 0145 turns this one ON in
  // production: the fail-closed posture must survive that flip, so that a
  // restored database without the row still refuses to email a supplier.
  test("the purchase_order channel FAILS CLOSED when the toggle row is missing", async () => {
    await env.DB.exec(`DELETE FROM app_settings WHERE key='email.purchase_order'`);
    const res = await sendEmail(liveEnv, {
      to: "supplier@example.com",
      subject: "x",
      html: "<p>x</p>",
      purpose: "purchase_order",
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("channel disabled");
  });
});

/* ── Purchase Order -> supplier ────────────────────────────────────────────────
   The pure half of the send path (scm/lib/po-email.ts). The route's claim /
   release / audit glue needs a PostgREST client and is not covered here, same
   split as maybeSendDeliveryOrderEmail above. */

const poRow = (over: Partial<PoEmailRow> = {}): PoEmailRow => ({
  id: "22222222-2222-2222-2222-222222222222",
  po_number: "PO-2607-014",
  status: "SUBMITTED",
  total_sen: 1234500,
  currency: "MYR",
  po_date: "2026-07-19T00:00:00.000Z",
  supplier: { name: "Kilang Kayu Sdn Bhd", email: "sales@kilangkayu.com" },
  ...over,
});

/* A base64 blob of a known decoded size, for the cap tests. 4 base64 chars per
   3 bytes, no padding when the byte count divides by 3. */
const base64OfBytes = (bytes: number): string => "A".repeat(Math.ceil(bytes / 3) * 4);

describe("purchase order email builder", () => {
  test("renders the PO number, supplier, date and total", () => {
    const msg = buildPurchaseOrderEmail(poRow(), "Houzs Century")!;
    expect(msg.to).toBe("sales@kilangkayu.com");
    expect(msg.subject).toBe("Houzs Century — Purchase Order PO-2607-014");
    expect(msg.html).toContain("PO-2607-014");
    expect(msg.html).toContain("Kilang Kayu Sdn Bhd");
    // The house date format, not the raw ISO this used to leak: a supplier was
    // reading "2026-07-19" in the email and "19/07/2026" on the attached PDF
    // for one PO. Both now come from fmtDate.
    expect(msg.html).toContain("19/07/2026");
    // Money is integer SEN in this codebase; the email must show currency units.
    expect(msg.html).toContain("MYR 12345.00");
  });

  test("no usable supplier address => null (the caller refuses, never sends)", () => {
    expect(buildPurchaseOrderEmail(poRow({ supplier: { name: "X", email: null } }), "Houzs")).toBeNull();
    expect(buildPurchaseOrderEmail(poRow({ supplier: { name: "X", email: "   " } }), "Houzs")).toBeNull();
    expect(buildPurchaseOrderEmail(poRow({ supplier: null }), "Houzs")).toBeNull();
  });

  test("a supplier name carrying markup is escaped, not interpolated raw", () => {
    const msg = buildPurchaseOrderEmail(
      poRow({ supplier: { name: "<script>alert(1)</script>", email: "s@x.com" } }),
      "Houzs Century",
    )!;
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });
});

describe("supplier recipient validation", () => {
  test("accepts a real address", () => {
    expect(isSendableEmail("sales@kilangkayu.com")).toBe(true);
    expect(isSendableEmail("  sales@kilangkayu.com  ")).toBe(true);
  });

  /* sendEmail's own check is only `includes("@")`, which passes all of these.
     This is the last gate before an external send, so it must be stricter. */
  test("rejects shapes that pass a bare '@' check but no mail server will take", () => {
    for (const bad of ["", "   ", "@", "a@b", "no-at-sign.com", "Name <a@b.com>", "a@b.com, c@d.com", "a b@c.com"]) {
      expect(isSendableEmail(bad)).toBe(false);
    }
  });
});

describe("PO status gate", () => {
  test("a confirmed PO may be sent", () => {
    for (const s of ["SUBMITTED", "PARTIALLY_RECEIVED", "RECEIVED"]) {
      expect(poSendRefusalForStatus(s)).toBeNull();
    }
  });

  test("a DRAFT is refused — an uncommitted order must not reach a supplier", () => {
    expect(poSendRefusalForStatus("DRAFT")).toContain("Confirm the PO");
  });

  /* The gap this closes: the route previously checked ONLY for DRAFT, so a
     CANCELLED PO could be emailed — telling a supplier to ship goods the company
     had already decided not to buy. The frontend hides the button, but the API
     is reachable directly and the status can change under a loaded page. */
  test("a CANCELLED PO is refused", () => {
    expect(poSendRefusalForStatus("CANCELLED")).toContain("cancelled");
  });

  test("an unknown status is refused rather than allowed through", () => {
    expect(poSendRefusalForStatus("SOMETHING_NEW")).not.toBeNull();
    expect(poSendRefusalForStatus(null)).not.toBeNull();
  });
});

describe("PO attachment validation", () => {
  test("absent is legal — a summary-only PO email still goes", () => {
    for (const absent of [undefined, null, "", "   "]) {
      const r = validatePoAttachment(absent, "PO-1");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.attachment).toBeNull();
    }
  });

  test("a valid PDF becomes an attachment named after the PO", () => {
    const r = validatePoAttachment(base64OfBytes(200 * 1024), "PO-2607-014");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attachment?.filename).toBe("PO-2607-014.pdf");
  });

  test("an empty or truncated payload is refused, not sent as a 0-byte PDF", () => {
    const r = validatePoAttachment(base64OfBytes(64), "PO-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("empty or incomplete");
  });

  /* HOOKKA's BUG-2026-06-11-015: an oversize PDF was dropped silently and the
     email still claimed an attachment. Houzs refuses instead, so the operator
     learns before the supplier does. */
  test("an oversize PDF is refused with the size and the limit", () => {
    const r = validatePoAttachment(base64OfBytes(6 * 1024 * 1024), "PO-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("too large");
      expect(r.message).toContain("5 MB");
    }
  });

  test("a non-base64 body is refused before it reaches the provider", () => {
    const r = validatePoAttachment("data:application/pdf;base64,%%%not-base64%%%", "PO-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("not a valid PDF");
  });

  test("a non-string payload is refused rather than stringified", () => {
    expect(validatePoAttachment({ nope: true }, "PO-1").ok).toBe(false);
    expect(validatePoAttachment(12345, "PO-1").ok).toBe(false);
  });

  test("size is measured without decoding (base64 maths, not a Buffer)", () => {
    expect(base64DecodedBytes("")).toBe(0);
    expect(base64DecodedBytes("QQ==")).toBe(1);
    expect(base64DecodedBytes("QUJD")).toBe(3);
    // Whitespace from a wrapped payload must not inflate the count.
    expect(base64DecodedBytes("QUJD\n")).toBe(3);
  });
});

describe("attachment-bearing sends are not retried body-only", () => {
  /* email_outbox has no attachment column, so a cron-drained retry would deliver
     the covering note WITHOUT the PO document. outboxRetry:false marks the row
     terminal instead — the record stays, the retry does not. */
  test("a failed send with outboxRetry:false leaves a FAILED row, not a pending one", async () => {
    await env.DB.exec(`DELETE FROM app_settings WHERE key='email.purchase_order'`);
    await env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('email.purchase_order', '{"value":true}')`).run();
    outbound.replyOnce("https://api.resend.com/emails", "POST", 500, "provider exploded");

    const res = await sendEmail(liveEnv, {
      to: "supplier@example.com",
      subject: "Purchase Order PO-1",
      html: "<p>x</p>",
      purpose: "purchase_order",
      attachments: [{ filename: "PO-1.pdf", content: "QUJD" }],
      outboxRetry: false,
    });
    expect(res.status).toBe("error");

    const row = await env.DB.prepare(
      `SELECT status, last_error FROM email_outbox WHERE to_address = 'supplier@example.com'`,
    ).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toContain("not retried");
  });

  test("a failed send WITHOUT an attachment stays pending for the cron drain", async () => {
    await env.DB.exec(`DELETE FROM app_settings WHERE key='email.purchase_order'`);
    await env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('email.purchase_order', '{"value":true}')`).run();
    outbound.replyOnce("https://api.resend.com/emails", "POST", 500, "provider exploded");

    const res = await sendEmail(liveEnv, {
      to: "supplier2@example.com",
      subject: "Purchase Order PO-2",
      html: "<p>x</p>",
      purpose: "purchase_order",
    });
    expect(res.status).toBe("error");

    const row = await env.DB.prepare(
      `SELECT status FROM email_outbox WHERE to_address = 'supplier2@example.com'`,
    ).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});
