// ----------------------------------------------------------------------------
// autocountArchive — CLEARING A FINISHED DOCUMENT off the AutoCount Sync page,
// and putting it back.
//
// WHY IT EXISTS AT ALL. The owner asked twice for three old test documents to
// stop appearing on System · AutoCount Sync. Measured against production on
// 2026-09-08, those three documents WERE the page: the whole queue for Houzs
// Century is 32 rows over HC-SO-013361, HC-SO-013393 and HC-SO-013394, every one
// an old write-back test, every one in the account book, under the green banner
// "Everything is in AutoCount. Nothing is waiting and nothing was refused."
//
// NOTHING IS DELETED AND NOTHING IS REWRITTEN, and both halves are load-bearing.
// The queue is the audit trail of what the ERP told AutoCount and its own table
// comment forbids deleting a row. And the obvious cheap alternative — writing a
// marker onto the row's reason — is worse than doing nothing: the re-queue
// marker is matched as a PREFIX, so a second marker in front of it would stop a
// settled row reading as Replaced and push it back onto Not accepted, which is
// the opposite of what was asked. The server keeps this on a column of its own
// for exactly that reason.
//
// WHY A SEPARATE FILE FROM autocountOutbox.ts. The 2,000-line cap, and nothing
// else — the same reason autocountRegister.ts is separate, stated in its own
// header. All three are ONE layer: imported by both surfaces and by nothing but
// them.
//
// PRESENTATION ONLY. Every rule about WHETHER a document may be cleared is the
// server's (scm/lib/autocount-outbox-archive.ts); `acDocCanArchive` below is a
// hint that keeps a knowably-useless button off a row, never a gate.
// ----------------------------------------------------------------------------

import { api } from "../api/client";
import type {
  AcDocGroup,
  AcFilterState,
  AcOutboxResponse,
  AcRequeueNote,
} from "./autocountOutbox";

/**
 * What the two endpoints answer with.
 *
 * SAME CONTRACT AS `requeueAcOutboxRow`: the call THROWS on 403 / 409 / 500 and
 * RESOLVES with `archived: false` on a refusal, and BOTH have to be rendered. A
 * refusal here is the server answering the question — "that one still needs
 * somebody" — and a component that renders only the resolved-happy branch is the
 * silent-mutation shape frontend/scripts/check-silent-mutations.mjs exists to
 * catch. Thirty-five write paths in this repo once refused correctly and told
 * nobody; the owner reported it as "the button does nothing".
 */
export interface AcArchiveResult {
  archived?: boolean;
  restored?: boolean;
  code: string;
  /** The server's own sentence. Rendered verbatim, never rewritten here. */
  message: string;
  doc_type?: string;
  doc_no?: string;
  /** How many sends moved. */
  rows: number;
  /** How many sends are the REASON one did not. */
  blocked: number;
}

/**
 * BY DOCUMENT, NOT BY ROW. The three documents this was built for carry 32
 * sends between them; a per-row control would have asked for 32 presses to
 * clear 3 finished documents.
 */
export async function archiveAcOutboxDoc(
  docType: string,
  docNo: string,
): Promise<AcArchiveResult> {
  return api.post<AcArchiveResult>("/api/scm/autocount-outbox/archive", {
    doc_type: docType,
    doc_no: docNo,
  });
}

export async function restoreAcOutboxDoc(
  docType: string,
  docNo: string,
): Promise<AcArchiveResult> {
  return api.post<AcArchiveResult>("/api/scm/autocount-outbox/restore", {
    doc_type: docType,
    doc_no: docNo,
  });
}

/** Did the call actually move anything? Both endpoints, one question. */
export const acShelfDone = (r: AcArchiveResult): boolean =>
  r.archived === true || r.restored === true;

