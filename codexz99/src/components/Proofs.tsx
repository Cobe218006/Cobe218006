import { useEffect, useState } from 'react';
import { getVault, type ProofRecord } from '../lib/store';
import { sha256Hex } from '../lib/crypto';

export default function Proofs({ address }: { address: string }) {
  const [records, setRecords] = useState<ProofRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setRecords(await getVault().list(address));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function anchorText() {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const hash = await sha256Hex(text);
      await getVault().anchor(hash, `urn:note:${crypto.randomUUID()}`, label || 'Anchored note');
      setText('');
      setLabel('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function anchorFile(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(buf);
      await getVault().anchor(hash, `urn:file:${file.name}`, label || file.name);
      setLabel('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Anchor evidence</h2>
        <p className="muted">
          Anchoring commits a SHA-256 hash of what you give it — not the content itself. Anyone who later has the
          same bytes can prove they match; nobody can recover the original content from the hash alone.
        </p>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What is this?" />
        </label>
        <label>
          Text to anchor
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        </label>
        <div className="button-group">
          <button className="primary" onClick={anchorText} disabled={busy || !text.trim()}>
            {busy ? 'Anchoring…' : 'Anchor text'}
          </button>
          <label className="file-button">
            Anchor a file
            <input type="file" hidden onChange={(e) => e.target.files?.[0] && anchorFile(e.target.files[0])} disabled={busy} />
          </label>
        </div>
        {err && <p className="error">{err}</p>}
      </div>

      <div className="card">
        <h2>Your anchored proofs</h2>
        {loading && <p className="muted">Loading…</p>}
        {!loading && records.length === 0 && <p className="muted">No proofs anchored yet.</p>}
        {!loading && records.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Hash</th>
                <th>When</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.contentHash}>
                  <td>{r.label || <span className="muted">(none)</span>}</td>
                  <td className="mono small">{r.contentHash.slice(0, 18)}…</td>
                  <td className="small">{new Date(r.timestamp * 1000).toLocaleString()}</td>
                  <td>
                    <span className={r.revoked ? 'tag tag-danger' : 'tag tag-ok'}>{r.revoked ? 'Revoked' : 'Active'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
