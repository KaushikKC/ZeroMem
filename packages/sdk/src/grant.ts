import { ethers } from 'ethers';
import { KvViews } from './kv-views.js';
import type { StorageClient } from './storage.js';
import {
  createCapsule,
  verifyCapsule,
  unwrapKey,
  decodeCapsule,
  encodeCapsule,
  type MemoryCapsule,
  type AccessTier,
} from './acl.js';

// Updated ABI to match upgraded GrantRegistry.sol
const GRANT_REGISTRY_ABI = [
  'function registerAgent(string calldata pubkey) external',
  'function grant(address to, bytes32 scopeHash, uint256 ttl, bytes32 commitRoot, bytes32 capsuleRoot, uint8 tier) external returns (bytes32)',
  'function batchGrant(address[] calldata recipients, bytes32 scopeHash, uint256 ttl, bytes32 commitRoot, bytes32[] calldata capsuleRoots, uint8 tier) external returns (bytes32[] memory)',
  'function delegateGrant(bytes32 parentGrantId, address delegateTo, uint256 subTtl, uint8 subTier, bytes32 capsuleRoot) external returns (bytes32)',
  'function revoke(bytes32 grantId) external',
  'function revokeAll(address[] calldata recipients, bytes32 scopeHash) external',
  'function isGranted(address from, address to, bytes32 scopeHash) external view returns (bool)',
  'function getAccessTier(address from, address to, bytes32 scopeHash) external view returns (uint8)',
  'function getGrant(bytes32 grantId) external view returns (address, address, bytes32, uint256, bytes32, bytes32, uint8, bool, bytes32)',
  'event AgentRegistered(address indexed agent, string pubkey)',
  'event GrantCreated(bytes32 indexed grantId, address indexed from, address indexed to, bytes32 scopeHash, uint256 ttl, uint8 tier, bytes32 capsuleRoot)',
  'event GrantRevoked(bytes32 indexed grantId, address indexed revokedBy)',
  'event GrantDelegated(bytes32 indexed parentGrantId, bytes32 indexed delegateGrantId, address indexed delegateTo, uint8 tier)',
];

const TIER_MAP: Record<AccessTier, number> = {
  READ_SEMANTIC: 1,
  READ_FULL: 2,
  ADMIN: 3,
};
const TIER_REVERSE: Record<number, AccessTier> = { 1: 'READ_SEMANTIC', 2: 'READ_FULL', 3: 'ADMIN' };

function scopeHash(scope: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(scope));
}

function ttlToTimestamp(ttl: string): bigint {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const m = ttl.match(/^(\d+)(s|m|h|d)$/);
  if (!m) throw new Error(`Invalid TTL format: ${ttl}. Use e.g. 24h, 30m, 7d`);
  const n = BigInt(m[1]);
  const unit = m[2];
  const secs = unit === 's' ? n : unit === 'm' ? n * 60n : unit === 'h' ? n * 3600n : n * 86400n;
  return now + secs;
}

export class GrantManager {
  private contract: ethers.Contract | null = null;
  private listenerActive = false;

  constructor(
    private storage: StorageClient,
    private kv: KvViews,
    private wallet: ethers.Wallet,
    private registryAddress?: string,
    private rpcUrl?: string
  ) {}

  private getContract(): ethers.Contract {
    if (!this.registryAddress) throw new Error('GrantRegistry address not configured');
    if (!this.contract) {
      const provider = new ethers.JsonRpcProvider(this.rpcUrl);
      const signer = new ethers.Wallet(this.wallet.privateKey, provider);
      this.contract = new ethers.Contract(this.registryAddress, GRANT_REGISTRY_ABI, signer);
    }
    return this.contract;
  }

  async registerAgent(pubkey: string): Promise<void> {
    try { const tx = await this.getContract().registerAgent(pubkey); await tx.wait(); } catch {}
  }

  /**
   * Grant read access to a memory scope using a MemoryCapsule.
   *
   * The capsule wraps the granter's KV symmetric key with the recipient's
   * ECIES public key. Only the recipient can decrypt the memories.
   * The capsule is stored on 0G Storage as an immutable content-addressed blob.
   */
  async createGrant(opts: {
    from: string;
    granterAgentId: string;
    granterPubKey: string;
    to: string;
    toPubKey: string;
    scope: string;
    ttl: string;
    tier?: AccessTier;
    headCommitId: string;
    privateKey: string;
    kvSymKey: Buffer;
  }): Promise<string> {
    const {
      from, granterAgentId, granterPubKey, to, toPubKey,
      scope, ttl, tier = 'READ_FULL', headCommitId, privateKey, kvSymKey,
    } = opts;

    const ttlTimestamp = ttlToTimestamp(ttl);

    // 1. Build MemoryCapsule — wraps kvSymKey with recipient's ECDH key
    const capsule = await createCapsule({
      granterAddress: from,
      granterPubKey,
      granterPrivKey: privateKey,
      recipientAddress: to,
      recipientPubKey: toPubKey,
      scope,
      ttl,
      tier,
      kvSymKey,
    });

    // 2. Store capsule as a blob on 0G Storage (encrypted to recipient's pubkey)
    const capsuleBytes = encodeCapsule(capsule);
    const capsuleRoot = await this.storage.upload(capsuleBytes, {
      encrypt: true,
      recipientPubKey: toPubKey,
    });

    // 3. Commit root (keccak of head commitId for on-chain reference)
    const commitRootBytes = ethers.zeroPadValue(
      ethers.toBeHex(ethers.keccak256(ethers.toUtf8Bytes(headCommitId))),
      32
    );
    const capsuleRootBytes = ethers.zeroPadValue(
      ethers.toBeHex(ethers.keccak256(ethers.toUtf8Bytes(capsuleRoot))),
      32
    );
    const sh = scopeHash(scope);
    const tierNum = TIER_MAP[tier];

    let grantId: string;
    try {
      const contract = this.getContract();
      const tx = await contract.grant(to, sh, ttlTimestamp, commitRootBytes, capsuleRootBytes, tierNum);
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((l: any) => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === 'GrantCreated');
      grantId = event?.args?.grantId ?? fallbackGrantId(from, to, scope);
    } catch {
      grantId = fallbackGrantId(from, to, scope);
    }

    // 4. Write to granter's KV: grant record + reverse-index + capsule root
    await this.kv.batch([
      {
        key: this.kv.grantKey(from, to, scope),
        value: new TextEncoder().encode(
          JSON.stringify({ grantId, ttl: Number(ttlTimestamp), granterAgentId, tier, capsuleRoot })
        ),
      },
      {
        key: this.kv.grantIndexKey(grantId),
        value: new TextEncoder().encode(JSON.stringify({ from, to, scope })),
      },
      {
        key: this.kv.capsuleKey(grantId),
        value: new TextEncoder().encode(capsuleRoot),
      },
    ]);

    return grantId;
  }

