import { describe, expect, test } from 'vitest';
import {
  SO_HEADER_LEGACY_PAYLOAD_KEYS as tsLegacyKeys,
  SO_PROCESSING_DATE_COLUMN as tsColumn,
  SO_PROCESSING_DATE_LEGACY_COLUMNS as tsLegacyColumns,
  SO_PROCESSING_DATE_PAYLOAD_KEY as tsPayloadKey,
} from '../src/scm/shared/so-processing-date';
// @ts-expect-error - plain .mjs mirror for audit scripts
import {
  SO_HEADER_LEGACY_PAYLOAD_KEYS as jsLegacyKeys,
  SO_PROCESSING_DATE_COLUMN as jsColumn,
  SO_PROCESSING_DATE_LEGACY_COLUMNS as jsLegacyColumns,
  SO_PROCESSING_DATE_PAYLOAD_KEY as jsPayloadKey,
} from '../scripts/lib/so-processing-date.mjs';

/* scripts/lib/so-processing-date.mjs is a hand copy of the NAMING constants in
   src/scm/shared/so-processing-date.ts, because a .mjs audit cannot import
   TypeScript. This test is the pin — the same role soTerminalStatesMirror and
   doShippedStatesMirror play for their copies.

   It matters for the same reason theirs do, one step worse. These sets decide
   WHICH COLUMN AN AUDIT NAMES, and a column name is not code the compiler sees.
   Migration 0286 renamed internal_expected_dd -> processing_date and eleven
   scripts kept the old spelling; PostgREST and Postgres both answer a missing
   column with 42703 and fail the WHOLE statement, so those audits stopped
   measuring anything at all. A mirror that drifts here does not narrow an
   audit's scope — it deletes it. */

describe('so-processing-date.mjs mirrors so-processing-date.ts', () => {
  test('the column name is identical', () => {
    expect(jsColumn).toBe(tsColumn);
  });

  test('the payload key is identical', () => {
    expect(jsPayloadKey).toBe(tsPayloadKey);
  });

  test('the legacy column list is identical', () => {
    expect([...jsLegacyColumns]).toEqual([...tsLegacyColumns]);
  });

  test('the legacy payload key map is identical', () => {
    expect({ ...jsLegacyKeys }).toEqual({ ...tsLegacyKeys });
  });
});

describe('the names still mean what the scripts assume', () => {
  /* Not style. A script that builds an audit-log ILIKE list out of these needs
     the live spelling and the retired one to be DIFFERENT strings, and needs
     the retired one to stay off the query path. If a future edit ever made the
     legacy list contain the live name, every "was this row touched by a human"
     refusal would match every row. */
  test('the retired name is not the live one', () => {
    expect(tsLegacyColumns).not.toContain(tsColumn);
    expect(tsLegacyColumns).toContain('internal_expected_dd');
  });

  test('the live column is the name migration 0286 settled on', () => {
    expect(tsColumn).toBe('processing_date');
  });

  test('every legacy payload key maps onto the current one', () => {
    for (const target of Object.values(tsLegacyKeys)) expect(target).toBe(tsPayloadKey);
  });
});
