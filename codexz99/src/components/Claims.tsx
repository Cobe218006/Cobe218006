import { useState } from 'react';
import { didPkh } from '../lib/vc';
import { issueClaim, verifyClaim, redeemClaim, describeClaim, type ClaimCredential, type ClaimBody, type ClaimVerification } from '../lib/claims';
import { pqAvailable } from '../lib/pq';
import { downloadBlob } from '../lib/crypto';
import { recordCredential, updateCredentialStatus } from '../lib/credentials';
import { getVault } from '../lib/store';

type Tab = 'issue' | 'present' | 'redeem';

export default function Claims({ address }: { address: string }) {
  const [tab, setTab] = useState<Tab>('issue');
  return (
    <div className="stack">
      <div className="card">
        <h2>Entitlement credentials</h2>
        <p className="muted">
          A Verifiable Credential whose subject is <em>"this holder may do X"</em> rather than a fact about a person —
          the credential <em>is</em> the right. Signed with a <strong>hybrid ECDSA + ML-DSA</strong> envelope where
          available, so it stays verifiable after ECDSA is broken by a quantum computer. If{' '}
          <code>@noble/post-quantum</code> isn&apos;t installed, ML-DSA is skipped and the credential is labelled
          classical — never claimed as post-quantum when it isn&apos;t.
        </p>
        <div className="banner banner-warn small">
          Holder binding is not implemented: a copy of the issued JSON file is currently as good as the "real"
          credential to anyone who has it. See VERIFICATION_NOTES.md.
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'issue' ? 'active' : ''} onClick={() => setTab('issue')}>
          Issue
        </button>
        <button className={tab === 'present' ? 'active' : ''} onClick={() => setTab('present')}>
          Present
        </button>
        <button className={tab === 'redeem' ? 'active' : ''} onClick={() => setTab('redeem')}>
          Redeem
        </button>
      </div>

      {tab === 'issue' && <IssueClaim address={address} />}
      {tab === 'present' && <PresentClaim address={address} />}
      {tab === 'redeem' && <RedeemClaim address={address} />}
    </div>
  );
}

function IssueClaim({ address }: { address: string }) {
  const [kind, setKind] = useState<ClaimBody['kind']>('purchase');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaimCredential | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [amount, setAmount] = useState('1000');
  const [currency, setCurrency] = useState('USDC');
  const [merchant, setMerchant] = useState('did:web:acme.example');
  const [item, setItem] = useState('Consulting retainer');
  const [assetId, setAssetId] = useState('invoice-2026-0042');
  const [assetClass, setAssetClass] = useState('invoice');
  const [basisPoints, setBasisPoints] = useState('10000');
  const [registry, setRegistry] = useState('eip155:11155111');
  const [service, setService] = useState('api:acme.example/v1');
  const [scope, setScope] = useState('read:orders, write:orders');
  const [validDays, setValidDays] = useState('90');
  const [pq, setPq] = useState<boolean | null>(null);
  if (pq === null) void pqAvailable().then(setPq);

  function buildBody(): ClaimBody {
    switch (kind) {
      case 'purchase':
        return { kind: 'purchase', amountMinor: Math.round(Number(amount) * 100), currency, merchant, item };
      case 'ownership':
        return { kind: 'ownership', assetId, assetClass, basisPoints: Number(basisPoints), registry };
      case 'access':
        return { kind: 'access', service, scope: scope.split(',').map((s) => s.trim()).filter(Boolean), validUntil: Math.floor(Date.now() / 1000) + Number(validDays) * 86400 };
    }
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const vault = getVault();
      const signer = vault.getSigner();
      if (!signer) {
        setErr('No signer available — connect a wallet or switch to local mode.');
        return;
      }
      const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);
      const vc = await issueClaim(signer, { holderDid: didPkh(chainId, address), claim: buildBody(), algorithm: pq ? 'hybrid' : 'ecdsa' });
      setResult(vc);
      recordCredential({
        id: vc.id,
        type: 'EntitlementCredential',
        label: describeClaim(vc.credentialSubject.claim).slice(0, 60),
        domain: 'finance',
        issuedAt: Date.now(),
        status: 'active',
        humanReviewed: false,
        postQuantum: vc.proof.algorithm === 'hybrid' || vc.proof.algorithm === 'ml-dsa-65',
        raw: vc,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Issue a claim</h2>
      <div className="tabs">
        <button className={kind === 'purchase' ? 'active' : ''} onClick={() => setKind('purchase')}>
          Purchase
        </button>
        <button className={kind === 'ownership' ? 'active' : ''} onClick={() => setKind('ownership')}>
          Ownership
        </button>
        <button className={kind === 'access' ? 'active' : ''} onClick={() => setKind('access')}>
          Access
        </button>
      </div>

      {kind === 'purchase' && (
        <>
          <label>
            Amount
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Currency
            <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
          </label>
          <label>
            Merchant (DID or domain)
            <input value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          </label>
          <label>
            Item
            <input value={item} onChange={(e) => setItem(e.target.value)} />
          </label>
        </>
      )}
      {kind === 'ownership' && (
        <>
          <label>
            Asset ID
            <input value={assetId} onChange={(e) => setAssetId(e.target.value)} />
          </label>
          <label>
            Asset class
            <input value={assetClass} onChange={(e) => setAssetClass(e.target.value)} />
          </label>
          <label>
            Basis points (10000 = 100%)
            <input value={basisPoints} onChange={(e) => setBasisPoints(e.target.value)} />
          </label>
          <label>
            Registry
            <input value={registry} onChange={(e) => setRegistry(e.target.value)} />
          </label>
        </>
      )}
      {kind === 'access' && (
        <>
          <label>
            Service
            <input value={service} onChange={(e) => setService(e.target.value)} />
          </label>
          <label>
            Scope (comma separated)
            <input value={scope} onChange={(e) => setScope(e.target.value)} />
          </label>
          <label>
            Valid for (days)
            <input value={validDays} onChange={(e) => setValidDays(e.target.value)} />
          </label>
        </>
      )}

      <button className="primary" onClick={submit} disabled={busy || !address}>
        {busy ? 'Signing…' : `Sign ${pq ? 'hybrid ECDSA + ML-DSA' : 'ECDSA'} claim`}
      </button>
      {err && <p className="error">{err}</p>}

      {result && (
        <div className="success">
          <p>Claim issued.</p>
          <dl>
            <dt>ID</dt>
            <dd>
              <code>{result.id}</code>
            </dd>
            <dt>Algorithm</dt>
            <dd>{result.proof.algorithm}</dd>
            <dt>Entitlement</dt>
            <dd>{describeClaim(result.credentialSubject.claim)}</dd>
          </dl>
          <button onClick={() => downloadBlob(`claim-${result.id.slice(-8)}.json`, new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))}>
            Download
          </button>
        </div>
      )}
    </div>
  );
}