  /**
   * Batch grant to multiple recipients at once.
   * Creates one capsule per recipient (each has their own wrapped key).
   */
  async batchGrant(opts: {
    from: string;
    granterAgentId: string;
    granterPubKey: string;
    recipients: Array<{ address: string; pubKey: string }>;
    scope: string;
    ttl: string;
    tier?: AccessTier;
    headCommitId: string;
    privateKey: string;
    kvSymKey: Buffer;
  }): Promise<string[]> {
    const grantIds: string[] = [];
    for (const recipient of opts.recipients) {
      const grantId = await this.createGrant({
        ...opts,
        to: recipient.address,
        toPubKey: recipient.pubKey,
      });
      grantIds.push(grantId);
    }
    return grantIds;
  }

  /** Revoke a specific grant — removes from KV + on-chain */
  async revoke(grantId: string, scope: string, to: string): Promise<void> {
    try { const tx = await this.getContract().revoke(grantId); await tx.wait(); } catch {}
    if (scope && to) {
      await this.kv.removeGrant(this.wallet.address, to, scope);
    } else {
      const meta = await this.kv.getGrantIndex(grantId);
      if (meta) await this.kv.removeGrant(meta.from, meta.to, meta.scope);
    }
  }

  /** Wire on-chain GrantRevoked event → auto-purge KV */
  async initEventListeners(): Promise<void> {
    if (this.listenerActive) return;
    try {
      const contract = this.getContract();
      this.listenerActive = true;
      contract.on('GrantRevoked', async (grantId: string) => {
        try {
          const meta = await this.kv.getGrantIndex(grantId);
          if (meta) await this.kv.removeGrant(meta.from, meta.to, meta.scope);
        } catch {}
      });
    } catch { this.listenerActive = false; }
  }

  stopEventListeners(): void {
    try { this.contract?.removeAllListeners(); this.listenerActive = false; } catch {}
  }

  /** Check if a grant is still valid (reads granter's KV stream) */
  async isGranted(from: string, to: string, scope: string): Promise<boolean> {
    const grantorKv = new KvViews(this.storage, from);
    const record = await grantorKv.getGrant(from, to, scope);
    if (!record) return false;
    if (record.ttl < Math.floor(Date.now() / 1000)) return false;
    try {
      return (await this.getContract().isGranted(from, to, scopeHash(scope))) as boolean;
    } catch { return true; }
  }

  /** Read full grant record including capsuleRoot from granter's KV */
  async getGrantRecord(
    from: string,
    to: string,
    scope: string
  ): Promise<{ grantId: string; ttl: number; granterAgentId: string; tier?: AccessTier; capsuleRoot?: string } | null> {
    const grantorKv = new KvViews(this.storage, from);
    return grantorKv.getGrant(from, to, scope) as any;
  }

  /**
   * Fetch and verify the MemoryCapsule for a grant.
   * The recipient downloads the capsule blob and unwraps the kvSymKey.
   */
  async getCapsule(opts: {
    grantId: string;
    granterAddress: string;
    capsuleRoot: string;
    recipientPrivKey: string;
  }): Promise<{ capsule: MemoryCapsule; kvSymKey: Buffer }> {
    const { capsuleRoot, recipientPrivKey } = opts;

    // Download the capsule blob (encrypted to recipient's pubkey)
    const capsuleBytes = await this.storage.download(capsuleRoot, {
      privateKey: recipientPrivKey,
    });
    const capsule = decodeCapsule(capsuleBytes);

    // Verify signature
    const { valid, reason } = verifyCapsule(capsule);
    if (!valid) throw new Error(`MemoryCapsule invalid: ${reason}`);

    // Unwrap the kvSymKey using ECDH
    const kvSymKey = unwrapKey(
      capsule.wrappedKvKey,
      recipientPrivKey,
      capsule.granterPubKey
    );

    return { capsule, kvSymKey };
  }
}

function fallbackGrantId(from: string, to: string, scope: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${from}:${to}:${scope}:${Date.now()}`));
}
