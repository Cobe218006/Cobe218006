"""
Pinata client for pinning a manifest JSON to IPFS.

`base_url` is overridable specifically so tests/test_pinning.py can point
this at a local fake server and verify the request this code actually
builds (headers, body shape) and how it parses a real-looking response,
without needing a live PINATA_JWT. Hitting the real
https://api.pinata.cloud endpoint is NOT exercised by any test in this repo
— that needs a real credential this environment doesn't have (see
enterprise/README.md "Scope").

Swapping providers: any pinning service that accepts a JSON body and
returns a CID can replace this module — nothing elsewhere in the protocol
is Pinata-specific. web3.storage/Storacha is a reasonable alternative if
Pinata's terms or pricing stop working for you; its request/response shape
differs, so it needs its own small client function, not a drop-in config
change.
"""

from __future__ import annotations

from typing import Any, Dict

import httpx

DEFAULT_BASE_URL = "https://api.pinata.cloud"


class PinningError(RuntimeError):
    """Raised when pinning fails. Never swallowed into a fabricated CID."""


def pin_json(manifest: Dict[str, Any], *, filename: str, jwt: str, base_url: str = DEFAULT_BASE_URL) -> str:
    """Pin `manifest` as JSON via Pinata's pinJSONToIPFS endpoint. Returns the CID.

    Raises PinningError on any non-2xx response or a response missing the
    expected IpfsHash field — never returns a guessed or placeholder CID.
    """
    url = f"{base_url}/pinning/pinJSONToIPFS"
    body = {
        "pinataContent": manifest,
        "pinataMetadata": {"name": filename},
        "pinataOptions": {"cidVersion": 1},
    }
    headers = {"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}

    try:
        response = httpx.post(url, json=body, headers=headers, timeout=30)
    except httpx.HTTPError as exc:
        raise PinningError(f"Could not reach pinning service: {exc}") from exc

    if response.status_code // 100 != 2:
        raise PinningError(f"Pinning service returned HTTP {response.status_code}: {response.text[:300]}")

    try:
        data = response.json()
    except ValueError as exc:
        raise PinningError(f"Pinning service returned a non-JSON response: {exc}") from exc

    cid = data.get("IpfsHash")
    if not cid:
        raise PinningError(f"Pinning service response is missing IpfsHash: {data}")
    return cid
