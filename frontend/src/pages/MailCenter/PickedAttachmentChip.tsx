import { Paperclip, X } from "lucide-react";
import { humanSize, type OutboundAttachment } from "./mail-attach-files";
import { isImageAttachment, useAttachmentPreviewUrl } from "./mail-attach-preview";

export function PickedAttachmentChip({
  file,
  isDisabled,
  onRemove,
}: {
  file: OutboundAttachment;
  isDisabled: boolean;
  onRemove: () => void;
}) {
  const previewUrl = useAttachmentPreviewUrl(file);
  const leadingIcon =
    previewUrl && isImageAttachment(file) ? (
      <img src={previewUrl} alt="" className="h-5 w-5 shrink-0 rounded-sm object-cover" />
    ) : (
      <Paperclip className="h-3 w-3 shrink-0 text-ink-muted" />
    );
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-dim py-1 pl-2 pr-1 text-xs text-ink">
      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${file.name}`}
          className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
        >
          {leadingIcon}
          <span className="truncate">{file.name}</span>
        </a>
      ) : (
        <>
          {leadingIcon}
          <span className="truncate">{file.name}</span>
        </>
      )}
      <span className="shrink-0 text-ink-muted">{humanSize(file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={isDisabled}
        aria-label={`Remove ${file.name}`}
        className="shrink-0 rounded p-0.5 text-ink-muted transition hover:bg-surface hover:text-ink disabled:opacity-50"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
