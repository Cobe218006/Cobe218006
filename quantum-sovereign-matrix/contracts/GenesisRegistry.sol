// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GenesisRegistry (reference version)
/// @notice Records IPFS CIDs plus the SHA-256 of the file behind each CID.
///         If you already have your own GenesisRegistry.sol deployed, keep
///         using it; this file is only for anyone who does not.
contract GenesisRegistry {
    struct Anchor {
        string cid;          // IPFS CID of Manifest_Sovereign.json
        bytes32 contentHash; // SHA-256 of the manifest file (0x + 64 hex)
        address author;
        uint64 timestamp;
    }

    address public immutable owner;
    Anchor[] private _anchors;

    event Anchored(uint256 indexed id, address indexed author, string cid, bytes32 contentHash);

    error NotOwner();
    error EmptyCid();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Anchor a manifest. Only the wallet that deployed the contract can call this.
    function anchor(string calldata cid, bytes32 contentHash) external returns (uint256 id) {
        if (msg.sender != owner) revert NotOwner();
        if (bytes(cid).length == 0) revert EmptyCid();
        id = _anchors.length;
        _anchors.push(Anchor(cid, contentHash, msg.sender, uint64(block.timestamp)));
        emit Anchored(id, msg.sender, cid, contentHash);
    }

    function count() external view returns (uint256) {
        return _anchors.length;
    }

    function getAnchor(uint256 id) external view returns (Anchor memory) {
        return _anchors[id];
    }

    function latest() external view returns (Anchor memory) {
        return _anchors[_anchors.length - 1];
    }
}
