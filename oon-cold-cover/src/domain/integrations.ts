import { config } from '../config.js';

export interface IntegrationStatus {
  name: string;
  status: 'CONNECTED' | 'NOT_CONNECTED' | 'LOCAL_DEV_ONLY';
  detail: string;
}

/** Honest integration status. Nothing here is reported as live unless it actually is. */
export function integrationStatuses(storageName: string): IntegrationStatus[] {
  return [
    { name: 'Document storage', status: 'LOCAL_DEV_ONLY', detail: `${storageName} at a private path outside the web root (${config.isProd ? 'production' : 'development'}). No public URLs.` },
    { name: 'Malware scanning', status: 'NOT_CONNECTED', detail: 'Uploads are type-checked by content signature and size-limited only. No malware scanning is performed.' },
    { name: 'Accounting system', status: 'NOT_CONNECTED', detail: 'Invoices are recorded locally; nothing is synced to an accounting system.' },
    { name: 'Payment processing', status: 'NOT_CONNECTED', detail: 'Payments are recorded manually after being received elsewhere. No funds are moved.' },
    { name: 'Email / SMS notifications', status: 'NOT_CONNECTED', detail: 'Site contact confirmation is performed by a person and recorded in the app.' },
    { name: 'Mapping / geocoding', status: 'NOT_CONNECTED', detail: 'Delivery pins are entered as coordinates; they are not geocoded or validated against a map service.' },
    { name: 'Telematics / temperature feeds', status: 'NOT_CONNECTED', detail: 'Temperatures are operator-reported or reviewer-entered; no live logger feed is connected.' },
  ];
}
