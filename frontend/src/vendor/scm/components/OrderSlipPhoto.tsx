/* OrderSlipPhoto — the customer's handwritten slip, on the sales order.

   Owner, 2026-09-13: 「如果电话版本我用 upload 照片 OCR 的话，那这个照片 OCR 它是
   会秀在我的电脑版本的哪里呢？」

   The honest answer at the time was: nowhere he would look. The photo IS kept
   on the order (`scm.mfg_sales_orders.slip_image_key`, mig 0033) and the phone
   shows it, but the DESKTOP route `/scm/sales-orders/:docNo` serves
   SalesOrderDetailV2, which carried no reference to it at all — confirmed on
   production, 0 hits in that page's shipped chunk. The only desktop rendering
   lived in SalesOrderDetail, the older page reached by pressing Edit. So a
   salesperson photographed a slip on the phone and the office could not see it
   without editing the order.

   This is the card, lifted out so the two desktop surfaces cannot drift again.
   The phone keeps its own thumbnail-and-viewer treatment, which is right for a
   touch screen — the parity that matters is that the photo is REACHABLE on
   both, not that the markup matches. */

import { useEffect, useState } from 'react';
import { fetchScanSlipImageBlobUrl } from '../lib/slip';

export type OrderSlipPhotoProps = {
  /** `slip_image_key` off the sales-order header. */
  imageKey: string;
  title?: string;
  alt?: string;
  /** Largest width the image is drawn at; it always shrinks to fit. */
  maxWidth?: number;
};

export function OrderSlipPhoto({
  imageKey,
  title = 'Order slip',
  alt = 'The customer\'s handwritten order slip',
  maxWidth = 360,
}: OrderSlipPhotoProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setSrc(null);
    setError(null);
    fetchScanSlipImageBlobUrl(imageKey)
      .then((u) => {
        /* Revoke on the losing race too: an image key that changes under a
           mounted card would otherwise leak one blob URL per change. */
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setSrc(u);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Something went wrong.'); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey]);

  return (
    <div>
      {error ? (
        /* Said out loud rather than rendered as an empty card: "no photo" and
           "the photo would not load" look identical when a failure is silent,
           and on a document the first one is a fact about the order. */
        <div className="text-[12.5px] text-danger" role="status">
          The order slip photo could not be loaded, which is not the same as this
          order having none. {error}
        </div>
      ) : src ? (
        <a href={src} target="_blank" rel="noreferrer" title={`${title} — open full size in a new tab`}>
          <img
            src={src}
            alt={alt}
            style={{
              maxWidth, width: '100%', height: 'auto', cursor: 'zoom-in',
              border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: '#fff',
            }}
          />
        </a>
      ) : (
        <div className="text-[12.5px] text-ink-muted">Loading…</div>
      )}
    </div>
  );
}
