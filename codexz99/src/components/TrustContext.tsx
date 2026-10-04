import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { loadTrust, type TrustScore } from '../lib/trust';
import { onCredentialsChanged } from '../lib/credentials';

interface TrustCtx {
  score: TrustScore | null;
  loading: boolean;
  refresh(): Promise<void>;
}

const Ctx = createContext<TrustCtx>({ score: null, loading: true, refresh: async () => {} });

export function TrustProvider({ address, children }: { address: string; children: ReactNode }) {
  const [score, setScore] = useState<TrustScore | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setScore(await loadTrust(address));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onCredentialsChanged(() => void refresh()), [refresh]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith('codexz99.')) void refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);

  return <Ctx.Provider value={{ score, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useTrust() {
  return useContext(Ctx);
}
