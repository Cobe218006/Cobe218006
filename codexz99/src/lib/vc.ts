/**
 * did:pkh — a DID method that is just an existing blockchain account,
 * per the CAIP-10 / did:pkh spec. No registry, no resolver needed: the
 * DID string itself names the chain and address.
 */
export function didPkh(chainId: number, address: string): string {
  return `did:pkh:eip155:${chainId}:${address.toLowerCase()}`;
}

export function addressFromDidPkh(did: string): string | null {
  const m = did.match(/^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/);
  return m ? m[1] : null;
}
