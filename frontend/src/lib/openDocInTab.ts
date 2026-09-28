import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { markWorkspaceDocumentIntent } from "./workspaceTabs";

/* A linked document opened from a relationship map lands in its OWN tab of the
   in-app tab strip (owner 2026-09-27, with a screenshot of the strip: "在这里打开
   新的tab" — not a browser tab). The page it was opened from keeps its tab, one
   click away. Same browser window, so the company is the same as well. */
export function useOpenDocInTab(): (path: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (path: string) => {
      markWorkspaceDocumentIntent();
      navigate(path);
    },
    [navigate],
  );
}
