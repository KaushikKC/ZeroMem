import { ethers } from 'ethers';
import { KvViews } from './kv-views.js';
import type { StorageClient } from './storage.js';
import type { GrantRecord } from './types.js';

const GRANT_REGISTRY_ABI = [
  'function registerAgent(string calldata pubkey) external',
  'function grant(address to, bytes32 scopeHash, uint256 ttl, bytes32 commitRoot) external returns (bytes32)',
  'function revoke(bytes32 grantId) external',
  'function isGranted(address from, address to, bytes32 scopeHash) external view returns (bool)',
  'function grants(bytes32 grantId) external view returns (address from, address to, bytes32 scopeHash, uint256 ttl, bytes32 commitRoot, bool revoked)',
  'event AgentRegistered(address indexed agent, string pubkey)',
  'event GrantCreated(bytes32 indexed grantId, address indexed from, address indexed to, bytes32 scopeHash, uint256 ttl)',
  'event GrantRevoked(bytes32 indexed grantId)',
];

function scopeHash(scope: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(scope));
}

function ttlToTimestamp(ttl: string): bigint {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const m = ttl.match(/^(\d+)(s|m|h|d)$/);
  if (!m) throw new Error(`Invalid TTL format: ${ttl}. Use e.g. 24h, 30m, 7d`);
  const n = BigInt(m[1]);
  const unit = m[2];
  const secs =
    unit === 's' ? n :
    unit === 'm' ? n * 60n :
    unit === 'h' ? n * 3600n :
    n * 86400n;
  return now + secs;
}

export class GrantManager {
  private contract: ethers.Contract | null = null;

  constructor(
    private storage: StorageClient,
    private kv: KvViews,
    private wallet: ethers.Wallet,
    private registryAddress?: string,
    private rpcUrl?: string
  ) {}

  private getContract(): ethers.Contract {
    if (!this.registryAddress) {
      throw new Error('GrantRegistry contract address not configured');
    }
    if (!this.contract) {
      const provider = new ethers.JsonRpcProvider(this.rpcUrl);
      const signer = new ethers.Wallet(this.wallet.privateKey, provider);
      this.contract = new ethers.Contract(
        this.registryAddress,
        GRANT_REGISTRY_ABI,
        signer
      );
    }
    return this.contract;
  }

  async registerAgent(pubkey: string): Promise<void> {
    try {
      const contract = this.getContract();
      const tx = await contract.registerAgent(pubkey);
      await tx.wait();
    } catch {
      // no contract deployed yet — silently skip
    }
  }

  /**
   * Grant read access to a memory scope.
   * - Re-uploads head commit payload encrypted to recipient pubkey
   * - Writes grant record into granter's KV stream (this.kv = granter's)
   * - Optionally records on-chain via GrantRegistry
   */
  async createGrant(opts: {
    from: string;
    granterAgentId: string;
    to: string;
    toPubKey: string;
    scope: string;
    ttl: string;
    headCommitId: string;
    privateKey: string;
  }): Promise<string> {
    const { from, granterAgentId, to, toPubKey, scope, ttl, headCommitId, privateKey } = opts;

    // Re-encrypt head commit for recipient
    const data = await this.storage.download(headCommitId, { privateKey });
    const payloadRoot = await this.storage.upload(data, {
      encrypt: true,
      recipientPubKey: toPubKey,
    });

    const ttlTimestamp = ttlToTimestamp(ttl);
    const sh = scopeHash(scope);
    const commitRootBytes = ethers.zeroPadValue(
      ethers.toBeHex(ethers.keccak256(ethers.toUtf8Bytes(headCommitId))),
      32
    );

    let grantId: string;
    try {
      const contract = this.getContract();
      const tx = await contract.grant(to, sh, ttlTimestamp, commitRootBytes);
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((l: any) => {
          try { return contract.interface.parseLog(l); } catch { return null; }
        })
        .find((e: any) => e?.name === 'GrantCreated');
      grantId =
        event?.args?.grantId ??
        ethers.keccak256(ethers.toUtf8Bytes(`${from}:${to}:${scope}:${Date.now()}`));
    } catch {
      grantId = ethers.keccak256(
        ethers.toUtf8Bytes(`${from}:${to}:${scope}:${Date.now()}`)
      );
    }

    // Write to granter's KV stream (this.kv is always the granter's)
    await this.kv.setGrant(from, to, scope, grantId, Number(ttlTimestamp), granterAgentId);

    return grantId;
  }

  /** Revoke a grant — removes from granter's KV + on-chain */
  async revoke(grantId: string, scope: string, to: string): Promise<void> {
    try {
      const contract = this.getContract();
      const tx = await contract.revoke(grantId);
      await tx.wait();
    } catch {
      // no contract
    }
    // Remove from granter's KV stream
    await this.kv.removeGrant(this.wallet.address, to, scope);
  }

  /**
   * Check if a grant is valid.
   * Reads from the GRANTER's KV stream (keyed by `from` address).
   */
  async isGranted(from: string, to: string, scope: string): Promise<boolean> {
    // Read from granter's KV stream, not the local (recipient's) stream
    const grantorKv = new KvViews(this.storage, from);
    const record = await grantorKv.getGrant(from, to, scope);

    if (!record) return false;
    if (record.ttl < Math.floor(Date.now() / 1000)) return false;

    // Best-effort on-chain confirmation
    try {
      const contract = this.getContract();
      return (await contract.isGranted(from, to, scopeHash(scope))) as boolean;
    } catch {
      return true; // trust KV if no contract
    }
  }

  /**
   * Read the full grant record from the granter's KV stream.
   * Used by recallFromGrant to get granterAgentId for KV index lookups.
   */
  async getGrantRecord(
    from: string,
    to: string,
    scope: string
  ): Promise<{ grantId: string; ttl: number; granterAgentId: string } | null> {
    const grantorKv = new KvViews(this.storage, from);
    return grantorKv.getGrant(from, to, scope);
  }
}
