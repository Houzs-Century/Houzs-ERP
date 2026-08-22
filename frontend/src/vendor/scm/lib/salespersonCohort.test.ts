// ----------------------------------------------------------------------------
// salesperson-cohort — the Collected By dropdown must be the salesperson roster.
//
// Two dropdowns on the Sales Order form asked the same question with two
// hand-written rules. The salesperson picker matched user_id first and kept
// email as a fallback; "Collected By" matched EMAIL ONLY — and bailed to `null`
// (no restriction at all) whenever the email set was empty.
//
// Email is not a key that exists on this data. Measured on production
// 2026-08-12 and recorded in SalesOrderNew.tsx: of 140 scm.staff rows, 18 carry
// an email; 102 carry user_id; of the 102 ACTIVE rows, 98 have no email. So the
// money field offered a handful of people, or — when no email resolved at all —
// everyone.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import {
  cohortIsResolved,
  isInSalespersonCohort,
  cohortStaffIds,
  type CohortStaff,
} from "./salesperson-cohort";

/* The production shape, in miniature: most rows have a user_id and no email. */
const ROSTER: CohortStaff[] = [
  { id: "s-sales-1", userId: 11, email: null },
  { id: "s-sales-2", userId: 12, email: "" },
  { id: "s-sales-3", userId: 13, email: "  " },
  { id: "s-legacy",  userId: null, email: "Legacy@Houzs.com" },
  { id: "s-other",   userId: 99, email: null },
  { id: "s-me",      userId: 7,  email: null },
];

const SALES_IDS = new Set([11, 12, 13]);
const SALES_EMAILS = new Set(["legacy@houzs.com"]);

describe("the cohort is keyed on user_id, because email mostly is not there", () => {
  test("a Sales staff row with no email is IN", () => {
    expect(isInSalespersonCohort(ROSTER[0]!, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS,
    })).toBe(true);
  });

  /* THE REGRESSION, stated as the population it costs. Under email-only
     matching, only the one legacy row survived. */
  test("email-only matching would have kept 1 of the 4 Sales rows", () => {
    const emailOnly = ROSTER.filter((s) =>
      SALES_EMAILS.has((s.email ?? "").trim().toLowerCase()));
    expect(emailOnly.map((s) => s.id)).toEqual(["s-legacy"]);

    const now = cohortStaffIds(ROSTER, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS,
    });
    expect([...now!].sort()).toEqual(["s-legacy", "s-sales-1", "s-sales-2", "s-sales-3"]);
  });

  test("the 18 rows that carry an email and no user_id still match on it", () => {
    expect(isInSalespersonCohort(ROSTER[3]!, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS,
    })).toBe(true);
  });

  test("email comparison is trimmed and case-folded", () => {
    expect(isInSalespersonCohort({ id: "x", email: "  LEGACY@houzs.COM " }, {
      allowedUserIds: null, allowedEmails: SALES_EMAILS,
    })).toBe(true);
  });

  test("someone outside the cohort stays out", () => {
    expect(isInSalespersonCohort(ROSTER[4]!, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS,
    })).toBe(false);
  });
});

describe("the caller and the stored row are always in", () => {
  test("the signed-in user is in their own roster, by user_id", () => {
    expect(isInSalespersonCohort(ROSTER[5]!, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS, selfUserId: 7,
    })).toBe(true);
  });

  test("selfUserId accepts the string a query hands back", () => {
    expect(isInSalespersonCohort(ROSTER[5]!, {
      allowedUserIds: SALES_IDS, allowedEmails: null, selfUserId: "7",
    })).toBe(true);
  });

  /* A document that already names someone must not blank on open. */
  test("the row the document already names is kept whatever the cohort says", () => {
    expect(isInSalespersonCohort(ROSTER[4]!, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS, keepStaffId: "s-other",
    })).toBe(true);
  });

  test("a blank self key matches nobody rather than everybody", () => {
    expect(isInSalespersonCohort({ id: "blank", userId: null, email: null }, {
      allowedUserIds: SALES_IDS, allowedEmails: SALES_EMAILS, selfEmail: "", selfUserId: null,
    })).toBe(false);
  });
});

describe("null means NOT RESOLVED YET, never 'the key was missing'", () => {
  test("neither key set resolved -> do not restrict", () => {
    expect(cohortIsResolved({ allowedUserIds: null, allowedEmails: null })).toBe(false);
    expect(cohortStaffIds(ROSTER, { allowedUserIds: null, allowedEmails: null })).toBeNull();
    expect(cohortStaffIds(ROSTER, {
      allowedUserIds: new Set(), allowedEmails: new Set(),
    })).toBeNull();
  });

  /* THE SECOND HALF OF THE DEFECT, and the worse one: the money field used to
     fall fully open on exactly this input, while the salesperson picker went on
     narrowing correctly off user_id. */
  test("user_ids resolved but NO emails still restricts", () => {
    expect(cohortIsResolved({ allowedUserIds: SALES_IDS, allowedEmails: null })).toBe(true);
    const ids = cohortStaffIds(ROSTER, { allowedUserIds: SALES_IDS, allowedEmails: null });
    expect(ids).not.toBeNull();
    expect([...ids!].sort()).toEqual(["s-sales-1", "s-sales-2", "s-sales-3"]);
  });

  test("emails resolved but no user_ids still restricts", () => {
    const ids = cohortStaffIds(ROSTER, { allowedUserIds: null, allowedEmails: SALES_EMAILS });
    expect([...ids!]).toEqual(["s-legacy"]);
  });
});
