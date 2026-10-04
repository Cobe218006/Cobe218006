/**
 * Vault: the one place that knows how to connect a signer, anchor a hash,
 * and list/look up anchored records. Two modes:
 *
 *   local — no wallet extension, no real chain. A throwaway secp256k1 key
 *           is generated once and persisted in this browser's localStorage
 *           so claims can still be genuinely signed and verified end to
 *           end. This key is NOT for real funds — it exists purely so the
 *           local demo flow produces real, independently verifiable
 *           signatures instead of faking them.
 *   chain — a real wallet (MetaMask or similar) connected via
 *           window.ethereum, anchoring to the real Registry.sol contract
 *           at VITE_CONTRACT_ADDRESS on VITE_RPC_URL's chain.
 *
 * getVault() never throws for a missing/misconfigured chain config at
 * import time — it falls back to local mode and callers can check
 * `.mode` — so a bad .env can never blank the whole app (see
 * ErrorBoundary.tsx and the "tabs don't work" bug this fixes).
 */
import { BrowserProvider, Contract, JsonRpcProvider, Wallet, type Provider, type Signer } from 'ethers';

export type VaultMode = 'local' | 'chain';

export interface ProofRecord {
  contentHash: string;
  urn: string;
  label: string;
  issuer: string;
  timestamp: number;
  revoked: boolean;
}

export interface Vault {
  mode: VaultMode;
  connect(): Promise<string>;
  getSigner(): Signer | null;
  anchor(contentHashHex: string, urn: string, label: string): Promise<{ proofId: string; txHash: string }>;
  list(address: string): Promise<ProofRecord[]>;
  lookup(contentHashHex: string): Promise<ProofRecord | null>;
}

const REGISTRY_ABI = [
  'function anchor(bytes32 contentHash, string calldata urn, string calldata label) external',
  'function revoke(bytes32 contentHash) external',
  'function lookup(bytes32 contentHash) external view returns (bool exists, string urn, string label, address issuer, uint256 timestamp, uint8 status)',
  'event Anchored(bytes32 indexed contentHash, string urn, address indexed issuer, uint256 timestamp)',
];

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

const LOCAL_KEY_STORAGE = 'codexz99.local_signing_key.v1';
const LOCAL_RECORDS_STORAGE = 'codexz99.local_records.v1';

function getOrCreateLocalWallet(): Wallet {
  let pk = localStorage.getItem(LOCAL_KEY_STORAGE);
  if (!pk) {
    pk = Wallet.createRandom().privateKey;
    localStorage.setItem(LOCAL_KEY_STORAGE, pk);
  }
  return new Wallet(pk);
}

function readLocalRecords(): ProofRecord[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_RECORDS_STORAGE) ?? '[]');
  } catch {
    return [];
  }
}

function writeLocalRecords(records: ProofRecord[]): void {
  localStorage.setItem(LOCAL_RECORDS_STORAGE, JSON.stringify(records));
}

function makeLocalVault(): Vault {
  const wallet = getOrCreateLocalWallet();
  return {
    mode: 'local',
    async connect() {
      return wallet.address;
    },
    getSigner() {
      return wallet;
    },
    async anchor(contentHashHex, urn, label) {
      const hash = contentHashHex.startsWith('0x') ? contentHashHex : '0x' + contentHashHex;
      const records = readLocalRecords();
      if (records.some((r) => r.contentHash === hash)) {
        throw new Error(`Already anchored locally: ${hash}`);
      }
      const record: ProofRecord = {
        contentHash: hash,
        urn,
        label,
        issuer: wallet.address,
        timestamp: Math.floor(Date.now() / 1000),
        revoked: false,
      };
      records.unshift(record);
      writeLocalRecords(records);
      return { proofId: hash, txHash: 'local:' + hash };
    },
    async list(address) {
      return readLocalRecords().filter((r) => !address || r.issuer.toLowerCase() === address.toLowerCase());
    },
    async lookup(contentHashHex) {
      const hash = contentHashHex.startsWith('0x') ? contentHashHex : '0x' + contentHashHex;
      return readLocalRecords().find((r) => r.contentHash === hash) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Chain mode
// ---------------------------------------------------------------------------

function makeChainVault(rpcUrl: string, contractAddress: string): Vault {
  // A read-only RPC provider, independent of wallet connection, so list()
  // and lookup() work before (or without) a wallet ever connecting.
  const readProvider: Provider = new JsonRpcProvider(rpcUrl);
  let browserProvider: BrowserProvider | null = null;
  let signer: Signer | null = null;

  async function lookupWith(provider: Provider, contentHashHex: string): Promise<ProofRecord | null> {
    const hash = contentHashHex.startsWith('0x') ? contentHashHex : '0x' + contentHashHex;
    const contract = new Contract(contractAddress, REGISTRY_ABI, provider);
    const [exists, urn, label, issuer, timestamp, status] = await contract.lookup(hash);
    if (!exists) return null;
    return {
      contentHash: hash,
      urn,
      label,
      issuer,
      timestamp: Number(timestamp),
      revoked: Number(status) === 2,
    };
  }

  return {
    mode: 'chain',
    async connect() {
      if (!window.ethereum) throw new Error('No wallet extension found (window.ethereum is undefined).');
      browserProvider = new BrowserProvider(window.ethereum);
      await browserProvider.send('eth_requestAccounts', []);
      signer = await browserProvider.getSigner();
      return await signer.getAddress();
    },
    getSigner() {
      return signer;
    },
    async anchor(contentHashHex, urn, label) {
      if (!signer) throw new Error('Wallet not connected. Call connect() first.');
      const hash = contentHashHex.startsWith('0x') ? contentHashHex : '0x' + contentHashHex;
      const contract = new Contract(contractAddress, REGISTRY_ABI, signer);
      const tx = await contract.anchor(hash, urn, label);
      const receipt = await tx.wait();
      return { proofId: hash, txHash: receipt.hash };
    },
    async list(address) {
      const contract = new Contract(contractAddress, REGISTRY_ABI, readProvider);
      const filter = contract.filters.Anchored(null, null, address || undefined);
      const events = await contract.queryFilter(filter);
      const out: ProofRecord[] = [];
      for (const ev of events) {
        if (!('args' in ev)) continue;
        const [contentHash] = ev.args as unknown as [string, string, string, bigint];
        const rec = await lookupWith(readProvider, contentHash);
        if (rec) out.push(rec);
      }
      return out.reverse();
    },
    async lookup(contentHashHex) {
      return lookupWith(readProvider, contentHashHex);
    },
  };
}

// ---------------------------------------------------------------------------

let cached: Vault | null = null;

export function getVault(): Vault {
  if (cached) return cached;

  const requestedMode = (import.meta.env.VITE_MODE ?? 'local').toLowerCase();
  const rpcUrl = import.meta.env.VITE_RPC_URL ?? '';
  const contractAddress = import.meta.env.VITE_CONTRACT_ADDRESS ?? '';

  if (requestedMode === 'chain' && rpcUrl && contractAddress) {
    cached = makeChainVault(rpcUrl, contractAddress);
  } else {
    // Falls back to local rather than throwing — a misconfigured chain
    // mode (e.g. VITE_MODE=chain with an empty VITE_CONTRACT_ADDRESS)
    // must never blank the whole app.
    cached = makeLocalVault();
  }
  return cached;
}

export function shortAddress(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
