// WHAT AUTOCOUNT SAID, put into the reader's words.
//
// The page translated one class of verdict and not the other. A row the ERP
// held back got a headline, a sentence, a To fix line and the machine's note
// folded into Technical detail; a row AUTOCOUNT refused got a generic headline
// and a raw string. The owner read that screen and asked why:
// 「为什么写这种的呢？没有平时 autocount reject 的 reason 直接过来？」
//
// The risk in fixing it is not that a translation is missing — it is that a
// translation is WRONG, because a confident wrong explanation sends an operator
// to repair something that is not broken. So the tests that matter here are the
// ones about the FALLBACK: anything nobody has actually seen must still arrive
// as AutoCount's own untranslated words.
import { describe, expect, test } from "vitest";
import {
  AC_AUTOCOUNT_SAID,
  AC_FAILED_COPY,
  AC_UNRECOGNISED_COPY,
  acAutoCountCopy,
  acReasonCopy,
  acRowDetail,
  type AcOutboxRow,
} from "./autocountOutbox";

const row = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
  id: "ob-1",
  op: "create_so",
  doc_type: "SO",
  doc_no: "HC-SO-2608-001",
  doc_id: null,
  status: "failed",
  state: "failed",
  attempts: 6,
  reason: "Gave up after 6 attempts. Last error: Primary Key Error",
  reason_kind: null,
  remedy: null,
  needs_attention: true,
  can_requeue: true,
  can_send_now: false,
  ac_doc_no: null,
  created_at: "2026-08-20T12:37:00Z",
  updated_at: "2026-08-20T14:13:00Z",
  sent_at: null,
  ...over,
});

describe("a refusal AutoCount has words for", () => {
  test("says what it MEANS for the document, not what the database called it", () => {
    const c = acAutoCountCopy("Gave up after 6 attempts. Last error: Primary Key Error");
    expect(c).not.toBeNull();
    /* The business effect. "Primary key" is the mechanism and must not be the
       headline — the owner is not an engineer and the screen is his. */
    expect(c!.headline).toBe("AutoCount already has a document with this number");
    expect(c!.headline.toLowerCase()).not.toContain("primary key");
  });

  test("the To fix line is honest that sending it again cannot help", () => {
    const c = acAutoCountCopy("Primary Key Error")!;
    expect(c.toFix.toLowerCase()).toContain("will not help");
    /* And it names whose job it is, because it is not the reader's. */
    expect(c.toFix.toLowerCase()).toContain("autocount account book");
  });

  test("a failed row gets the specific words instead of the generic ones", () => {
    const c = acReasonCopy("failed", null, "Last error: Primary Key Error");
    expect(c).not.toBe(AC_FAILED_COPY);
    expect(c!.headline).toBe("AutoCount already has a document with this number");
  });

  /* THE STATE THAT WOULD OTHERWISE BE MISSED. AcSyncService turns every
     exception into a 500 and a 500 is retryable, so a document AutoCount is
     refusing sits at `pending` carrying the refusal until its sixth attempt.
     On 2026-08-20 that was HC-SO-2608-002, next to HC-SO-2608-001 which read
     `failed` with identical words. */
  test("a WAITING row carrying the same refusal is explained too", () => {
    const c = acReasonCopy("pending", null, "Primary Key Error");
    expect(c).not.toBeNull();
    expect(c!.headline).toBe("AutoCount already has a document with this number");
  });

  test("the raw text is still reachable, verbatim, in the technical detail", () => {
    const d = acRowDetail(row(), false);
    expect(d.line).toBe("AutoCount already has a document with this number");
    /* Off the face of the row... */
    expect(d.said!.said).toBeNull();
    /* ...but never lost: whoever maintains the link needs the book's own words. */
    expect(d.said!.technical).toContain("Primary Key Error");
  });
});

describe("a refusal nobody has words for yet", () => {
  const UNSEEN = "Gave up after 6 attempts. Last error: Some Error Nobody Has Seen";

  test("is NOT translated — the fallback is the whole safety property", () => {
    expect(acAutoCountCopy(UNSEEN)).toBeNull();
    expect(acReasonCopy("failed", null, UNSEEN)).toBe(AC_FAILED_COPY);
  });

  test("keeps AutoCount's own words ON the row, where the diagnosis is", () => {
    const d = acRowDetail(row({ reason: UNSEEN }), false);
    /* The generic copy tells the reader to read the words below, so the words
       below must still be below. Folding them away would leave an instruction
       pointing at something that is no longer on screen. */
    expect(d.said!.said).toContain("Some Error Nobody Has Seen");
  });

  test("a pending row with an unknown note is not given a headline it has not earned", () => {
    expect(acReasonCopy("pending", null, UNSEEN)).toBeNull();
  });
});

describe("the ERP's own refusals are untouched by any of this", () => {
  test("a skipped row keeps its reason_kind copy, whatever the text says", () => {
    /* Even if an ERP reason happened to quote AutoCount, the ERP classified it
       and the ERP was the one that refused — AutoCount was never asked. */
    const c = acReasonCopy("skipped", "missing-location", "Primary Key Error");
    expect(c).not.toBeNull();
    expect(c!.headline).not.toBe("AutoCount already has a document with this number");
  });

  test("an unrecognised skip still says nobody has words for it", () => {
    expect(acReasonCopy("skipped", "a-kind-written-next-month", null)).toBe(AC_UNRECOGNISED_COPY);
  });
});

describe("the dictionary itself", () => {
  test("every entry records where the string was OBSERVED", () => {
    /* An entry with no provenance is a guess with a citation field. */
    for (const e of AC_AUTOCOUNT_SAID) {
      expect(e.seen.length).toBeGreaterThan(20);
      expect(e.needle.length).toBeGreaterThan(0);
    }
  });

  test("no entry carries coding vocabulary into the owner's screen", () => {
    const banned = /\b(null|undefined|dtlkey|foreign key|primary key|sql|payload|column|api|endpoint)\b/i;
    for (const e of AC_AUTOCOUNT_SAID) {
      expect(banned.test(e.copy.headline), e.copy.headline).toBe(false);
      expect(banned.test(e.copy.explain), e.copy.explain).toBe(false);
      expect(banned.test(e.copy.toFix), e.copy.toFix).toBe(false);
    }
  });
});
