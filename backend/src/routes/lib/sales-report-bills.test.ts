// The rules behind a project's pasted sales report: who may save it, which
// bill is already an order (and whether under the right event), whose bill it
// is, and what each person still has to open.
import { describe, expect, test } from "vitest";
import {
  canSaveSalesReport,
  indexOrdersByToken,
  matchBill,
  matchBills,
  resolveAttendee,
  summarizeBills,
  type AttendeeRow,
  type BillRow,
  type OrderRow,
} from "./sales-report-bills";

const order = (over: Partial<OrderRow> & { doc_no: string }): OrderRow => ({
  project_id: 344, status: "CONFIRMED", customer_so_no: null, ref: null, salesperson_id: "staff-j",
  local_total_sen: 650000, total_revenue_sen: 650000, ...over,
});
const bill = (over: Partial<BillRow> & { id: number; ref_token: string }): BillRow => ({
  ref_raw: over.ref_token, amount_sen: 100000, salesperson_name: null, report_date: null,
  source_activity_id: null, created_at: null, ...over,
});
const ATTENDEES: AttendeeRow[] = [
  { sales_rep_id: 11, rep_name: "Jason Lee", user_name: "Jason Lee", rep_user_id: 101 },
  { sales_rep_id: 12, rep_name: "Melvin Tan", user_name: null, rep_user_id: 102 },
  { sales_rep_id: 13, rep_name: "Mei Ting", user_name: "Mei Ting Wong", rep_user_id: 103 },
  { sales_rep_id: 14, rep_name: "Shi Ting", user_name: null, rep_user_id: 104 },
];

describe("canSaveSalesReport", () => {
  test("the Owner position and the two named accounts, nobody else", () => {
    expect(canSaveSalesReport({ position_name: "Owner", email: "hello@houzscentury.com" })).toBe(true);
    expect(canSaveSalesReport({ position_name: "Managing Director", email: "WeiSiang329@gmail.com" })).toBe(true);
    expect(canSaveSalesReport({ position_name: "Operation Executive", email: "ummuaimanlm@gmail.com" })).toBe(true);
    expect(canSaveSalesReport({ position_name: "Sales Director", email: "sd@houzs.com" })).toBe(false);
    expect(canSaveSalesReport({ position_name: "Super Admin", email: "nico@houzs.com" })).toBe(false);
    expect(canSaveSalesReport(null)).toBe(false);
  });
});

describe("indexOrdersByToken / matchBill", () => {
  test("reads the booklet number out of Ref No. and the migrated ref, and matches the whole token only", () => {
    const index = indexOrdersByToken([
      order({ doc_no: "HC-SO-2609-116", customer_so_no: "HC13263 share with yuny" }),
      order({ doc_no: "HC-SO-013462", ref: "HC13503 + ZNT6191" }),
    ]);
    expect(matchBill("HC13263", 344, index).so_doc_no).toBe("HC-SO-2609-116");
    expect(matchBill("ZNT6191", 344, index).so_doc_no).toBe("HC-SO-013462");
    expect(matchBill("HC1326", 344, index).status).toBe("not_opened");
    expect(matchBill("HC13503", 344, index).so_amount_sen).toBe(650000);
  });

  test("an order under another event is opened but flagged; an unlinked one is flagged as such", () => {
    const index = indexOrdersByToken([
      order({ doc_no: "HC-SO-1", customer_so_no: "HC8993", project_id: 345 }),
      order({ doc_no: "HC-SO-2", customer_so_no: "HC8994", project_id: null }),
    ]);
    const other = matchBill("HC8993", 344, index);
    expect(other.status).toBe("opened");
    expect(other.other_event).toBe(true);
    expect(other.so_project_id).toBe(345);
    const unlinked = matchBill("HC8994", 344, index);
    expect(unlinked.unlinked).toBe(true);
    expect(unlinked.other_event).toBe(false);
  });

  test("when two orders carry the same number, this event's wins, then an unlinked one", () => {
    const index = indexOrdersByToken([
      order({ doc_no: "HC-SO-9", customer_so_no: "HC8993", project_id: 345 }),
      order({ doc_no: "HC-SO-5", customer_so_no: "HC8993", project_id: 344 }),
      order({ doc_no: "HC-SO-7", customer_so_no: "HC8993", project_id: null }),
    ]);
    expect(matchBill("HC8993", 344, index).so_doc_no).toBe("HC-SO-5");
    expect(matchBill("HC8993", 999, index).so_doc_no).toBe("HC-SO-7");
  });

  test("the amount is the order's revenue total, falling back to the migrated local total", () => {
    const index = indexOrdersByToken([order({ doc_no: "HC-SO-3", customer_so_no: "HC1", ref: "HC9001", total_revenue_sen: 0, local_total_sen: 300000 })]);
    expect(matchBill("HC9001", 344, index).so_amount_sen).toBe(300000);
  });
});

