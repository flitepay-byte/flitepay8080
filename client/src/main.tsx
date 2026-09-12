import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/Toast';
import { SocketProvider } from '@/hooks/useSocket';
import { useAuthStore } from '@/stores/auth.store';
import { RequireRole, RedirectIfAuthenticated } from '@/routes/guards';
import { AppShell } from '@/layouts/AppShell';
import { LoginPage } from '@/pages/Login';
import { CaptainProfilePage } from '@/pages/captain/Profile';
import { RegisterCaptainPage } from '@/pages/RegisterCaptain';
import { ForgotPasswordPage } from '@/pages/ForgotPassword';
import { AdminCaptainRegistrations } from '@/pages/admin/CaptainRegistrations';
import { TrackPage } from '@/pages/TrackPage';
import { AdminOverview } from '@/pages/admin/Overview';
import { AdminTaskDetail } from '@/pages/admin/TaskDetail';
import { AdminReviewQueue } from '@/pages/admin/ReviewQueue';
import { AdminParties } from '@/pages/admin/Parties';
import { AdminPartyDetail } from '@/pages/admin/PartyDetail';
import { AdminCaptains } from '@/pages/admin/Captains';
import { AdminCaptainDetail } from '@/pages/admin/CaptainDetail';
import { AdminReconciliation } from '@/pages/admin/Reconciliation';
import { AdminLogs } from '@/pages/admin/Logs';
import { AdminSettings } from '@/pages/admin/Settings';
import { AdminWallet } from '@/pages/admin/Wallet';
import { AdminTransactions } from '@/pages/admin/Transactions';
import { AdminPayments } from '@/pages/admin/Payments';
import { AdminCommissions } from '@/pages/admin/Commissions';
import { PartyOverview } from '@/pages/party/Overview';
import { PartyTasks } from '@/pages/party/Tasks';
import { PartyTaskDetail } from '@/pages/party/TaskDetail';
import { PartyImport } from '@/pages/party/Import';
import { PartyWallet } from '@/pages/party/Wallet';
import { PartyApiKeys } from '@/pages/party/ApiKeys';
import { PartyTransactions } from '@/pages/party/Transactions';
import { PartyAuditDesk } from '@/pages/party/AuditDesk';
import { CaptainHome } from '@/pages/captain/Home';
import { CaptainQueue } from '@/pages/captain/Queue';
import { CaptainTasks } from '@/pages/captain/Tasks';
import { CaptainTaskDetail } from '@/pages/captain/TaskDetail';
import { CaptainEarnings } from '@/pages/captain/Earnings';
import { CaptainWallet } from '@/pages/captain/Wallet';
import { CaptainPayIn } from '@/pages/captain/PayIn';
import { CaptainTransactions } from '@/pages/captain/Transactions';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry an auth or validation failure; it will not succeed.
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

