// ----------------------------------------------------------------------------
// SoLinePhotoStrip — read-only line-photo thumbnails for the V2 SO detail
// (owner 2026-08-10: "我在外面的 UI 看不到照片了吗?不能点开照片来看吗?").
// Same signed-URL discipline as SoLineCard's PhotoThumb: 30s expiry skew,
// thumb tier first with silent fall-through to the full object, ONE refetch
// on a full-image failure, then an explicit click-to-retry tile. A thumbnail
// click opens the full-size signed URL in a new tab (zoom-in cursor), never
// the .thumb sibling.
// ----------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { fetchSoItemPhotoSignedUrl } from "../../vendor/scm/lib/sales-order-queries";

const SKEW_MS = 30_000;
const cache = new Map<string, { signedUrl: string; thumbUrl?: string; expiresAt: number }>();
const thumbless = new Set<string>();
const fresh = (e?: { expiresAt: number }) => !!e && e.expiresAt - SKEW_MS > Date.now();

function Thumb({ docNo, itemId, photoKey }: { docNo: string; itemId: string; photoKey: string }) {
  const [urls, setUrls] = useState<{ signedUrl: string; thumbUrl?: string } | null>(() => {
    const c = cache.get(photoKey);
    return fresh(c) ? c! : null;
  });
  const [err, setErr] = useState<string | null>(null);
  const [useFull, setUseFull] = useState(() => thumbless.has(photoKey));
  const retried = useRef(false);

  const load = async (cancelled: () => boolean) => {
    try {
      const { signedUrl, thumbUrl, expiresAt } = await fetchSoItemPhotoSignedUrl(docNo, itemId, photoKey);
      if (cancelled()) return;
      cache.set(photoKey, { signedUrl, thumbUrl, expiresAt: new Date(expiresAt).getTime() });
      setUrls({ signedUrl, thumbUrl });
      setErr(null);
    } catch (e) {
      if (!cancelled()) setErr(e instanceof Error ? e.message : "failed");
    }
  };

  useEffect(() => {
    let gone = false;
    const c = cache.get(photoKey);
    if (fresh(c)) {
      setUrls(c!);
      return;
    }
    load(() => gone);
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docNo, itemId, photoKey]);

  const showThumb = !useFull && !!urls?.thumbUrl;
  const onError = () => {
    if (showThumb) {
      thumbless.add(photoKey);
      setUseFull(true);
      return;
    }
    if (retried.current) {
      setErr("image_load_failed");
      return;
    }
    retried.current = true;
    cache.delete(photoKey);
    setUrls(null);
    load(() => false);
  };
  const retry = () => {
    retried.current = false;
    cache.delete(photoKey);
    thumbless.delete(photoKey);
    setErr(null);
    setUrls(null);
    setUseFull(false);
    load(() => false);
  };

  const src = urls ? (showThumb ? urls.thumbUrl! : urls.signedUrl) : null;
  return (
    <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded border border-black/10">
      {src ? (
        <a
          href={urls!.signedUrl}
          target="_blank"
          rel="noreferrer"
          title="Open full size"
          className="block h-full w-full cursor-zoom-in"
        >
          <img src={src} alt="Line photo" className="h-full w-full object-cover" onError={onError} />
        </a>
      ) : err ? (
        <button
          type="button"
          onClick={retry}
          title={`${err} — click to retry`}
          className="h-full w-full cursor-pointer text-[9px] text-red-700"
        >
          err ↻
        </button>
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[10px] text-ink-muted">…</span>
      )}
    </span>
  );
}

export function SoLinePhotoStrip({
  docNo, itemId, photoKeys,
}: {
  docNo: string;
  itemId: string;
  photoKeys: string[];
}) {
  if (!photoKeys.length) return <span className="text-[11px] text-ink-muted">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {photoKeys.map((k) => (
        <Thumb key={k} docNo={docNo} itemId={itemId} photoKey={k} />
      ))}
    </span>
  );
}
