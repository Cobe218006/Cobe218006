import { config } from '../config.js';
import { migrate, openDb } from '../db.js';
import { ensureDefaultPolicy } from '../domain/policy.js';

const db = openDb(config.databasePath);
const ran = migrate(db);
const p = ensureDefaultPolicy(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Schema up to date.');
console.log(`Current policy: v${p.version} (${p.documentCode})`);