/**
 * The note the row shows afterwards.
 *
 * HERE RATHER THAN IN THE HOOK so the page cannot come to word a refusal
 * differently from the check that produced it — the same argument the server's
 * AC_ARCHIVE_MEANING makes for keeping its sentences beside its verdict.
 *
 * `wait`, not `bad`, on a refusal: being told a document still needs somebody is
 * news, not a fault, and the send buttons already use that tone for the same
 * reason.
 */
export function acShelfNote(r: AcArchiveResult): AcRequeueNote {
  return {
    tone: acShelfDone(r) ? "good" : "wait",
    text: r.message,
    todo: null,
    quote: null,
    quoteTechnical: null,
    ancestors: [],
    /* Nothing about the document's REFUSAL changed — taking a finished document
       off a list is not a claim about AutoCount. */
    clearsReason: false,
  };
}

/**
 * The note for a call that was never answered — a different fact from a refusal,
 * and it gets the page's own words with the transport's quoted UNDER them. A
 * fetch layer's string is not this page's voice, and on a bad day it is a status
 * line and a URL.
 */
export function acShelfFailedNote(text: string, e: unknown): AcRequeueNote {
  return {
    tone: "bad",
    text,
    todo: null,
    quote: e instanceof Error ? e.message : String(e),
    quoteTechnical: null,
    ancestors: [],
    clearsReason: false,
  };
}

/* "CLEAR", NOT "ARCHIVE" OR "HIDE". The reader of this page is deciding whether
   pressing it destroys anything, and "archive" is a word people associate with
   putting things beyond reach. "Clear" says what it does to the LIST, which is
   the only thing it touches. The Cleared tab is where the document goes, so the
   word is the same in both places. */
export const AC_ARCHIVE_LABEL = "Clear";
export const AC_ARCHIVE_BUSY_LABEL = "Clearing";
export const AC_RESTORE_LABEL = "Put back";
export const AC_RESTORE_BUSY_LABEL = "Restoring";

export const AC_ARCHIVE_FAILED_LINE = "Nothing was cleared — the request never got through.";
export const AC_RESTORE_FAILED_LINE = "Nothing was put back — the request never got through.";

/** The sentence under the Cleared tab, so nobody reads it as a wastebasket. */
export const AC_ARCHIVED_TAB_NOTE =
  "Documents somebody has finished with. Everything they did is still recorded — "
  + "nothing here was deleted, and Put back returns any of them to the list.";

/**
 * MAY THIS DOCUMENT BE CLEARED — the page's hint, never the gate.
 *
 * The gate is the server, which re-reads every send of the document and can
 * refuse for reasons this cannot see. This exists only so the page does not
 * offer a button whose answer is knowably no: a document that still needs
 * somebody, or is still on its way, is exactly what this screen is FOR.
 *
 * It asks the question of every send in the group rather than of `current`,
 * because `current` is only the newest send under the filter in force — a
 * document whose newest send arrived can still be carrying an open refusal
 * underneath it, and that document must not offer this button.
 */
export function acDocCanArchive(group: AcDocGroup): boolean {
  if (group.current.archived_at !== null) return false;
  return group.sends.every((r) => r.state !== "pending" && !r.needs_attention);
}

/** The other direction. A cleared document is one whose newest send is cleared. */
export function acDocCanRestore(group: AcDocGroup): boolean {
  return group.current.archived_at !== null;
}

/**
 * THE DENOMINATOR that line is `of`, which is NOT always the company total.
 *
 * `counts.total` counts what is ON the page, so on the Cleared tab — the one
 * filter that looks at the other shelf — it is the wrong number, and observably
 * so: three cleared documents under "3 of 1 document", on production, minutes
 * after the tab shipped. A page whose every other number was made exact to stop
 * it contradicting itself must not open a new way to do it.
 *
 * Nowhere else changes: for the four ordinary filters the company total IS what
 * the reader is being shown a slice of.
 */
export function acListTotal(d: AcOutboxResponse, state: AcFilterState): number {
  return state === "archived" ? d.counts.archived : d.counts.total;
}