function Shell({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

function App() {
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <Routes>
      <Route path="/login" element={<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>} />
      {/* Public. A captain registers here and waits for an administrator; none
          of these routes ever produce a session. */}
      <Route path="/register" element={<RedirectIfAuthenticated><RegisterCaptainPage /></RedirectIfAuthenticated>} />
      <Route path="/forgot-password" element={<RedirectIfAuthenticated><ForgotPasswordPage /></RedirectIfAuthenticated>} />
      <Route path="/track" element={<TrackPage />} />
      <Route path="/track/:referenceId" element={<TrackPage />} />

      <Route path="/admin" element={<RequireRole roles={['ADMIN']}><Shell><AdminOverview /></Shell></RequireRole>} />
      <Route path="/admin/review-queue" element={<RequireRole roles={['ADMIN']}><Shell><AdminReviewQueue /></Shell></RequireRole>} />
      <Route path="/admin/tasks/:taskId" element={<RequireRole roles={['ADMIN']}><Shell><AdminTaskDetail /></Shell></RequireRole>} />
      <Route path="/admin/parties" element={<RequireRole roles={['ADMIN']}><Shell><AdminParties /></Shell></RequireRole>} />
      <Route path="/admin/parties/:partyId" element={<RequireRole roles={['ADMIN']}><Shell><AdminPartyDetail /></Shell></RequireRole>} />
      <Route path="/admin/captains" element={<RequireRole roles={['ADMIN']}><Shell><AdminCaptains /></Shell></RequireRole>} />
      <Route path="/admin/captain-registrations" element={<RequireRole roles={['ADMIN']}><Shell><AdminCaptainRegistrations /></Shell></RequireRole>} />
      <Route path="/admin/captains/:captainId" element={<RequireRole roles={['ADMIN']}><Shell><AdminCaptainDetail /></Shell></RequireRole>} />
      <Route path="/admin/reconciliation" element={<RequireRole roles={['ADMIN']}><Shell><AdminReconciliation /></Shell></RequireRole>} />
      <Route path="/admin/logs" element={<RequireRole roles={['ADMIN']}><Shell><AdminLogs /></Shell></RequireRole>} />
      <Route path="/admin/settings" element={<RequireRole roles={['ADMIN']}><Shell><AdminSettings /></Shell></RequireRole>} />
      <Route path="/admin/transactions" element={<RequireRole roles={['ADMIN']}><Shell><AdminPayments /></Shell></RequireRole>} />
      <Route path="/admin/funds" element={<RequireRole roles={['ADMIN']}><Shell><AdminTransactions /></Shell></RequireRole>} />
      {/* Was this screen's path until the tabs were renamed. Kept so an old
          bookmark lands on the page it named rather than on nothing. */}
      <Route path="/admin/payments" element={<Navigate to="/admin/transactions" replace />} />
      <Route path="/admin/commissions" element={<RequireRole roles={['ADMIN']}><Shell><AdminCommissions /></Shell></RequireRole>} />
      <Route path="/admin/wallet" element={<RequireRole roles={['ADMIN']}><Shell><AdminWallet /></Shell></RequireRole>} />

      <Route path="/party" element={<RequireRole roles={['PARTY']}><Shell><PartyOverview /></Shell></RequireRole>} />
      <Route path="/party/tasks" element={<RequireRole roles={['PARTY']}><Shell><PartyTasks /></Shell></RequireRole>} />
      <Route path="/party/tasks/:taskId" element={<RequireRole roles={['PARTY']}><Shell><PartyTaskDetail /></Shell></RequireRole>} />
      <Route path="/party/import" element={<RequireRole roles={['PARTY']}><Shell><PartyImport /></Shell></RequireRole>} />
      <Route path="/party/wallet" element={<RequireRole roles={['PARTY']}><Shell><PartyWallet /></Shell></RequireRole>} />
      <Route path="/party/api-keys" element={<RequireRole roles={['PARTY']}><Shell><PartyApiKeys /></Shell></RequireRole>} />
      <Route path="/party/transactions" element={<RequireRole roles={['PARTY']}><Shell><PartyTransactions /></Shell></RequireRole>} />
      <Route path="/party/audit" element={<RequireRole roles={['PARTY']}><Shell><PartyAuditDesk /></Shell></RequireRole>} />

      <Route path="/captain" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainHome /></Shell></RequireRole>} />
      <Route path="/captain/queue" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainQueue /></Shell></RequireRole>} />
      <Route path="/captain/tasks" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainTasks /></Shell></RequireRole>} />
      <Route path="/captain/tasks/:taskId" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainTaskDetail /></Shell></RequireRole>} />
      <Route path="/captain/earnings" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainEarnings /></Shell></RequireRole>} />
      <Route path="/captain/wallet" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainWallet /></Shell></RequireRole>} />
      <Route path="/captain/profile" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainProfilePage /></Shell></RequireRole>} />
      <Route path="/captain/pay-in" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainPayIn /></Shell></RequireRole>} />
      <Route path="/captain/payments" element={<RequireRole roles={['CAPTAIN']}><Shell><CaptainTransactions /></Shell></RequireRole>} />

      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SocketProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SocketProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
