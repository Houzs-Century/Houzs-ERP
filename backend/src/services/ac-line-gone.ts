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
