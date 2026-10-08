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
    // Expired is never stored — it's computed at read time from expiresAt,
    // so a record's STORED status (what was actually set, and when) stays
    // immutable history even as its EFFECTIVE status (what verifyProof
    // reports) naturally becomes Expired once its expiry passes. Storage
    // only ever transitions NonExistent -> Active -> Revoked; there is no
    // function that can move a record back from Revoked to Active, or
    // force Expired back to Active.
    enum Status { NonExistent, Active, Revoked, Expired }

    struct ProofRecord {
        bytes32 evidenceHash;   // SHA-256 (or other) hash of the canonical payload
        string ipfsCID;         // IPFS CID of the full manifest
        string proofType;       // e.g. "QUANTUM_GHZ_EXECUTION", "CREDENTIAL_VERIFICATION", "AI_VISIBILITY_AUDIT"
        uint256 timestamp;      // block.timestamp at anchoring
        uint256 expiresAt;      // block.timestamp after which the record reads as Expired; 0 = never
        address issuer;         // wallet that anchored it
        Status status;          // stored status only: NonExistent, Active or Revoked (never Expired)
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
    error ExpiryInPast(uint256 expiresAt, uint256 currentTimestamp);

    /// @notice Anchor a new proof. Anyone may call this for their own hash;
    ///         a given evidenceHash can only ever be anchored once.
    /// @param _expiresAt Unix timestamp after which this record reads as
    ///        Expired, or 0 for a record that never expires.
    function anchorProof(
        bytes32 _evidenceHash,
        string calldata _ipfsCID,
        string calldata _proofType,
        uint256 _expiresAt
    ) external {
        if (_evidenceHash == bytes32(0)) revert InvalidHash();
        if (registry[_evidenceHash].status != Status.NonExistent) {
            revert RecordAlreadyExists(_evidenceHash);
        }
        if (_expiresAt != 0 && _expiresAt <= block.timestamp) {
            revert ExpiryInPast(_expiresAt, block.timestamp);
        }

        registry[_evidenceHash] = ProofRecord({
            evidenceHash: _evidenceHash,
            ipfsCID: _ipfsCID,
            proofType: _proofType,
            timestamp: block.timestamp,
            expiresAt: _expiresAt,
            issuer: msg.sender,
            status: Status.Active
        });

        issuerRecords[msg.sender].push(_evidenceHash);

        emit ProofAnchored(_evidenceHash, msg.sender, _ipfsCID, _proofType, block.timestamp);
    }

    /// @notice Revoke a proof you anchored. It stays on-chain with status Revoked.
    /// @dev Checked in order: record exists -> caller is its issuer -> record
    ///      is currently Active (an already-Expired record is also rejected
    ///      here, via the same NotActive error, since _effectiveStatus is
    ///      used rather than the raw stored status). A nonexistent record's
    ///      `issuer` reads as the zero address, so checking existence before
    ///      ownership means a bad hash is reported as RecordNotFound rather
    ///      than the misleading UnauthorizedIssuer(caller, address(0)).
    ///      Revoking twice, or revoking an expired record, reverts with
    ///      NotActive instead of silently succeeding or silently reviving it.
    function revokeProof(bytes32 _evidenceHash) external {
        ProofRecord storage record = registry[_evidenceHash];
        if (record.status == Status.NonExistent) revert RecordNotFound(_evidenceHash);
        if (record.issuer != msg.sender) revert UnauthorizedIssuer(msg.sender, record.issuer);
        Status effective = _effectiveStatus(record);
        if (effective != Status.Active) revert NotActive(effective);

        record.status = Status.Revoked; // stored status moves to Revoked even if it had already expired
        emit ProofRevoked(_evidenceHash, msg.sender, block.timestamp);
    }

    /// @dev Expired is derived, never stored: a record's `status` field only
    ///      ever holds NonExistent, Active or Revoked. This keeps the
    ///      on-chain history of actual state transitions immutable while
    ///      still letting verifyProof report the true current effective
    ///      status to callers.
    function _effectiveStatus(ProofRecord storage record) private view returns (Status) {
        if (record.status == Status.Active && record.expiresAt != 0 && block.timestamp >= record.expiresAt) {
            return Status.Expired;
        }
        return record.status;
    }

    /// @notice Read-only lookup for off-chain auditors and frontends.
    ///         `status` is the EFFECTIVE status (Expired is computed here,
    ///         never stored) — see `_effectiveStatus`.
    function verifyProof(bytes32 _evidenceHash) external view returns (
        bool isValid,
        string memory ipfsCID,
        string memory proofType,
        uint256 timestamp,
        uint256 expiresAt,
        address issuer,
        Status status
    ) {
        ProofRecord storage record = registry[_evidenceHash];
        Status effective = _effectiveStatus(record);
        isValid = (effective == Status.Active);
        return (isValid, record.ipfsCID, record.proofType, record.timestamp, record.expiresAt, record.issuer, effective);
    }

    function issuerRecordCount(address issuer) external view returns (uint256) {
        return issuerRecords[issuer].length;
    }
}