describe("resolveAttendee", () => {
  test("exact, then first-name, then a word; ambiguity resolves to nobody", () => {
    expect(resolveAttendee("Jason Lee", ATTENDEES)?.sales_rep_id).toBe(11);
    expect(resolveAttendee("jason", ATTENDEES)?.sales_rep_id).toBe(11);
    expect(resolveAttendee("Melvin", ATTENDEES)?.sales_rep_id).toBe(12);
    expect(resolveAttendee("Mei Ting", ATTENDEES)?.sales_rep_id).toBe(13);
    expect(resolveAttendee("Wong", ATTENDEES)?.sales_rep_id).toBe(13);
    /* "Ting" is a word of two attendees' names — not a guess. */
    expect(resolveAttendee("Ting", ATTENDEES)).toBeNull();
    /* Initials, as the floor writes them: CH is Chea Huan, ST is Shi Ting. */
    const withChea = [...ATTENDEES, { sales_rep_id: 15, rep_name: "Chea Huan", user_name: null, rep_user_id: 105 }];
    expect(resolveAttendee("CH", withChea)?.sales_rep_id).toBe(15);
    expect(resolveAttendee("ST", withChea)?.sales_rep_id).toBe(14);
    /* MT fits Mei Ting and Melvin Tan both — not a guess. */
    expect(resolveAttendee("MT", withChea)).toBeNull();
    expect(resolveAttendee("Adrian", ATTENDEES)).toBeNull();
    expect(resolveAttendee(null, ATTENDEES)).toBeNull();
    expect(resolveAttendee("  ", ATTENDEES)).toBeNull();
  });
});

describe("matchBills + summarizeBills", () => {
  test("totals per event and per person, with the not-opened sum the chip shows in red", () => {
    const orders = [
      order({ doc_no: "HC-SO-1", customer_so_no: "HC8993" }),
      order({ doc_no: "HC-SO-2", customer_so_no: "HC8995", project_id: 345 }),
    ];
    const bills = [
      bill({ id: 1, ref_token: "HC8993", amount_sen: 650000, salesperson_name: "Jason" }),
      bill({ id: 2, ref_token: "HC8994", amount_sen: 499900, salesperson_name: "Melvin" }),
      bill({ id: 3, ref_token: "HC8995", amount_sen: 200000, salesperson_name: "Jason" }),
      bill({ id: 4, ref_token: "HC8996", amount_sen: 120000, salesperson_name: "Adrian" }),
      bill({ id: 5, ref_token: "HC8997", amount_sen: 50000, salesperson_name: null }),
    ];
    const matched = matchBills(bills, 344, orders, ATTENDEES);
    expect(matched.map((b) => [b.ref_token, b.match.status, b.sales_rep_id])).toEqual([
      ["HC8993", "opened", 11],
      ["HC8994", "not_opened", 12],
      ["HC8995", "opened", 11],
      ["HC8996", "not_opened", null],
      ["HC8997", "not_opened", null],
    ]);

    const { persons, totals } = summarizeBills(matched, ATTENDEES);
    expect(totals).toEqual({
      count: 5, amount_sen: 1519900,
      opened_count: 2, opened_sen: 850000,
      not_opened_count: 3, not_opened_sen: 669900,
      other_event_count: 1,
    });
    /* Sorted by what is still not opened, largest first. */
    expect(persons.map((p) => [p.name, p.sales_rep_id, p.not_opened_sen, p.opened_sen, p.other_event_count])).toEqual([
      ["Melvin Tan", 12, 499900, 0, 0],
      ["Adrian", null, 120000, 0, 0],
      ["(no name)", null, 50000, 0, 0],
      ["Jason Lee", 11, 0, 850000, 1],
    ]);
    expect(persons[3]!.rep_user_id).toBe(101);
  });

  test("an empty report summarises to zeros and no persons", () => {
    const { persons, totals } = summarizeBills([], ATTENDEES);
    expect(persons).toEqual([]);
    expect(totals.count).toBe(0);
    expect(totals.not_opened_sen).toBe(0);
  });
});
