// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Registry
/// @notice Anchors a content hash on-chain with a URN and a human label.
/// Deliberately minimal: no expiry, no lifecycle beyond Active/Revoked.
/// A record's existence and its issuer are the only facts this contract
/// asserts — it says nothing about the truth of whatever the content
/// describes.
contract Registry {
    enum Status {
        NonExistent,
        Active,
        Revoked
    }

    struct Record {
        string urn;
        string label;
        address issuer;
        uint256 timestamp;
        Status status;
    }

    mapping(bytes32 => Record) private records;

    event Anchored(bytes32 indexed contentHash, string urn, address indexed issuer, uint256 timestamp);
    event Revoked(bytes32 indexed contentHash, address indexed issuer, uint256 timestamp);

    error AlreadyAnchored(bytes32 contentHash);
    error NotFound(bytes32 contentHash);
    error NotIssuer(address caller, address issuer);
    error NotActive(bytes32 contentHash);

    function anchor(bytes32 contentHash, string calldata urn, string calldata label) external {
        if (records[contentHash].status != Status.NonExistent) revert AlreadyAnchored(contentHash);
        records[contentHash] = Record({
            urn: urn,
            label: label,
            issuer: msg.sender,
            timestamp: block.timestamp,
            status: Status.Active
        });
        emit Anchored(contentHash, urn, msg.sender, block.timestamp);
    }

    function revoke(bytes32 contentHash) external {
        Record storage r = records[contentHash];
        if (r.status == Status.NonExistent) revert NotFound(contentHash);
        if (r.issuer != msg.sender) revert NotIssuer(msg.sender, r.issuer);
        if (r.status != Status.Active) revert NotActive(contentHash);
        r.status = Status.Revoked;
        emit Revoked(contentHash, msg.sender, block.timestamp);
    }

    function lookup(bytes32 contentHash)
        external
        view
        returns (bool exists, string memory urn, string memory label, address issuer, uint256 timestamp, Status status)
    {
        Record storage r = records[contentHash];
        exists = r.status != Status.NonExistent;
        return (exists, r.urn, r.label, r.issuer, r.timestamp, r.status);
    }
}
