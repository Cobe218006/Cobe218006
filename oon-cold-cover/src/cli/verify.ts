import { config } from '../config.js';
import { all, openDb } from '../db.js';
import { verifyLedger } from '../domain/ledger.js';
import { verifyManifest } from '../domain/vault.js';

const db = openDb(config.databasePath);
const ledger = verifyLedger(db);
console.log(`Ledger: ${ledger.checked} events checked, ${ledger.problems.length} problem(s).`);
for (const p of ledger.problems) console.log(`  seq ${p.seq} ${p.problem}`);
let bad = ledger.problems.length;
for (const m of all<{ id: string }>(db, 'SELECT id FROM sealed_manifests')) {
  const v = verifyManifest(db, m.id);
  console.log(`Manifest ${m.id}: ${v.ok ? 'OK' : 'MISMATCH'} (hash ${v.manifestHashMatches ? 'ok' : 'MISMATCH'}, anchor ${v.ledgerAnchorMatches ? 'ok' : 'MISMATCH'})`);
  if (!v.ok) bad++;
}
console.log('Note: a matching hash shows the record is unchanged since sealing; it does not prove the recorded claims are true.');
process.exit(bad ? 1 : 0);
