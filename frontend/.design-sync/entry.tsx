// Auto-generated synth entry for design-sync. Re-exports every component
// from src/components/ so the converter can bundle them via esbuild.

export * from '../src/components/AnnouncementBanner';
// Context providers — connected components read these; exported so previews
// can wrap them with the SAME context instance the bundle uses (an imported
// second copy would create a mismatched context and the hooks would throw).
export { AuthProvider } from '../src/auth/AuthContext';
export { NotificationsProvider } from '../src/hooks/useNotifications';
export { BreadcrumbsProvider } from '../src/hooks/useBreadcrumbs';
// Router context for nav components (Sidebar, TopNavbar, MobileTabBar,
// Breadcrumbs, QuickActionsFAB) — same single-instance rule as above.
export { MemoryRouter } from 'react-router-dom';
// TanStack Query — useQuery-backed components (PnlCalendar, scm-v2 lists)
// need the provider + the app's client from the SAME bundle instance.
export { QueryClient, QueryClientProvider } from '@tanstack/react-query';
export { queryClient } from '../src/lib/queryClient';
// SCM notify dialog context — DetailListingShell calls useNotify() at mount.
export { NotifyProvider } from '../src/vendor/scm/components/NotifyDialog';
// App toast context — PullToRefresh (inside Layout) calls useToast().
export { ToastProvider } from '../src/hooks/useToast';
// Promise-based confirm/prompt dialog context — added to source recently;
// TopNavbar (and anything Layout renders) calls useDialog() and throws
// without this wrapper. Same single-instance rule as the others.
export { DialogProvider } from '../src/hooks/useDialog';
// Workspace-tab store helpers — previews seed the strip through the REAL
// store (sidebar-intent + visit = spawn a tab); same single-instance rule
// as the providers above (a second bundled copy would be a separate store).
export { markWorkspaceOpenIntent, recordWorkspaceVisit } from '../src/lib/workspaceTabs';
export * from '../src/components/AndroidInstallGuide';
export * from '../src/components/Avatar';
export * from '../src/components/Badge';
export * from '../src/components/Breadcrumbs';
export * from '../src/components/BrowserPushSink';
export * from '../src/components/Button';
export * from '../src/components/ColorPicker';
export * from '../src/components/ColumnsPanel';
export * from '../src/components/Dashboard';
export * from '../src/components/DataTable';
export * from '../src/components/DetailLayout';
export * from '../src/components/DocumentLinesExpansion';
export * from '../src/components/EmptyState';
export * from '../src/components/ExpandableText';
export * from '../src/components/FilterPills';
export * from '../src/components/Gate';
export * from '../src/components/GlobalSearch';
export * from '../src/components/HubGrid';
export * from '../src/components/InlineEdit';
export * from '../src/components/IosInstallGuide';
export * from '../src/components/Layout';
export * from '../src/components/ListPager';
export * from '../src/components/LookupManager';
export * from '../src/components/MediaLightbox';
export * from '../src/components/MobileTabBar';
export * from '../src/components/NewVersionBanner';
export * from '../src/components/NotificationBell';
export * from '../src/components/Pagination';
export * from '../src/components/Panel';
export * from '../src/components/PasswordStrengthMeter';
export * from '../src/components/PnlCalendar';
export * from '../src/components/PresenceButton';
export * from '../src/components/PresencePanel';
export * from '../src/components/ProjectChat';
export * from '../src/components/ProjectGantt';
export * from '../src/components/PullToRefresh';
export * from '../src/components/PwaBanners';
export * from '../src/components/QuickActionsFAB';
export * from '../src/components/ResetFiltersButton';
export * from '../src/components/ResizableDetailDrawer';
export * from '../src/components/ResizableDrawer';
export * from '../src/components/RouteFallback';
export * from '../src/components/RowActionsMenu';
export * from '../src/components/SearchProgress';
export * from '../src/components/SearchScopeHint';
export * from '../src/components/Sidebar';
export * from '../src/components/Skeleton';
export * from '../src/components/StatCard';
export * from '../src/components/StatusDot';
export * from '../src/components/TabStrip';
export * from '../src/components/TopNavbar';
export * from '../src/components/UdfCell';
export * from '../src/components/WorkspaceTabs';
export * from '../src/components/scm-v2/DetailListingShell';
export * from '../src/components/scm-v2/HeroImageEditor';
export * from '../src/components/scm-v2/PhotoGallery';
export * from '../src/components/scm-v2/PoAmendmentCreateModal';
