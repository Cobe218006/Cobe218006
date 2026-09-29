import { randomBytes } from 'node:crypto';
import path from 'node:path';

const isProd = process.env.NODE_ENV === 'production';

function secret(name: string): string {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(`${name} must be set (>= 32 chars) in production. See .env.example.`);
  }
  // Development/test only: an ephemeral random secret. Sessions and signed
  // document links become invalid on every restart, which is intended.
  return randomBytes(32).toString('hex');
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? path.resolve('data/oon.db'),
  storageDir: process.env.DOCUMENT_STORAGE_DIR ?? path.resolve('data/private-documents'),
  sessionSecret: secret('SESSION_SECRET'),
  documentLinkSecret: secret('DOCUMENT_LINK_SECRET'),
  documentLinkTtlSeconds: Number(process.env.DOCUMENT_LINK_TTL_SECONDS ?? 300),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  displayTimeZone: process.env.DISPLAY_TIME_ZONE ?? 'America/Chicago',
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
  allowDemoSeed: process.env.ALLOW_DEMO_SEED === 'true' || !isProd,
};
