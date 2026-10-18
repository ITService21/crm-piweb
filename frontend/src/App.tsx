import { Navigate, Route, Routes, BrowserRouter } from 'react-router-dom';
import { AuthProvider, DataProvider, useAuth } from './store';
import { RealtimeProvider } from './realtime';
import { Layout } from './Layout';
import { LoginPage } from './pages/Login';
import { LeadListPage } from './pages/LeadListPage';
import { SettingsPage } from './pages/Settings';
import { Spinner } from './components/ui';

function Gate() {
  const { me, ready } = useAuth();
  if (!ready) return <Spinner />;
  if (!me) return <LoginPage />;
  return (
    <DataProvider>
      <RealtimeProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/leads" element={<LeadListPage tab="leads" />} />
            <Route path="/not-interested" element={<LeadListPage tab="not_interested" />} />
            <Route path="/converted" element={<LeadListPage tab="converted" />} />
            <Route path="/follow-ups" element={<LeadListPage tab="scheduled" />} />
            <Route path="/removed" element={<LeadListPage tab="removed" />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/leads" replace />} />
          </Route>
        </Routes>
      </RealtimeProvider>
    </DataProvider>
  );
}

export default function App() {
  return <BrowserRouter><AuthProvider><Gate /></AuthProvider></BrowserRouter>;
}
