import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./store/auth";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import ScanDetailPage from "./pages/ScanDetailPage";
import NewScanPage from "./pages/NewScanPage";
import NewScanLandingPage from "./pages/NewScanLandingPage";
import ProductionScanPage from "./pages/ProductionScanPage";
import HistoryPage from "./pages/HistoryPage";
import UsersPage from "./pages/UsersPage";
import WCAGGovernancePage from "./pages/WCAGGovernancePage";
import Layout from "./components/layout/Layout";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="wcag-governance" element={<WCAGGovernancePage />} />
        {/* Ship 2b — /scans/new is now a chooser landing. */}
        {/* Stage form moved to /scans/new/stage. */}
        {/* Production interactive OTP flow at /scans/production (existing page). */}
        <Route path="scans/new" element={<NewScanLandingPage />} />
        <Route path="scans/new/stage" element={<NewScanPage />} />
        <Route path="scans/production" element={<ProductionScanPage />} />
        <Route path="scans/:id" element={<ScanDetailPage />} />
      </Route>
    </Routes>
  );
}
