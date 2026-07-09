import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useInboxStore } from './useInboxStore';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { InviteAcceptPage } from './pages/InviteAccept';
import { InboxPage } from './pages/Inbox';
import { ConversationPage } from './pages/Conversation';
import { SettingsPage } from './pages/Settings';

export function DashboardApp() {
  const status = useInboxStore((s) => s.status);
  const loadMe = useInboxStore((s) => s.loadMe);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  if (status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center bg-wa-panel text-wa-secondary">
        Loading…
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      <Route
        path="/inbox"
        element={
          <RequireAuth>
            <InboxPage />
          </RequireAuth>
        }
      />
      <Route
        path="/c/:id"
        element={
          <RequireAuth>
            <ConversationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useInboxStore((s) => s.status);
  const location = useLocation();
  if (status !== 'authed') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
