import { useState } from 'react';
import { ModeBanner, useWallet, WalletPill, type WalletState } from './components/Shell';
import ErrorBoundary from './components/ErrorBoundary';
import { TrustProvider, useTrust } from './components/TrustContext';
import { TrustCard, TrustGaps, TrustGate } from './components/TrustGate';
import Proofs from './components/Proofs';
import Identity from './components/Identity';
import Certify from './components/Certify';
import Market from './components/Market';
import Claims from './components/Claims';
import { getVault } from './lib/store';

type TabId = 'home' | 'proofs' | 'identity' | 'certify' | 'market' | 'claims';

const TABS: { id: TabId; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'proofs', label: 'Proofs' },
  { id: 'identity', label: 'Identity' },
  { id: 'certify', label: 'Certify' },
  { id: 'market', label: 'Market' },
  { id: 'claims', label: 'Claims' },
];

function Inner({ tab, setTab, wallet }: { tab: TabId; setTab: (t: TabId) => void; wallet: WalletState }) {
  const mode = getVault().mode;

  return (
    <div className="app">
      <header className="app-header">
        <h1>CODEXZ 99</h1>
        <WalletPill address={wallet.address} onClick={wallet.connect} />
      </header>

      <ModeBanner />
      {wallet.error && <p className="error">{wallet.error}</p>}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <ErrorBoundary>
        {tab === 'home' && <Home setTab={setTab} />}
        {tab === 'proofs' && <Proofs address={wallet.address} />}
        {tab === 'identity' && <Identity address={wallet.address} />}
        {tab === 'certify' && <Certify address={wallet.address} />}
        {tab === 'market' && (
          <TrustGate moduleName="Market" onNavigate={(t) => setTab(t as TabId)}>
            <Market address={wallet.address} />
          </TrustGate>
        )}
        {tab === 'claims' && (
          <TrustGate moduleName="Claims" onNavigate={(t) => setTab(t as TabId)}>
            <Claims address={wallet.address} />
          </TrustGate>
        )}
      </ErrorBoundary>

      {mode === 'local' && (
        <p className="muted small center top-gap">
          Local mode. Set VITE_MODE=chain plus VITE_RPC_URL/VITE_CONTRACT_ADDRESS in .env for real wallet signatures and
          on-chain anchors.
        </p>
      )}
    </div>
  );
}

function Home({ setTab }: { setTab: (t: TabId) => void }) {
  const { score } = useTrust();
  return (
    <div className="stack">
      <TrustCard />
      {score && !score.pass && <TrustGaps onNavigate={(t) => setTab(t as TabId)} />}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<TabId>('home');
  const wallet = useWallet();
  return (
    <TrustProvider address={wallet.address}>
      <Inner tab={tab} setTab={setTab} wallet={wallet} />
    </TrustProvider>
  );
}
