/* ---------------------------------------------------------------------------
   ac-line-gone — WHY a line is no longer on the ERP document.
   ---------------------------------------------------------------------------
   WHAT THE ERP DID, not what AutoCount should do about it.

   Owner 2026-09-02, asked to make the book match the ERP exactly: 「跟 inistate
   一样」 — the departed dev's connector really DELETED the line, and this one
   marked it instead, so a deleted line stayed visible in the book at Qty 0.

   The two words are not synonyms and the payload must not conflate them:

     'deleted'   the operator removed the line from the ERP. AutoCount SHOULD
                 remove it, and on a SalesOrder it can — DeleteDetail(Int64) is
                 on that class and no other (sdk-api-reference.txt: PurchaseOrder,
                 GoodsReceivedNote and DeliveryOrder all lack it).
     'cancelled' the line is still ON the ERP document, cancelled. It must stay
                 in the book, marked. Never a deletion.

   THE SERVICE DECIDES WHETHER IT CAN. This flag says what happened here; the
   host refuses the delete and retires instead when the SDK cannot delete on
   that document type, or when the book's own line has already been transferred.
   Deciding it HERE would be deciding from a copy of the book rather than the
   book. */
export type AcLineGoneReason = 'deleted' | 'cancelled';

/** A line the ERP no longer holds, named by the AutoCount key it carried.
 *  Lives here rather than in autocount-writeback.ts because the REASON above is
 *  the only thing that makes `Gone` readable, and a type split from the sentence
 *  that explains it is how the two drift. */
export interface AcRetiredLine {
  DtlKey: number;
  ItemCode: string;
  /** Omitted rather than nulled, so AcSyncService keeps the book's own text. */
  Desc2?: string | null;
  /** Absent means RETIRE — the stricter answer. */
  Gone?: AcLineGoneReason;
}

/* WHICH DOCUMENT TYPES CAN LOSE ONE LINE, and which must be rebuilt to lose it.
   Read off sdk-api-reference.txt, and pinned against that file by
   backend/tests/acLineDeletedNotRetired.test.ts so a later SDK cannot make this
   table quietly wrong.

   Owner 2026-09-02, on why iNiState only ever wrote sales orders: 「他只做 Sales
   Order 是因为他那边只有 Sales Order 的 Data Entry，我们这里是有全部 Document 的
   Data Entry 的（我们是 Full Set）。所以你需要把全部东西都 update 掉」.

   So the connector this one replaces never met the problem below. We do, on five
   of the six document types, and the answer cannot be "mark it and leave it
   visible" — that is what he could see was wrong. */
export const SDK_DELETES_ONE_LINE: Record<string, boolean> = {
  /** SalesOrder.DeleteDetail(Int64) — the only class in the 2.2 SDK with it. */
  SO: true,
  PO: false,
  GR: false,
  DO: false,
  IV: false,
  PI: false,
};

/** THE ONE RULE, in one place.
 *
 *  A line the operator DELETED must disappear from AutoCount. Where the SDK can
 *  remove a single line it removes that line; where it cannot, the only way to
 *  lose a line at all is to rebuild the details — `ClearDetails` is on the base
 *  document class, so it reaches every type.
 *
 *  Nothing here decides whether the book can SURVIVE it. The host refuses both
 *  on a document with a transferred line, read from the book's own tables,
 *  because a person can transfer inside AutoCount without telling the ERP.
 */
export function rebuildNeededToRemoveLine(
  docType: string,
  anyLineDeleted: boolean,
): boolean {
  if (!anyLineDeleted) return false;
  return SDK_DELETES_ONE_LINE[docType] !== true;
}
