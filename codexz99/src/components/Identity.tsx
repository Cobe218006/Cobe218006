import { useState } from 'react';
import canonicalize from 'canonicalize';
import { getVault } from '../lib/store';
import { sha256Hex, downloadBlob } from '../lib/crypto';
import { didPkh } from '../lib/vc';
import { recordCredential } from '../lib/credentials';

interface IdentityStatement {
  name: string;
  statement: string;
  did: string;
  sealedAt: string;
}

interface SignedIdentityStatement {
  body: IdentityStatement;
  signature: string;
  contentHash: string;
}

export default function Identity({ address }: { address: string }) {
  const [name, setName] = useState('');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signed, setSigned] = useState<SignedIdentityStatement | null>(null);
  const [anchor, setAnchor] = useState<{ proofId: string; txHash: string } | null>(null);

  async function seal() {
    setErr(null);
    setBusy(true);
    try {
      const vault = getVault();
      const signer = vault.getSigner();
      if (!signer) throw new Error('No signer available.');
      const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);
      const body: IdentityStatement = {
        name,
        statement,
        did: didPkh(chainId, address),
        sealedAt: new Date().toISOString(),
      };
      const canonicalJson = canonicalize(body)!;
      const signature = await signer.signMessage(canonicalJson);
      const contentHash = await sha256Hex(canonicalJson);
      const result: SignedIdentityStatement = { body, signature, contentHash };
      setSigned(result);

      localStorage.setItem('codexz99.identity.sealed', '1');
      recordCredential({
        id: contentHash,
        type: 'SelfAttestedIdentityStatement',
        label: `Identity · ${body.name || body.did}`,
        domain: 'other',
        issuedAt: Date.now(),
        status: 'active',
        humanReviewed: false,
        postQuantum: false,
        raw: result,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function anchorIt() {
    if (!signed) return;
    setBusy(true);
    setErr(null);
    try {
      const { proofId, txHash } = await getVault().anchor(signed.contentHash, `urn:identity:${signed.body.did}`, `Identity statement: ${signed.body.name}`);
      setAnchor({ proofId, txHash });
      localStorage.setItem('codexz99.identity.anchored', '1');
      window.dispatchEvent(new Event('codexz99:credentials:changed'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Identity statement</h2>
      <p className="muted">
        A self-attested statement you sign with your key. This is NOT identity verification — it proves the holder
        of this key wrote these words at this time, nothing about who that person actually is in the real world.
      </p>

      {!signed && (
        <>
          <label>
            Name or handle
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Statement
            <textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={3} />
          </label>
          <button className="primary" onClick={seal} disabled={busy || !address || !statement.trim()}>
            {busy ? 'Signing…' : 'Seal statement'}
          </button>
        </>
      )}

      {signed && (
        <div className="success">
          <p>Statement sealed and signed.</p>
          <dl>
            <dt>DID</dt>
            <dd>
              <code>{signed.body.did}</code>
            </dd>
            <dt>Content hash</dt>
            <dd>
              <code>{signed.contentHash}</code>
            </dd>
          </dl>
          <div className="button-group">
            <button onClick={anchorIt} disabled={busy || !!anchor}>
              {anchor ? 'Anchored' : busy ? 'Anchoring…' : 'Anchor on-chain'}
            </button>
            <button
              onClick={() =>
                downloadBlob(`identity-${signed.contentHash.slice(2, 10)}.json`, new Blob([JSON.stringify(signed, null, 2)], { type: 'application/json' }))
              }
            >
              Download
            </button>
          </div>
          {anchor && (
            <p className="small mono">
              proofId {anchor.proofId} · tx {anchor.txHash}
            </p>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
