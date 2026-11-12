import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { openLoadedTab } from "../../lib/openLoadedTab";

export interface ThreadFilePreview {
  id: string;
  filename: string;
  contentType: string;
}

const OPENED_FILE_URL_LIFETIME_MILLISECONDS = 60_000;

function FileTypeIcon({ contentType }: { contentType: string }) {
  if (contentType.startsWith("image/")) return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden="true" />;
  if (contentType === "application/pdf") return <FileText className="h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden="true" />;
  return <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />;
}

export function ThreadFileChips({
  files,
  fileCount,
  onShowAll,
}: {
  files: ThreadFilePreview[];
  fileCount: number;
  onShowAll: () => void;
}) {
  const toast = useToast();
  if (files.length === 0) return null;
  const hiddenFileCount = fileCount - files.length;

  const openFile = async (file: ThreadFilePreview) => {
    try {
      await openLoadedTab(
        () => api.fetchBlobUrl(`/api/mail-center/attachments/${file.id}`, file.contentType),
        OPENED_FILE_URL_LIFETIME_MILLISECONDS,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Couldn't open ${file.filename}.`);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={() => void openFile(file)}
          title={`Open ${file.filename}`}
          className="inline-flex min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-ink/90 transition-colors hover:bg-surface-dim"
        >
          <FileTypeIcon contentType={file.contentType} />
          <span className="truncate">{file.filename}</span>
        </button>
      ))}
      {hiddenFileCount > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          aria-label={`${hiddenFileCount} more files, open the conversation`}
          className="shrink-0 rounded-full border border-border bg-surface px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-dim"
        >
          +{hiddenFileCount}
        </button>
      )}
    </div>
  );
}
