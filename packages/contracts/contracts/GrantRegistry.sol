// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GrantRegistry
 * @notice On-chain registry for ZeroMem agent public keys and memory grants.
 *         Deployed on 0G EVM (chain 16602 — Galileo testnet).
 */
contract GrantRegistry {
    struct Grant {
        address from;
        address to;
        bytes32 scopeHash;
        uint256 ttl;        // Unix timestamp of expiry
        bytes32 commitRoot; // keccak256 of head commitId at grant time
        bool revoked;
    }

    /// agent EVM address => compressed secp256k1 pubkey hex
    mapping(address => string) public agentPubKeys;

    /// grantId => Grant record
    mapping(bytes32 => Grant) public grants;

    /// from => to => scopeHash => latest grantId (allows only one active grant per triple)
    mapping(address => mapping(address => mapping(bytes32 => bytes32))) public activeGrant;

    event AgentRegistered(address indexed agent, string pubkey);
    event GrantCreated(
        bytes32 indexed grantId,
        address indexed from,
        address indexed to,
        bytes32 scopeHash,
        uint256 ttl
    );
    event GrantRevoked(bytes32 indexed grantId, address indexed revokedBy);

    modifier onlyGrantOwner(bytes32 grantId) {
        require(grants[grantId].from == msg.sender, "Not grant owner");
        _;
    }

    // ── Agent registration ─────────────────────────────────────────────────

    function registerAgent(string calldata pubkey) external {
        agentPubKeys[msg.sender] = pubkey;
        emit AgentRegistered(msg.sender, pubkey);
    }

    function getAgentPubKey(address agent) external view returns (string memory) {
        return agentPubKeys[agent];
    }

    // ── Grant lifecycle ────────────────────────────────────────────────────

    /**
     * @param to         Recipient agent address
     * @param scopeHash  keccak256 of the scope string (e.g. "work/research")
     * @param ttl        Unix timestamp of expiry
     * @param commitRoot keccak256 of the head commitId at grant time
     */
    function grant(
        address to,
        bytes32 scopeHash,
        uint256 ttl,
        bytes32 commitRoot
    ) external returns (bytes32 grantId) {
        require(to != address(0), "Zero address recipient");
        require(ttl > block.timestamp, "TTL already expired");

        grantId = keccak256(
            abi.encodePacked(msg.sender, to, scopeHash, ttl, commitRoot, block.timestamp)
        );

        grants[grantId] = Grant({
            from: msg.sender,
            to: to,
            scopeHash: scopeHash,
            ttl: ttl,
            commitRoot: commitRoot,
            revoked: false
        });

        activeGrant[msg.sender][to][scopeHash] = grantId;

        emit GrantCreated(grantId, msg.sender, to, scopeHash, ttl);
    }

    function revoke(bytes32 grantId) external onlyGrantOwner(grantId) {
        grants[grantId].revoked = true;
        Grant storage g = grants[grantId];
        activeGrant[g.from][g.to][g.scopeHash] = bytes32(0);
        emit GrantRevoked(grantId, msg.sender);
    }

    /**
     * @notice Returns true iff an active, unexpired, non-revoked grant exists
     */
    function isGranted(
        address from,
        address to,
        bytes32 scopeHash
    ) external view returns (bool) {
        bytes32 grantId = activeGrant[from][to][scopeHash];
        if (grantId == bytes32(0)) return false;
        Grant storage g = grants[grantId];
        return !g.revoked && g.ttl > block.timestamp;
    }

    function getGrant(bytes32 grantId)
        external
        view
        returns (
            address from,
            address to,
            bytes32 scopeHash,
            uint256 ttl,
            bytes32 commitRoot,
            bool revoked
        )
    {
        Grant storage g = grants[grantId];
        return (g.from, g.to, g.scopeHash, g.ttl, g.commitRoot, g.revoked);
    }
}
