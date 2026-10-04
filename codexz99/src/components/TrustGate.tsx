import { useState, type ReactNode } from 'react';
import { useTrust } from './TrustContext';
import { anchorTrustSnapshot } from '../lib/trust';

export function TrustCard({ compact = false }: { compact?: boolean }) {
  const { score, loading } = useTrust();
  const [anchoring, setAnchoring] = useState(false);
  const [anchor, setAnchor] = useState<{ proofId: string; txHash: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (loading || !score) return <p className="muted">Computing trust score…</p>;

  async function snapshot() {
    setAnchoring(true);
    setErr(null);
    try {
      setAnchor(await anchorTrustSnapshot(score!));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAnchoring(false);
    }
  }

  return (
    <div className="card">
      <div className="row-between">
        <h2>Trust Score</h2>
        <span className={score.pass ? 'tag tag-ok' : 'tag tag-danger'}>{score.pass ? 'Eligible' : 'Ineligible'}</span>
      </div>

      <div className="trust-number">
        <span className={score.pass ? 'trust-value pass' : 'trust-value fail'}>{score.total}</span>
        <span className="trust-denom">/ 100</span>
      </div>

      <div className="trust-bar-wrap">
        <div className="trust-bar">
          <div className={score.pass ? 'trust-fill pass' : 'trust-fill fail'} style={{ width: `${score.total}%` }} />
          <div className="trust-marker" style={{ left: `${score.threshold}%` }} title={`Threshold ${score.threshold}`} />
        </div>
        <div className="trust-scale">
          <span>0</span>
          <span className="trust-threshold-label">threshold {score.threshold}</span>
          <span>100</span>
        </div>
      </div>

      <p className={score.pass ? 'success' : 'warn'}>
        {score.pass
          ? 'You are eligible. Market and Claims are unlocked.'
          : `You need ${score.threshold - score.total} more point${score.threshold - score.total === 1 ? '' : 's'} to reach the threshold.`}
      </p>

      {!compact && (
        <>
          <h4>Breakdown</h4>
          <table>
            <thead>
              <tr>
                <th>Factor</th>
                <th>Points</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {score.factors.map((f) => (
                <tr key={f.id}>
                  <td>{f.label}</td>
                  <td className={f.earned === f.max ? 'ok-cell' : ''}>
                    {f.earned} / {f.max}
                  </td>
                  <td className="muted small">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {score.pass && (
        <div className="button-group">
          <button onClick={snapshot} disabled={anchoring}>
            {anchoring ? 'Anchoring…' : 'Anchor score snapshot'}
          </button>
        </div>
      )}

      {anchor && (
        <div className="success">
          <p>Snapshot anchored. A counterparty can verify your score without seeing the factors.</p>
          <dl>
            <dt>Proof ID</dt>
            <dd>
              <code>{anchor.proofId}</code>
            </dd>
            <dt>TX</dt>
            <dd>
              <code>{anchor.txHash}</code>
            </dd>
          </dl>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export function TrustGaps({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { score } = useTrust();
  if (!score || score.pass) return null;
  const needed = score.threshold - score.total;

  return (
    <div className="card">
      <h2>What you need to pass</h2>
      <p className="muted">
        You have <strong className="gold">{score.total}</strong> of <strong>100</strong>. You need{' '}
        <strong className="gold">{needed}</strong> more to reach <strong>{score.threshold}</strong>.
      </p>
      <ol className="gap-list">
        {score.gaps.map((f) => (
          <li key={f.id} className="gap-item">
            <div className="gap-head">
              <span className="gap-points">+{f.action!.pointsAvailable}</span>
              <span className="gap-label">{f.label}</span>
            </div>
            <div className="gap-detail">{f.action!.label}</div>
            <button className="gap-btn" onClick={() => onNavigate(f.action!.tab)}>
              Go to {f.action!.tab}
            </button>
          </li>
        ))}
      </ol>
      {score.gaps.length === 0 && <p className="muted">Every factor is already maxed.</p>}
    </div>
  );
}

export function TrustGate({ children, moduleName, onNavigate }: { children: ReactNode; moduleName: string; onNavigate: (tab: string) => void }) {
  const { score, loading } = useTrust();

  if (loading || !score) {
    return (
      <div className="card">
        <p className="muted">Checking eligibility…</p>
      </div>
    );
  }

  if (score.pass) {
    return (
      <>
        <div className="unlock-banner">
          <span className="tag tag-ok">Unlocked</span>
          <span className="muted small">
            Trust {score.total} / 100 · {moduleName}
          </span>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="stack">
      <div className="card gate-blocked">
        <div className="row-between">
          <h2>{moduleName} is locked</h2>
          <span className="tag tag-danger">Trust {score.total} / 100</span>
        </div>
        <p>
          {moduleName} unlocks at <strong>{score.threshold}</strong>. You&apos;re at <strong>{score.total}</strong>. Earn{' '}
          <strong>{score.threshold - score.total}</strong> more points to unlock.
        </p>
        <div className="trust-bar-wrap">
          <div className="trust-bar">
            <div className="trust-fill fail" style={{ width: `${score.total}%` }} />
            <div className="trust-marker" style={{ left: `${score.threshold}%` }} />
          </div>
        </div>
      </div>
      <TrustCard />
      <TrustGaps onNavigate={onNavigate} />
    </div>
  );
}
