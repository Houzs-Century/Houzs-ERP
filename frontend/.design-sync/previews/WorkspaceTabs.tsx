import {
  MemoryRouter,
  WorkspaceTabs,
  markWorkspaceOpenIntent,
  recordWorkspaceVisit,
} from "autocount-sync-frontend";

// Workspace tab strip (top-chrome 2b, #1128/#1142) — rendered inline on the
// left of TopNavbar's single 52px bar. Tabs live in a sessionStorage-backed
// store: seed it through the REAL store API before render (sidebar-intent +
// visit = spawn a tab), so the strip shows a believable working set. The
// component itself takes no props; active tab = petrol underline, ✕ closes.

try {
  sessionStorage.removeItem("houzs.workspaceTabs.v1");
} catch {
  /* private mode */
}
markWorkspaceOpenIntent();
recordWorkspaceVisit("/", "");
markWorkspaceOpenIntent();
recordWorkspaceVisit("/scm/sales-orders", "");
markWorkspaceOpenIntent();
recordWorkspaceVisit("/scm/delivery-orders", "");
markWorkspaceOpenIntent();
recordWorkspaceVisit("/assr", "");

export const Strip = () => (
  <MemoryRouter initialEntries={["/assr"]}>
    <div className="flex h-[52px] w-[880px] items-stretch border-b border-border bg-surface px-3">
      <WorkspaceTabs />
    </div>
  </MemoryRouter>
);
