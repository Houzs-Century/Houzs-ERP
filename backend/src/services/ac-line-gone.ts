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

/* THE RULE, and it is ONE sentence for all six document types.

   Owner 2026-09-02, after the old connector's own API was read off the host:

     「如果只是 edit SKU、换东西或者添加 variants 等等，我们就直接照现在的模式去做。
       那如果我们有 delete line、add line 导致了它的 line 不平整了，我们就整张重建」

   So the axis is not the document TYPE and not the SDK's shape. It is whether
   THE SET OF LINES CHANGED:

     · the same lines, edited — SKU swapped, variants added, a price changed —
       is matched line by line on the AutoCount key. That preserves every DtlKey,
       which this system needs and the old connector never did: a purchase-order
       line's key is held downstream by PODTL.FromSODtlKey, the transfer chain
       and the line photographs.
     · a line ADDED or REMOVED is a rebuild. The book is cleared and the ERP's
       list is laid down in order, so the two sides finish identical — the same
       thing `DocumentService.UpdateOrCreate` does in the connector this replaces,
       which has no add/edit/delete-line API at all (read off
       C:\InistateConnector\InistateConnector.exe through .NET reflection,
       2026-09-02; see docs/bugs/0608).

   WHY THIS REPLACED A PER-TYPE TABLE. The first version keyed off whether the
   SDK exposes DeleteDetail — true for SalesOrder, false for the other five — so
   one operator action had two behaviours decided by a detail nobody outside that
   file could see. The owner's word for it was 「规则变形」. An SDK capability is a
   MECHANISM; it may not be the rule.

   THE HOST STILL DECIDES WHETHER THE BOOK CAN SURVIVE A REBUILD. It refuses on a
   document with a transferred line, read from the book's own tables — the one
   fact the ERP may not answer from its own copy. */
export function rebuildNeededForLineSetChange(
  anyLineAdded: boolean,
  anyLineDeleted: boolean,
): boolean {
  return anyLineAdded || anyLineDeleted;
}

/* THE TWO DOCUMENTS WHOSE LINES THE ERP CREATES.
   A rebuild clears the book's details and lays ours down, so it may only ever
   be asked for a document whose lines are OURS to lay down. These two are; the
   other four are built by conversion, and their lines are where AutoCount
   records what they were converted FROM — `FromDocType` / `FromDocNo`, listed
   in `AcSyncService.DetailWanted` as "the DOWNSTREAM shape".

   REBUILDING ONE OF THOSE FOUR DESTROYS THE CONVERSION, SILENTLY. The host's
   own guard cannot catch it: `AnyLineTransferred` reads `TransferedQty`, which
   is what the document passed ONWARD, and a delivery order that has not been
   invoiced yet reads as untransferred right up to the moment its incoming link
   is cleared. AutoCount's recovery for that state is raw SQL plus Management
   Studio's Fix Deleted Document Transfer Problem (docs/bugs/0606). So the ERP
   does not ask — docs/bugs/0611. */
const ERP_OWNS_THE_LINES: ReadonlySet<string> = new Set(['SO', 'PO']);

/** Whether a rebuild is permissible AT ALL for this document.
 *
 *  Two independent reasons to refuse, and both are absolute: the document was
 *  built by conversion (above), or something downstream holds its keys —
 *  `rebuildBlocked` names a sales order with a purchase order raised from it,
 *  whose `PODTL.FromSODtlKey` links would be voided by reissuing them
 *  (scm/lib/so-po-raised.ts, docs/bugs/0609).
 *
 *  An explicit `rebuild: true` from a caller does NOT override either. A caller
 *  asking is a preference; these two are facts about the account book.
 */
/** The ERP row ids behind one composed detail — a sofa build is several rows.
 *
 *  Lives here because a REBUILD needs it for EVERY line: the details are cleared
 *  and re-added, so every key the book returns is a new one and the ERP has to
 *  learn all of them. Until it did, the ERP kept the keys of lines that no
 *  longer existed and the NEXT edit of that document was guaranteed to fail with
 *  "line <dead key> not found" (docs/bugs/0621).
 */
export function erpLineIdsOf(
  sourceIndexes: readonly number[],
  lines: ReadonlyArray<{ id?: unknown }>,
): string[] {
  return sourceIndexes
    .map((ix) => lines[ix]?.id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export function rebuildAllowed(
  opts: { rebuildBlocked?: string },
  docType: string,
): boolean {
  if (opts.rebuildBlocked) return false;
  return ERP_OWNS_THE_LINES.has(String(docType).toUpperCase());
}

/** The whole decision, so `composeEdit` carries one line and no arithmetic. */
export function shouldRebuild(
  opts: { newLineIds?: ReadonlySet<string>; rebuild?: boolean; rebuildBlocked?: string },
  docType: string,
  retired: readonly AcRetiredLine[],
): boolean {
  if (!rebuildAllowed(opts, docType)) return false;
  if (opts.rebuild) return true;
  return rebuildNeededForLineSetChange(
    (opts.newLineIds?.size ?? 0) > 0,
    retired.some((r) => r.Gone === 'deleted'),
  );
}
