// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GrantRegistry
 * @notice On-chain registry for ZeroMem agent public keys, memory grants,
 *         access tiers, and delegated grants.
 *         Deployed on 0G EVM (chain 16602 — Galileo testnet).
 *
 * Access tiers:
 *   NONE          — no access
 *   READ_SEMANTIC — semantic/summary namespace only (coarse access)
 *   READ_FULL     — all namespaces (full read)
 *   ADMIN         — READ_FULL + can delegate grants to others
 */
contract GrantRegistry {

    // ── Access tiers ──────────────────────────────────────────────────────────

    enum AccessTier { NONE, READ_SEMANTIC, READ_FULL, ADMIN }

    // ── Data structures ───────────────────────────────────────────────────────

    struct Grant {
        address from;
        address to;
        bytes32 scopeHash;
        uint256 ttl;
        bytes32 commitRoot;
        bytes32 capsuleRoot;     // rootHash of MemoryCapsule blob on 0G Storage
        AccessTier tier;
        bool revoked;
        bytes32 parentGrantId;   // non-zero if this is a delegated grant
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// agent address => compressed secp256k1 pubkey hex
    mapping(address => string) public agentPubKeys;

    /// grantId => Grant
    mapping(bytes32 => Grant) public grants;

    /// from => to => scopeHash => latest active grantId
    mapping(address => mapping(address => mapping(bytes32 => bytes32))) public activeGrant;

    // ── Events ────────────────────────────────────────────────────────────────

    event AgentRegistered(address indexed agent, string pubkey);
    event GrantCreated(
        bytes32 indexed grantId,
        address indexed from,
        address indexed to,
        bytes32 scopeHash,
        uint256 ttl,
        AccessTier tier,
        bytes32 capsuleRoot
    );
    event GrantRevoked(bytes32 indexed grantId, address indexed revokedBy);
    event GrantDelegated(
        bytes32 indexed parentGrantId,
        bytes32 indexed delegateGrantId,
        address indexed delegateTo,
        AccessTier tier
    );

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyGrantOwner(bytes32 grantId) {
        require(grants[grantId].from == msg.sender, "Not grant owner");
        _;
    }

    modifier grantActive(bytes32 grantId) {
        Grant storage g = grants[grantId];
        require(!g.revoked, "Grant revoked");
        require(g.ttl > block.timestamp, "Grant expired");
        _;
    }

    // ── Agent registration ────────────────────────────────────────────────────

    function registerAgent(string calldata pubkey) external {
        agentPubKeys[msg.sender] = pubkey;
        emit AgentRegistered(msg.sender, pubkey);
    }

    function getAgentPubKey(address agent) external view returns (string memory) {
        return agentPubKeys[agent];
    }

    // ── Grant lifecycle ───────────────────────────────────────────────────────

    /**
     * Create a new grant.
     * @param to           Recipient agent address
     * @param scopeHash    keccak256 of the scope string
     * @param ttl          Unix timestamp of expiry
     * @param commitRoot   keccak256 of head commitId at grant time
     * @param capsuleRoot  rootHash of MemoryCapsule blob on 0G Storage
     * @param tier         Access level: READ_SEMANTIC | READ_FULL | ADMIN
     */
    function grant(
        address to,
        bytes32 scopeHash,
        uint256 ttl,
        bytes32 commitRoot,
        bytes32 capsuleRoot,
        AccessTier tier
    ) external returns (bytes32 grantId) {
        require(to != address(0), "Zero address recipient");
        require(ttl > block.timestamp, "TTL already expired");
        require(uint8(tier) > uint8(AccessTier.NONE), "Must grant at least READ_SEMANTIC");

        grantId = _makeGrantId(msg.sender, to, scopeHash, ttl, commitRoot, capsuleRoot, block.timestamp);

        grants[grantId] = Grant({
            from:         msg.sender,
            to:           to,
            scopeHash:    scopeHash,
            ttl:          ttl,
            commitRoot:   commitRoot,
            capsuleRoot:  capsuleRoot,
            tier:         tier,
            revoked:      false,
            parentGrantId: bytes32(0)
        });

        activeGrant[msg.sender][to][scopeHash] = grantId;

        emit GrantCreated(grantId, msg.sender, to, scopeHash, ttl, tier, capsuleRoot);
    }

    /**
     * Batch grant: create the same grant for multiple recipients at once.
     * @param recipients    Array of recipient addresses
     * @param scopeHash     keccak256 of scope string
     * @param ttl           Unix timestamp of expiry
     * @param commitRoot    keccak256 of head commitId
     * @param capsuleRoots  Per-recipient MemoryCapsule rootHashes (one per recipient)
     * @param tier          Access level
     */
    function batchGrant(
        address[] calldata recipients,
        bytes32 scopeHash,
        uint256 ttl,
        bytes32 commitRoot,
        bytes32[] calldata capsuleRoots,
        AccessTier tier
    ) external returns (bytes32[] memory grantIds) {
        require(recipients.length == capsuleRoots.length, "Length mismatch");
        require(ttl > block.timestamp, "TTL already expired");
        require(uint8(tier) > uint8(AccessTier.NONE), "Must grant at least READ_SEMANTIC");

        grantIds = new bytes32[](recipients.length);

        for (uint256 i = 0; i < recipients.length; i++) {
            address to = recipients[i];
            require(to != address(0), "Zero address recipient");

            bytes32 grantId = _makeGrantId(msg.sender, to, scopeHash, ttl, commitRoot, capsuleRoots[i], block.timestamp + i);

            grants[grantId] = Grant({
                from:         msg.sender,
                to:           to,
                scopeHash:    scopeHash,
                ttl:          ttl,
                commitRoot:   commitRoot,
                capsuleRoot:  capsuleRoots[i],
                tier:         tier,
                revoked:      false,
                parentGrantId: bytes32(0)
            });

            activeGrant[msg.sender][to][scopeHash] = grantId;
            grantIds[i] = grantId;

            emit GrantCreated(grantId, msg.sender, to, scopeHash, ttl, tier, capsuleRoots[i]);
        }
    }

    /**
     * Delegate: holder of an ADMIN grant can re-grant to a third party,
     * but only with equal-or-lesser tier and TTL.
     * @param parentGrantId   The ADMIN grant being delegated from
     * @param delegateTo      New recipient
     * @param subTtl          Must be <= parent grant TTL
     * @param subTier         Must be <= parent tier (i.e. ADMIN can delegate READ_FULL, etc.)
     * @param capsuleRoot     MemoryCapsule rootHash for the delegate
     */
    function delegateGrant(
        bytes32 parentGrantId,
        address delegateTo,
        uint256 subTtl,
        AccessTier subTier,
        bytes32 capsuleRoot
    ) external grantActive(parentGrantId) returns (bytes32 delegateGrantId) {
        Grant storage parent = grants[parentGrantId];

        require(parent.to == msg.sender, "Not grant holder");
        require(parent.tier == AccessTier.ADMIN, "Parent grant must be ADMIN tier to delegate");
        require(delegateTo != address(0), "Zero address");
        require(subTtl <= parent.ttl, "Cannot extend TTL beyond parent");
        require(uint8(subTier) <= uint8(parent.tier), "Cannot escalate tier");

        delegateGrantId = _makeGrantId(
            parent.from, delegateTo, parent.scopeHash, subTtl, parent.commitRoot, capsuleRoot, block.timestamp
        );

        grants[delegateGrantId] = Grant({
            from:         parent.from,
            to:           delegateTo,
            scopeHash:    parent.scopeHash,
            ttl:          subTtl,
            commitRoot:   parent.commitRoot,
            capsuleRoot:  capsuleRoot,
            tier:         subTier,
            revoked:      false,
            parentGrantId: parentGrantId
        });

        activeGrant[parent.from][delegateTo][parent.scopeHash] = delegateGrantId;

        emit GrantDelegated(parentGrantId, delegateGrantId, delegateTo, subTier);
    }

    /** Revoke a specific grant */
    function revoke(bytes32 grantId) external onlyGrantOwner(grantId) {
        grants[grantId].revoked = true;
        Grant storage g = grants[grantId];
        activeGrant[g.from][g.to][g.scopeHash] = bytes32(0);
        emit GrantRevoked(grantId, msg.sender);
    }

    /** Revoke ALL grants this caller has issued for a specific scope */
    function revokeAll(address[] calldata recipients, bytes32 scopeHash_) external {
        for (uint256 i = 0; i < recipients.length; i++) {
            bytes32 grantId = activeGrant[msg.sender][recipients[i]][scopeHash_];
            if (grantId != bytes32(0)) {
                grants[grantId].revoked = true;
                activeGrant[msg.sender][recipients[i]][scopeHash_] = bytes32(0);
                emit GrantRevoked(grantId, msg.sender);
            }
        }
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    function isGranted(address from, address to, bytes32 scopeHash_)
        external view returns (bool)
    {
        bytes32 grantId = activeGrant[from][to][scopeHash_];
        if (grantId == bytes32(0)) return false;
        Grant storage g = grants[grantId];
        return !g.revoked && g.ttl > block.timestamp;
    }

    function getAccessTier(address from, address to, bytes32 scopeHash_)
        external view returns (AccessTier)
    {
        bytes32 grantId = activeGrant[from][to][scopeHash_];
        if (grantId == bytes32(0)) return AccessTier.NONE;
        Grant storage g = grants[grantId];
        if (g.revoked || g.ttl <= block.timestamp) return AccessTier.NONE;
        return g.tier;
    }

    function getGrant(bytes32 grantId)
        external view
        returns (
            address from, address to, bytes32 scopeHash_,
            uint256 ttl, bytes32 commitRoot, bytes32 capsuleRoot,
            AccessTier tier, bool revoked, bytes32 parentGrantId
        )
    {
        Grant storage g = grants[grantId];
        return (
            g.from, g.to, g.scopeHash,
            g.ttl, g.commitRoot, g.capsuleRoot,
            g.tier, g.revoked, g.parentGrantId
        );
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _makeGrantId(
        address from, address to, bytes32 scopeHash_, uint256 ttl,
        bytes32 commitRoot, bytes32 capsuleRoot, uint256 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(from, to, scopeHash_, ttl, commitRoot, capsuleRoot, salt));
    }
}