function PresentClaim({ address }: { address: string }) {
  const [verdict, setVerdict] = useState<ClaimVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);

  async function handle(f: File) {
    setBusy(true);
    setErr(null);
    setVerdict(null);
    try {
      const parsed = JSON.parse(await f.text()) as ClaimCredential;
      setVerdict(await verifyClaim(parsed, didPkh(chainId, address)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Present a claim to a verifier</h2>
      <p className="muted">A merchant or service drops the claim here. All checks run offline.</p>
      <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])} disabled={busy || !address} />
      {err && <p className="error">{err}</p>}
      {verdict && (
        <div className={verdict.entitlement ? 'success' : 'error'}>
          <h3>{verdict.entitlement ? 'Claim accepted' : 'Claim rejected'}</h3>
          <ul className="checks">
            <li className={verdict.signatureOk ? 'ok' : 'fail'}>
              <span>{verdict.signatureOk ? '✓' : '✗'}</span> Signature valid
            </li>
            <li className={verdict.holderOk ? 'ok' : 'fail'}>
              <span>{verdict.holderOk ? '✓' : '✗'}</span> Presented by the named holder
            </li>
            <li className={verdict.statusOk ? 'ok' : 'fail'}>
              <span>{verdict.statusOk ? '✓' : '✗'}</span> Status active
            </li>
            <li className={verdict.unexpired ? 'ok' : 'fail'}>
              <span>{verdict.unexpired ? '✓' : '✗'}</span> Not expired
            </li>
          </ul>
          {verdict.entitlement && (
            <dl>
              <dt>Entitlement</dt>
              <dd>{describeClaim(verdict.entitlement)}</dd>
            </dl>
          )}
          {verdict.notes.length > 0 && (
            <details>
              <summary>Notes</summary>
              <ul>
                {verdict.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function RedeemClaim({ address }: { address: string }) {
  const [vc, setVc] = useState<ClaimCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);

  async function handle(f: File) {
    setMsg(null);
    setVc(JSON.parse(await f.text()) as ClaimCredential);
  }

  async function redeem() {
    if (!vc) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await redeemClaim(vc, didPkh(chainId, address));
      updateCredentialStatus(vc.id, 'redeemed');
      setMsg(`Redeemed.\nproofId ${r.proofId}\ntx ${r.redeemTxHash}`);
    } catch (e) {
      setMsg('Failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Redeem a claim</h2>
      <p className="muted">Redemption consumes the entitlement: it hashes the claim and anchors that consumption so a later verifier can see it was already spent.</p>
      <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])} />
      {vc && (
        <>
          <dl>
            <dt>ID</dt>
            <dd>
              <code>{vc.id}</code>
            </dd>
            <dt>Entitlement</dt>
            <dd>{describeClaim(vc.credentialSubject.claim)}</dd>
          </dl>
          <button className="primary" onClick={redeem} disabled={busy || !address}>
            {busy ? 'Redeeming…' : 'Redeem'}
          </button>
        </>
      )}
      {msg && <pre className="code-block">{msg}</pre>}
    </div>
  );
}
