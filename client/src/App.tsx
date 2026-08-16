import { useEffect, useRef, useState, useCallback } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from './api/client';
import type { QueueOnBranchPrefill, Repo } from './api/types';
import { AppShell } from './components/layout/AppShell';
import { ApiTokenProvider } from './hooks/useApiToken';
import { agentSessionPath, getPageId, parseAgentSessionId } from './navigation';
import { AgentSessionPage } from './pages/AgentSessionPage';
import { AgentSessionsPage } from './pages/AgentSessionsPage';
import { RepositoriesPage } from './pages/RepositoriesPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const page = getPageId(pathname);
  const agentSessionId = parseAgentSessionId(pathname);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingNewOrchestration, setPendingNewOrchestration] = useState(false);
  const [queuePrefill, setQueuePrefill] = useState<QueueOnBranchPrefill | null>(null);
  const newOrchestrationRef = useRef<(() => void) | null>(null);

  const loadRepos = useCallback(async () => {
    try {
      const data = await apiFetch<{ repos?: Repo[] }>('/api/v1/repos');
      setRepos(data.repos || []);
    } catch (err) {
      setRepos([]);
      throw err;
    }
  }, []);

  useEffect(() => {
    void loadRepos().catch(() => {});
  }, [loadRepos]);

  useEffect(() => {
    setSearchQuery('');
  }, [page]);

  const handleNewOrchestration = () => {
    setQueuePrefill(null);
    if (page !== 'agents' || agentSessionId) {
      setPendingNewOrchestration(true);
      navigate('/agents');
      return;
    }
    newOrchestrationRef.current?.();
  };

  const handleQueueAnother = (prefill: QueueOnBranchPrefill) => {
    setPendingNewOrchestration(false);
    setQueuePrefill(prefill);
    if (page !== 'agents' || agentSessionId) {
      navigate('/agents');
    }
  };

  if (pathname === '/') {
    return <Navigate to="/agents" replace />;
  }

  return (
    <ApiTokenProvider>
      <AppShell page={page} onNewOrchestration={handleNewOrchestration}>
        {page === 'agents' && agentSessionId ? (
          <AgentSessionPage
            agentId={agentSessionId}
            repos={repos}
            onQueueAnother={handleQueueAnother}
          />
        ) : null}
        {page === 'agents' && !agentSessionId ? (
          <AgentSessionsPage
            repos={repos}
            searchQuery={agentSessionId ? '' : searchQuery}
            openNewOnMount={pendingNewOrchestration}
            queuePrefill={queuePrefill}
            onNewOrchestrationOpened={() => setPendingNewOrchestration(false)}
            onQueuePrefillConsumed={() => setQueuePrefill(null)}
            onRegisterNewOrchestration={(open) => {
              newOrchestrationRef.current = open;
            }}
            onSessionOpen={(id) => navigate(agentSessionPath(id))}
          />
        ) : null}
        {page === 'repos' ? (
          <RepositoriesPage searchQuery={searchQuery} repos={repos} onRefreshRepos={loadRepos} />
        ) : null}
        {page === 'settings' ? <SettingsPage searchQuery={searchQuery} /> : null}
      </AppShell>
    </ApiTokenProvider>
  );
}
