import { Routes, Route, Navigate } from "react-router-dom";
import { TrackForm } from "./pages/TrackForm";
import { PortalCaseDetailPage } from "./pages/PortalCaseDetail";
import { PortalSupplierCasePage } from "./pages/PortalSupplierCase";


export function PortalApp() {
  return (
    <Routes>
      <Route path="/track" element={<TrackForm />} />
      <Route path="/portal/case/:ref/:token" element={<PortalCaseDetailPage />} />
      <Route path="/portal/case/:token" element={<PortalCaseDetailPage />} />
      <Route path="/portal/supplier/:token" element={<PortalSupplierCasePage />} />
      <Route path="*" element={<Navigate to="/track" replace />} />
    </Routes>
  );
}
