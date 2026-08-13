// Types for the shared sofa Desc2 decoder (parse-sofa.mjs).
//
// The decoder itself stays plain ESM because the two cutover importers
// (import-ac-outstanding-so.mjs / -po.mjs) are node scripts and cannot import
// TypeScript. This declaration lets backend/src use the SAME implementation
// instead of vendoring a second copy — a vendored decoder that drifts from the
// importer is exactly the failure mode D9 is about, because the AutoCount
// write-back has to reproduce what the importer read.
export interface SofaParse {
  /** ERP compartment suffixes, in physical left-to-right order. */
  pieces: string[];
  /** Seat size in inches, as written. */
  size: string | null;
  color: string | null;
  perPieceColor: Record<string, string>;
  specials: string[];
  conf: 'high' | 'medium' | 'low';
  why: string[];
}

/** ERP model that an AutoCount model was folded onto at the cutover. */
export declare const SOFA_MODEL_ALIAS: Record<string, string>;
export declare const CM_TO_INCH: Record<number, number>;

export declare function parseSofa(
  d2raw: string | null | undefined,
  model: string | null | undefined,
  recl?: boolean,
): SofaParse;
