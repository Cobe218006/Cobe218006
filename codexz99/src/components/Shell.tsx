import { useEffect, useState } from 'react';
import { getVault, shortAddress } from '../lib/store';

export interface WalletState {
  address: string;
  connect(): Promise<void>;
  error: string | null;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    try {
      setAddress(await getVault().connect());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const vault = getVault();
        if (vault.mode === 'local') setAddress(await vault.connect());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return { address, connect, error };
}

export function ModeBanner() {
  const mode = getVault().mode;
  return (
    <div className={`mode-banner mode-${mode}`}>
      {mode === 'local'
        ? 'LOCAL MODE · a throwaway key lives in this browser · signatures are real, nothing is on a public chain'
        : 'CHAIN MODE · wallet connected · anchors are real and permanent'}
    </div>
  );
}

export function WalletPill({ address, onClick }: { address: string; onClick: () => void }) {
  if (!address) {
    return (
      <button type="button" onClick={onClick}>
        Connect
      </button>
    );
  }
  return <span className="pill">{shortAddress(address)}</span>;
}
