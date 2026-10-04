import { useMemo, useState } from 'react';
import { getVault } from '../lib/store';
import { listCredentials } from '../lib/credentials';

interface Lender {
  name: string;
  category: 'lending' | 'rwa' | 'startup';
  chain: string;
  requires: string[];
  blurb: string;
  url: string;
}

// Real protocols, for reference only — see the disclaimer in ApplyPanel.
// None of these integrations are wired up; nothing here contacts them.
const LENDERS: Lender[] = [
  { name: 'Aave V3', category: 'lending', chain: 'Ethereum · Base · Arbitrum · Polygon', requires: ['protocol-fundamentals-v1', 'KYC'], blurb: 'Overcollateralized money market.', url: 'https://aave.com' },
  { name: 'Compound III', category: 'lending', chain: 'Ethereum · Base', requires: ['protocol-fundamentals-v1'], blurb: 'Comet markets.', url: 'https://compound.finance' },
  { name: 'Maple Finance', category: 'lending', chain: 'Ethereum · Solana', requires: ['KYC', 'CompanyIncorporation'], blurb: 'Institutional undercollateralized lending.', url: 'https://maple.finance' },
  { name: 'Goldfinch', category: 'rwa', chain: 'Ethereum', requires: ['CompanyIncorporation', 'KYC'], blurb: 'Real-world asset lending.', url: 'https://goldfinch.finance' },
  { name: 'Centrifuge', category: 'rwa', chain: 'Ethereum · Base', requires: ['CompanyIncorporation', 'KYC'], blurb: 'Tokenizes invoices, royalties, and mortgages.', url: 'https://centrifuge.io' },
];

export default function Market({ address }: { address: string }) {
  const [filter, setFilter] = useState<Lender['category'] | 'all'>('all');
  const [selected, setSelected] = useState<Lender | null>(null);
  const filtered = useMemo(() => (filter === 'all' ? LENDERS : LENDERS.filter((l) => l.category === filter)), [filter]);

  return (
    <div className="stack">
      <div className="card">
        <h2>Market</h2>
        <div className="banner banner-warn">
          <strong>This tab is a mockup.</strong> The protocols listed are real, but nothing here is integrated with
          any of them. "Apply" anchors a local record and does not submit anything to Aave, Maple Finance, Compound,
          or any other named company.
        </div>
        <div className="tabs">
          {(['all', 'lending', 'rwa'] as const).map((c) => (
            <button key={c} className={filter === c ? 'active' : ''} onClick={() => setFilter(c)}>
              {c === 'all' ? 'All' : c === 'lending' ? 'DeFi lenders' : 'Real-world assets'}
            </button>
          ))}
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Requires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.name}>
                <td>
                  <div>{l.name}</div>
                  <div className="muted small">{l.chain}</div>
                </td>
                <td>
                  {l.requires.map((r) => (
                    <span key={r} className="tag tag-ok" style={{ marginRight: 4 }}>
                      {r}
                    </span>
                  ))}
                </td>
                <td>
                  <button onClick={() => setSelected(l)}>Apply</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && <ApplyPanel lender={selected} address={address} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ApplyPanel({ lender, address, onClose }: { lender: Lender; address: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setResult(null);
    try {
      const hasCert = listCredentials().some((c) => c.status === 'active');
      if (!hasCert) {
        setResult('You hold no active credentials yet. Go to Certify first.');
        return;
      }
      const applicationId = crypto.randomUUID();
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${lender.name}:${address}:${applicationId}`));
      const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      const { proofId } = await getVault().anchor(hex, `urn:application:${applicationId}`, `Mock application: ${lender.name}`);
      setResult(`Local mock application anchored (proofId ${proofId}). This was NOT sent to ${lender.name} — see the disclaimer above.`);
    } catch (e) {
      setResult('Failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row-between">
        <h2>{lender.name}</h2>
        <button onClick={onClose}>Close</button>
      </div>
      <p>{lender.blurb}</p>
      <dl>
        <dt>Chain</dt>
        <dd>{lender.chain}</dd>
        <dt>Requires</dt>
        <dd>{lender.requires.join(', ')}</dd>
        <dt>Homepage</dt>
        <dd>
          <a href={lender.url} target="_blank" rel="noreferrer">
            {lender.url}
          </a>
        </dd>
      </dl>
      <div className="banner banner-warn small">This button does not contact {lender.name}. It only anchors a local mock-application record.</div>
      <button className="primary" onClick={apply} disabled={busy || !address}>
        {busy ? 'Anchoring…' : 'Anchor mock application'}
      </button>
      {result && <pre className="code-block">{result}</pre>}
    </div>
  );
}
