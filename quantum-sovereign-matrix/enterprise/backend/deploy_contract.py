"""
Deploys GenesisRegistryV2.sol to the chain named by RPC_URL, using the
account controlled by DEPLOYER_PRIVATE_KEY.

Run from enterprise/:  python3 -m backend.deploy_contract

Requires env vars:
    RPC_URL               - e.g. a Sepolia RPC endpoint
    DEPLOYER_PRIVATE_KEY  - hex private key (0x... or bare) of a funded account

Prints the deployed contract address and the values to put in .env as
GENESIS_REGISTRY_ADDRESS / GENESIS_REGISTRY_CHAIN_ID. Never invents a
fallback address: if anything about compilation, the RPC, the account, or
the transaction fails, this raises rather than printing a placeholder.
"""

from __future__ import annotations

import os

import solcx
from web3 import Web3


def compile_contract(path: str) -> tuple[list, str]:
    solcx.install_solc("0.8.24")
    with open(path, "r") as f:
        source = f.read()
    compiled = solcx.compile_source(
        source, output_values=["abi", "bin"], solc_version="0.8.24"
    )
    contract_id, contract_interface = next(iter(compiled.items()))
    return contract_interface["abi"], contract_interface["bin"]


def main() -> None:
    rpc_url = os.getenv("RPC_URL")
    private_key = os.getenv("DEPLOYER_PRIVATE_KEY")
    if not rpc_url:
        raise RuntimeError("RPC_URL is not set. Refusing to deploy without a real RPC endpoint.")
    if not private_key:
        raise RuntimeError("DEPLOYER_PRIVATE_KEY is not set. Refusing to deploy without a funded account.")
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    contract_path = os.path.join(os.path.dirname(__file__), "..", "contracts", "GenesisRegistryV2.sol")
    print(f"Compiling {contract_path} ...")
    abi, bytecode = compile_contract(contract_path)

    w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 30}))
    if not w3.is_connected():
        raise RuntimeError(f"Could not connect to RPC {rpc_url}")
    chain_id = w3.eth.chain_id
    account = w3.eth.account.from_key(private_key)
    balance = w3.eth.get_balance(account.address)
    print(f"Chain ID: {chain_id}")
    print(f"Deployer: {account.address}  (balance: {Web3.from_wei(balance, 'ether')} ETH)")
    if balance == 0:
        raise RuntimeError(f"{account.address} has zero balance on chain {chain_id}. Fund it from a faucet first.")

    Contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    tx = Contract.constructor().build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
        "chainId": chain_id,
    })
    signed = w3.eth.account.sign_transaction(tx, private_key)
    print("Sending deployment transaction ...")
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"tx_hash: {tx_hash.hex()}  (waiting for it to mine...)")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)

    print("\n--- Deployed ---")
    print(f"GENESIS_REGISTRY_ADDRESS={receipt.contractAddress}")
    print(f"GENESIS_REGISTRY_CHAIN_ID={chain_id}")
    print(f"deployment tx: {tx_hash.hex()}")
    print(f"block: {receipt.blockNumber}")

    # Also write the ABI out, so api.py's hardcoded ABI can be cross-checked
    # and so other tooling (tests, the deploy-first-record step) can use it.
    abi_path = os.path.join(os.path.dirname(__file__), "..", "GenesisRegistryV2.abi.json")
    import json
    with open(abi_path, "w") as f:
        json.dump(abi, f, indent=2)
    print(f"ABI written to {abi_path}")


if __name__ == "__main__":
    main()
