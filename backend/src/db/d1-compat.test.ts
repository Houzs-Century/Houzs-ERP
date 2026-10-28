import { describe, it, expect } from "vitest";
import { toPgPlaceholders, rewriteDialect } from "./d1-compat";

describe("toPgPlaceholders", () => {
  it("rewrites sequential ? to $1,$2,...", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("handles adjacent placeholders in VALUES", () => {
    expect(toPgPlaceholders("INSERT INTO t (x,y) VALUES (?,?)")).toBe(
      "INSERT INTO t (x,y) VALUES ($1,$2)",
    );
  });

  it("leaves ? inside single-quoted literals alone", () => {
    expect(toPgPlaceholders("WHERE name = 'a?b' AND id = ?")).toBe(
      "WHERE name = 'a?b' AND id = $1",
    );
  });

  it("leaves ? inside double-quoted identifiers alone", () => {
    expect(toPgPlaceholders('WHERE j = "k?l" AND z = ?')).toBe(
      'WHERE j = "k?l" AND z = $1',
    );
  });

  it("counts only real placeholders across mixed quotes", () => {
    expect(
      toPgPlaceholders("a=? AND b='x' AND c=? AND d='?' AND e=?"),
    ).toBe("a=$1 AND b='x' AND c=$2 AND d='?' AND e=$3");
  });

  it("is a no-op when there are no placeholders", () => {
    expect(toPgPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("maps numbered ?N directly to $N, preserving reuse", () => {
    // global search / projects.ts:2800 pattern — one bound arg reused.
    expect(
      toPgPlaceholders("WHERE code LIKE ?1 OR name LIKE ?1 OR venue LIKE ?1"),
    ).toBe("WHERE code LIKE $1 OR name LIKE $1 OR venue LIKE $1");
  });

  it("maps mixed numbered placeholders with reuse (uniqueProjectCode)", () => {
    // services/projects.ts — bind(base, prefix.length, prefix); ?2 reused.
    expect(
      toPgPlaceholders(
        "WHERE code = ?1 OR (length(code) > ?2 AND substr(code, 1, ?2) = ?3)",
      ),
    ).toBe(
      "WHERE code = $1 OR (length(code) > $2 AND substr(code, 1, $2) = $3)",
    );
  });

  it("leaves numbered ?N inside string literals alone", () => {
    expect(toPgPlaceholders("WHERE note = 'see ?1 ref' AND id = ?1")).toBe(
      "WHERE note = 'see ?1 ref' AND id = $1",
    );
  });
});

describe("rewriteDialect LIKE handling", () => {
  it("rewrites LIKE to ILIKE", () => {
    expect(rewriteDialect("WHERE doc_no LIKE ?1 OR ref like ?1")).toBe(
      "WHERE doc_no ILIKE ?1 OR ref ILIKE ?1",
    );
  });

  it("keeps NOT LIKE working as NOT ILIKE", () => {
    expect(rewriteDialect("WHERE a NOT LIKE ?")).toBe("WHERE a NOT ILIKE ?");
  });

  it("leaves LIKE inside string literals alone", () => {
    expect(rewriteDialect("WHERE note = 'I LIKE THIS' AND b LIKE ?")).toBe(
      "WHERE note = 'I LIKE THIS' AND b ILIKE ?",
    );
  });

  it("does not double-rewrite ILIKE or touch identifiers containing like", () => {
    expect(rewriteDialect("WHERE a ILIKE ? AND liked_by = ?")).toBe(
      "WHERE a ILIKE ? AND liked_by = ?",
    );
  });
});
