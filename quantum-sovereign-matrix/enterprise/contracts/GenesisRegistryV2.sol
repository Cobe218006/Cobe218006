// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GenesisRegistryV2 - Sovereign Proof Infrastructure
 * @notice Anchors quantum execution proofs, credentials, and evidence manifests
 *         on-chain, keyed by content hash rather than a sequential id, with
 *         per-issuer revocation.
 *
 * This is the "enterprise" counterpart to the simpler ../../contracts/GenesisRegistry.sol
 * used by the base iPhone-only DEPLOYMENT.md flow. The two are NOT interchangeable:
 * this one exposes anchorProof(bytes32,string,string) / verifyProof(bytes32), the
 * base one exposes anchor(string,bytes32) / latest(). Pick one ABI and use it
 * consistently across your backend, frontend and Remix calls.
 */
contract GenesisRegistryV2 {
    enum Status { NonExistent, Active, Revoked }

    struct ProofRecord {
        bytes32 evidenceHash;   // SHA-256 (or other) hash of the canonical payload
        string ipfsCID;         // IPFS CID of the full manifest
        string proofType;       // e.g. "QUANTUM_GHZ", "VERIFIABLE_CREDENTIAL", "AI_AUDIT"
        uint256 timestamp;      // block.timestamp at anchoring
        address issuer;         // wallet that anchored it
        Status status;
    }

    mapping(bytes32 => ProofRecord) public registry;
    mapping(address => bytes32[]) public issuerRecords;

    // NOTE: `ipfsCID` and `proofType` are NOT marked `indexed` deliberately.
    // Solidity stores an indexed `string`/`bytes` as keccak256(value) in the
    // topic, not the string itself — a UI that read the raw event topic
    // expecting the CID text back would be reading a hash, not a CID. Both
    // fields are emitted as plain (non-indexed) event data instead, so log
    // consumers get the actual string, and the full record (CID included)
    // always remains readable from the `registry` mapping regardless.
    event ProofAnchored(
        bytes32 indexed evidenceHash,
        address indexed issuer,
        string ipfsCID,
        string proofType,
        uint256 timestamp
    );
    event ProofRevoked(bytes32 indexed evidenceHash, address indexed issuer, uint256 timestamp);

    error RecordAlreadyExists(bytes32 evidenceHash);
    error RecordNotFound(bytes32 evidenceHash);
    error UnauthorizedIssuer(address caller, address actualIssuer);
    error InvalidHash();
    error NotActive(Status currentStatus);

    /// @notice Anchor a new proof. Anyone may call this for their own hash;
    ///         a given evidenceHash can only ever be anchored once.
    function anchorProof(
        bytes32 _evidenceHash,
        string calldata _ipfsCID,
        string calldata _proofType
    ) external {
        if (_evidenceHash == bytes32(0)) revert InvalidHash();
        if (registry[_evidenceHash].status != Status.NonExistent) {
            revert RecordAlreadyExists(_evidenceHash);
        }

        registry[_evidenceHash] = ProofRecord({
            evidenceHash: _evidenceHash,
            ipfsCID: _ipfsCID,
            proofType: _proofType,
            timestamp: block.timestamp,
            issuer: msg.sender,
            status: Status.Active
        });

        issuerRecords[msg.sender].push(_evidenceHash);

        emit ProofAnchored(_evidenceHash, msg.sender, _ipfsCID, _proofType, block.timestamp);
    }

    /// @notice Revoke a proof you anchored. It stays on-chain with status Revoked.
    /// @dev Checked in order: record exists -> caller is its issuer -> record
    ///      is currently Active. A nonexistent record's `issuer` reads as the
    ///      zero address, so checking existence before ownership means a bad
    ///      hash is reported as RecordNotFound rather than the misleading
    ///      UnauthorizedIssuer(caller, address(0)). Revoking twice reverts
    ///      with NotActive instead of silently succeeding.
    function revokeProof(bytes32 _evidenceHash) external {
        ProofRecord storage record = registry[_evidenceHash];
        if (record.status == Status.NonExistent) revert RecordNotFound(_evidenceHash);
        if (record.issuer != msg.sender) revert UnauthorizedIssuer(msg.sender, record.issuer);
        if (record.status != Status.Active) revert NotActive(record.status);

        record.status = Status.Revoked;
        emit ProofRevoked(_evidenceHash, msg.sender, block.timestamp);
    }

    /// @notice Read-only lookup for off-chain auditors and frontends.
    function verifyProof(bytes32 _evidenceHash) external view returns (
        bool isValid,
        string memory ipfsCID,
        string memory proofType,
        uint256 timestamp,
        address issuer,
        Status status
    ) {
        ProofRecord memory record = registry[_evidenceHash];
        isValid = (record.status == Status.Active);
        return (isValid, record.ipfsCID, record.proofType, record.timestamp, record.issuer, record.status);
    }

    function issuerRecordCount(address issuer) external view returns (uint256) {
        return issuerRecords[issuer].length;
    }
}
