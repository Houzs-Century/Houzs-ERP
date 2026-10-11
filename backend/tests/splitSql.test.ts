import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs helper shared with the deploy-time migration runner
import { splitSqlStatements } from "../scripts/lib/split-sql.mjs";

// pg-migrate.mjs runs on EVERY production deploy and a bug in the splitter
// blocks EVERY deploy, so the splitter is a pure module with real coverage.
// The behaviour that matters: a dollar-quoted PL/pgSQL body is ONE statement,
// no matter how many `;\n` it contains.

const split = (sql: string): string[] => splitSqlStatements(sql) as string[];

describe("splitSqlStatements - flat statements (legacy behaviour)", () => {
  it("splits a plain multi-statement file on ;-newline", () => {
    const sql = [
      "CREATE TABLE a (id int);",
      "CREATE TABLE b (id int);",
      "CREATE INDEX i ON a (id);",
      "",
    ].join("\n");
    const stmts = split(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toBe("CREATE TABLE a (id int)");
    expect(stmts[2]).toBe("CREATE INDEX i ON a (id)");
  });

  it("drops whole-line -- comments and blank statements", () => {
    const sql = [
      "-- header comment",
      "-- second line",
      "ALTER TABLE a ADD COLUMN x int;",
      "",
      "-- trailing note",
      "ALTER TABLE a ADD COLUMN y int;",
      "",
    ].join("\n");
    const stmts = split(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("ALTER TABLE a ADD COLUMN x int");
    expect(stmts[1]).toBe("ALTER TABLE a ADD COLUMN y int");
  });

  it("does not split on a semicolon followed by more text on the same line", () => {
    const sql = "SELECT 1; SELECT 2;\n";
    expect(split(sql)).toEqual(["SELECT 1; SELECT 2"]);
  });

  it("keeps a final statement that has no trailing newline", () => {
    expect(split("SELECT 1;\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split inside a single-quoted literal that spans lines", () => {
    const sql = "INSERT INTO t (v) VALUES ('a;\nb;\nc');\nSELECT 1;\n";
    const stmts = split(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'a;\nb;\nc'");
  });

  it("does not split inside a block comment", () => {
    const sql = "/* note;\nmore;\n*/\nSELECT 1;\nSELECT 2;\n";
    expect(split(sql)).toHaveLength(2);
  });
});

describe("splitSqlStatements - dollar quoting", () => {
  const PLPGSQL_FN = `CREATE OR REPLACE FUNCTION scm.bump(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_paid integer;
  v_total integer;
BEGIN
  SELECT paid_centi, total_centi INTO v_paid, v_total
  FROM scm.purchase_invoices WHERE id = p_id FOR UPDATE;
  IF v_paid IS NULL THEN
    RAISE EXCEPTION 'not found';
  END IF;
  UPDATE scm.purchase_invoices SET paid_centi = v_paid + 1 WHERE id = p_id;
  RETURN v_paid + 1;
END;
$$;`;

  it("keeps a CREATE FUNCTION with $$ and many ;-newlines as ONE statement", () => {
    const stmts = split(`${PLPGSQL_FN}\n`);
    expect(stmts).toHaveLength(1);
    // The body must arrive intact, semicolons and all.
    expect(stmts[0]).toBe(PLPGSQL_FN.replace(/;$/, ""));
    expect(stmts[0]).toContain("RAISE EXCEPTION 'not found';");
    expect(stmts[0]).toContain("END;");
    // Sanity: the old splitter would have shattered this.
    expect(
      `${PLPGSQL_FN}\n`.split(/;\s*\n/).filter(Boolean).length,
    ).toBeGreaterThan(1);
  });

  it("preserves whole-line -- comments INSIDE a dollar-quoted body", () => {
    const sql = [
      "-- stripped: outside the body",
      "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$",
      "BEGIN",
      "  -- kept: inside the body",
      "  RETURN 1;",
      "END;",
      "$$;",
      "",
    ].join("\n");
    const stmts = split(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("-- kept: inside the body");
    expect(stmts[0]).not.toContain("-- stripped: outside the body");
  });

  it("handles arbitrary tags and a nested dollar quote", () => {
    const sql = [
      "CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $func$",
      "BEGIN",
      "  EXECUTE $body$",
      "    SELECT 1;",
      "    SELECT 2;",
      "  $body$;",
      "  PERFORM 1;",
      "END;",
      "$func$;",
      "SELECT 'after';",
      "",
    ].join("\n");
    const stmts = split(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("$body$");
    expect(stmts[0]).toContain("SELECT 2;");
    expect(stmts[0]?.endsWith("$func$")).toBe(true);
    expect(stmts[1]).toBe("SELECT 'after'");
  });

  it("keeps an anonymous DO $$ ... $$ block whole", () => {
    const sql = [
      "DO $$",
      "DECLARE r RECORD;",
      "BEGIN",
      "  FOR r IN SELECT 1 LOOP",
      "    RAISE NOTICE 'x';",
      "  END LOOP;",
      "END $$;",
      "",
    ].join("\n");
    expect(split(sql)).toHaveLength(1);
  });

  it("does not mistake a $1 bind placeholder for a dollar tag", () => {
    const sql = "SELECT * FROM t WHERE a = $1;\nSELECT 2;\n";
    expect(split(sql)).toHaveLength(2);
  });

  it("mixes flat DDL and a function body in one file with the right count", () => {
    const sql = [
      "-- 0147_example.sql",
      "ALTER TABLE scm.purchase_invoices ADD COLUMN IF NOT EXISTS paid_centi bigint;",
      "",
      PLPGSQL_FN,
      "",
      "GRANT EXECUTE ON FUNCTION scm.bump(uuid) TO authenticated;",
      "",
      "CREATE INDEX IF NOT EXISTS idx_pi_status ON scm.purchase_invoices (status);",
      "",
    ].join("\n");
    const stmts = split(sql);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toContain("ADD COLUMN IF NOT EXISTS paid_centi");
    expect(stmts[1]).toContain("CREATE OR REPLACE FUNCTION scm.bump");
    expect(stmts[1]).toContain("RETURN v_paid + 1;");
    expect(stmts[2]).toContain("GRANT EXECUTE");
    expect(stmts[3]).toContain("CREATE INDEX");
  });

  it("handles CRLF files (the whole migrations-pg tree is CRLF)", () => {
    const sql = `${PLPGSQL_FN}\nSELECT 1;\n`.replace(/\n/g, "\r\n");
    const stmts = split(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("RAISE EXCEPTION 'not found';");
    expect(stmts[1]).toBe("SELECT 1");
  });
});
