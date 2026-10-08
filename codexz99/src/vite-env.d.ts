/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODE?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_CONTRACT_ADDRESS?: string;
  readonly VITE_CHAIN_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: import('ethers').Eip1193Provider;
}
