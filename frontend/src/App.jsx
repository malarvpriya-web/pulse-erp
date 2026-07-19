import { lazy, Suspense, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import ForcePasswordChange from "./pages/ForcePasswordChange";
import ErrorBoundary from "./components/ErrorBoundary";

const SetupWizardPage = lazy(() => import('@/features/settings/pages/SetupWizard'));
const PublicSigning   = lazy(() => import('@/features/documents/pages/PublicSigning'));

function App() {
  const { isLoggedIn, initializing, needsSetup, user } = useAuth();
  const mustChangePassword = isLoggedIn && user?.must_change_password === true;
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const navigate = useNavigate();
  const setPage = (pg, params) => {
    const base = pg === 'Home' ? '/' : `/${pg}`;
    if (params && Object.keys(params).length > 0) {
      navigate(`${base}?${new URLSearchParams(params).toString()}`);
    } else {
      navigate(base);
    }
  };

  if (initializing) {
    return <div style={{ padding: '50px', textAlign: 'center' }}>Loading...</div>;
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route
          path="/login"
          element={isLoggedIn ? <Navigate to="/" replace /> : <Login />}
        />
        {/* Forced first-login password change — renders fullscreen, blocks the app
            until the temporary password is replaced. */}
        <Route
          path="/ForcePasswordChange"
          element={
            !isLoggedIn
              ? <Navigate to="/login" replace />
              : mustChangePassword
                ? <ForcePasswordChange />
                : <Navigate to="/" replace />
          }
        />
        {/* Public no-login signing surface — token-gated, renders fullscreen */}
        <Route
          path="/sign/:token"
          element={
            <Suspense fallback={<div style={{ padding: '50px', textAlign: 'center' }}>Loading…</div>}>
              <PublicSigning />
            </Suspense>
          }
        />
        {/* Wizard route renders fullscreen — no sidebar or topbar */}
        <Route
          path="/SetupWizard"
          element={
            !isLoggedIn
              ? <Navigate to="/login" replace />
              : mustChangePassword
                ? <Navigate to="/ForcePasswordChange" replace />
                : (
                  <Suspense fallback={<div style={{ padding: '50px', textAlign: 'center' }}>Loading…</div>}>
                    <SetupWizardPage setPage={setPage} />
                  </Suspense>
                )
          }
        />
        {/* Finance consolidation redirects — old page-key paths → consolidated pages */}
        <Route path="/JournalEntry"          element={<Navigate to="/AccountingEngine" replace />} />
        <Route path="/ChartOfAccounts"       element={<Navigate to="/AccountingEngine" replace />} />
        <Route path="/PeriodClosing"         element={<Navigate to="/AccountingEngine" replace />} />
        <Route path="/FinancialStatements"   element={<Navigate to="/AccountingEngine" replace />} />
        <Route path="/FinancialRatios"       element={<Navigate to="/AccountingEngine" replace />} />
        <Route path="/CustomerOutstanding"   element={<Navigate to="/ReceivablesPage" replace />} />
        <Route path="/CreditNotes"           element={<Navigate to="/ReceivablesPage" replace />} />
        <Route path="/SupplierOutstanding"   element={<Navigate to="/PayablesPage" replace />} />
        <Route path="/SupplierBills"         element={<Navigate to="/PayablesPage" replace />} />
        <Route path="/DebitNotes"            element={<Navigate to="/PayablesPage" replace />} />
        <Route path="/ReportPurchase"        element={<Navigate to="/PayablesPage" replace />} />
        <Route path="/PurchaseDashboard"     element={<Navigate to="/PayablesPage" replace />} />
        <Route path="/BankAccounts"          element={<Navigate to="/PaymentBatch" replace />} />
        <Route path="/PDCManagement"         element={<Navigate to="/PaymentBatch" replace />} />
        <Route path="/ForexManagement"       element={<Navigate to="/PaymentBatch" replace />} />
        <Route path="/PaymentGateway"        element={<Navigate to="/PaymentBatch" replace />} />
        <Route path="/BudgetVsActuals"       element={<Navigate to="/BudgetManagement" replace />} />
        <Route path="/CostCenters"           element={<Navigate to="/AccountingEngine" replace />} />
        <Route path="/Tickets"              element={<Navigate to="/SupportDashboard" replace />} />

        {/* Attendance settings consolidation redirects */}
        <Route path="/GeneralSettings"    element={<Navigate to="/AttendanceSettings?tab=general"     replace />} />
        <Route path="/AttendancePolicies" element={<Navigate to="/AttendanceSettings?tab=policies"    replace />} />
        <Route path="/ShiftManagement"    element={<Navigate to="/AttendanceSettings?tab=shifts"      replace />} />
        <Route path="/GeoFencing"         element={<Navigate to="/AttendanceSettings?tab=geo-fencing" replace />} />
        <Route path="/DeviceManagement"   element={<Navigate to="/AttendanceSettings?tab=devices"     replace />} />
        <Route path="/FaceAttendance"     element={<Navigate to="/AttendanceSettings?tab=face"        replace />} />
        {/* HR module duplicates redirect to Attendance Settings */}
        <Route path="/BiometricAccess"    element={<Navigate to="/AttendanceSettings?tab=devices"     replace />} />

        <Route
          path="/:page?"
          element={
            isLoggedIn
              ? mustChangePassword
                ? <Navigate to="/ForcePasswordChange" replace />
                : needsSetup
                  ? <Navigate to="/SetupWizard" replace />
                  : <Layout selectedEmployee={selectedEmployee} setSelectedEmployee={setSelectedEmployee} />
              : <Navigate to="/login" replace />
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;
