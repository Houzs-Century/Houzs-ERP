// "View original scan" (HC-0006 T7): the file a document was read from. Renders
// nothing when the document was not scanned. Each open goes through the content
// endpoint, which records who opened it and when.
import { useEffect, useState } from 'react';
import { authedFetch } from '../lib/authed-fetch';
import { fetchDocFileBlobUrl } from '../lib/payment-voucher-queries';

export type ScanKind = 'so' | 'payment' | 'pv' | 'workshop';

export function ViewOriginalScan({ kind, documentId }: { kind: ScanKind; documentId: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ id: string }>>([]);
  /* Plain fetch, not react-query: Fleet Health has no QueryClient. A failed
     list shows no link, the same as a document that was never scanned. */
  useEffect(() => {
    let live = true;
    setFiles([]);
    if (documentId === '') return;
    authedFetch<{ files: Array<{ id: string }> }>(`/scan-files/${kind}/doc/${encodeURIComponent(documentId)}`)
      .then((r) => { if (live) setFiles(r.files); })
      .catch(() => {});
    return () => { live = false; };
  }, [kind, documentId]);
  if (files.length === 0) return null;

  const open = async (id: string) => {
    setErr(null);
    try {
      const { url } = await fetchDocFileBlobUrl(`/scan-files/${kind}/${id}/content`);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The scan could not be opened.');
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[12px]">
      {files.map((f, i) => (
        <button key={f.id} type="button" onClick={() => void open(f.id)} className="text-primary underline-offset-2 hover:underline">
          {files.length > 1 ? `View original scan ${i + 1}` : 'View original scan'}
        </button>
      ))}
      {err && <span role="alert" className="text-err">{err}</span>}
    </span>
  );
}
