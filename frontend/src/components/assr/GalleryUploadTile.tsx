import type { ReactElement } from "react";
import { PlusCircle } from "lucide-react";

export interface GalleryUploadTileProps {
  label: string;
  isUploading: boolean;
  onFiles: (files: File[]) => void;
}

export function GalleryUploadTile({ label, isUploading, onFiles }: GalleryUploadTileProps): ReactElement {
  return (
    <label className="flex h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-bg/30 text-center text-[11px] font-semibold text-ink-secondary hover:border-primary/40">
      <PlusCircle size={18} className="text-primary" />
      {isUploading ? "Uploading..." : label}
      <input
        type="file"
        accept="image/*,video/mp4,video/quicktime,video/webm,.pdf"
        multiple
        className="hidden"
        disabled={isUploading}
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </label>
  );
}
