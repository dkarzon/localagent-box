import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { DEFAULT_API_TOKEN } from '../api/types';

const STORAGE_KEY = 'localagent-box-api-token';

interface ApiTokenContextValue {
  token: string;
  setToken: (token: string) => void;
}

const ApiTokenContext = createContext<ApiTokenContextValue | null>(null);

export function ApiTokenProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState(() => {
    return sessionStorage.getItem(STORAGE_KEY) || DEFAULT_API_TOKEN;
  });

  const setToken = useCallback((value: string) => {
    setTokenState(value);
    sessionStorage.setItem(STORAGE_KEY, value);
  }, []);

  return (
    <ApiTokenContext.Provider value={{ token, setToken }}>
      {children}
    </ApiTokenContext.Provider>
  );
}

export function useApiToken() {
  const ctx = useContext(ApiTokenContext);
  if (!ctx) {
    throw new Error('useApiToken must be used within ApiTokenProvider');
  }
  return ctx;
}
