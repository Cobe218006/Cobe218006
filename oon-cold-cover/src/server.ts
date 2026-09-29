import { config } from './config.js';
import { migrate, openDb } from './db.js';
import { LocalPrivateStorage } from './domain/documents.js';
import { ensureDefaultPolicy } from './domain/policy.js';
import { createApp } from './http/app.js';

const db = openDb(config.databasePath);
const ran = migrate(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(', ')}`);
ensureDefaultPolicy(db);
const storage = new LocalPrivateStorage(config.storageDir);
const app = createApp({ db, storage });
app.listen(config.port, () => {
  console.log(`Cold Cover + Proof Vault listening on http://localhost:${config.port}`);
  if (!config.isProd) console.log('Development mode: secrets not set in env are ephemeral (sessions reset on restart).');
});
