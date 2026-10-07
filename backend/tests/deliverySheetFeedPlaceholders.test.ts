import { describe, expect, test } from "vitest";
import { toPgPlaceholders } from "../src/db/d1-compat";
import { FEED_ASSR_CONTACTS_SQL, FEED_ASSR_LEGS_SQL } from "../src/lib/delivery-sheet-assr-feed";
import {
  FEED_BALANCE_COLLECTION_SQL,
  FEED_OVERDUE_SQL,
  FEED_READY_OPEN_SQL,
  FEED_SINCE_SQL,
  feedByDocNosSql,
  feedFullByDocNosSql,
  feedLinesSql,
  updateFromSheetSql,
} from "../src/lib/delivery-sheet-feed";
import { FEED_OUTSTANDING_PO_SQL, poHeadsForSheetSql } from "../src/lib/delivery-sheet-po-feed";

/* #4447 put "case's" / "SO's" / "BUG-52's" in a `--` comment inside the ASSR
   feed SQL. toPgPlaceholders took the apostrophes for an open string, left ?1 /
   ?2 unconverted, and /assr-legs + /assr-contacts answered 502. The pg suite
   caught it but is not a required check, so this one is: every Delivery sheet
   feed must reach Postgres with no `?` left. */
const FEEDS: Record<string, string> = {
  FEED_ASSR_LEGS_SQL,
  FEED_ASSR_CONTACTS_SQL,
  FEED_SINCE_SQL,
  FEED_OVERDUE_SQL,
  FEED_BALANCE_COLLECTION_SQL,
  FEED_READY_OPEN_SQL,
  FEED_OUTSTANDING_PO_SQL,
  feedLinesSql: feedLinesSql(2),
  feedByDocNosSql: feedByDocNosSql(2),
  feedFullByDocNosSql: feedFullByDocNosSql(2),
  updateFromSheetSql: updateFromSheetSql(2),
  poHeadsForSheetSql: poHeadsForSheetSql(2),
};

describe("Delivery sheet feed SQL survives the placeholder rewrite", () => {
  test.each(Object.entries(FEEDS))("%s has every placeholder converted", (_name, sql) => {
    expect(sql).toMatch(/\?/);
    expect(toPgPlaceholders(sql)).not.toMatch(/\?/);
  });

  test("the ASSR feeds bind the cursor as $1 and the limit as $2", () => {
    for (const sql of [FEED_ASSR_LEGS_SQL, FEED_ASSR_CONTACTS_SQL]) {
      const pg = toPgPlaceholders(sql);
      expect(pg).toContain("> $1::timestamptz");
      expect(pg).toContain("LIMIT $2");
    }
  });
});
