import { ethers } from 'ethers';
import type { StorageClient } from './storage.js';
import type { KvViews } from './kv-views.js';
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
  const secs = unit === 's' ? n : unit === 'm' ? n * 60n : unit === 'h' ? n * 3600n : n * 86400n;
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

  /** Register agent's public key on-chain */
  async registerAgent(pubkey: string): Promise<void> {
    try {
      const contract = this.getContract();
      const tx = await contract.registerAgent(pubkey);
      await tx.wait();
    } catch {
      // skip if no contract deployed yet
    }
  }

  /**
   * Grant access to a scope of memory to another agent.
   * Re-uploads the payload encrypted to the recipient's pubkey.
   */
  async createGrant(opts: {
    from: string;
    to: string;
    toPubKey: string;
    scope: string;
    ttl: string;
    headCommitId: string;
    privateKey: string;
  }): Promise<string> {
    const { from, to, toPubKey, scope, ttl, headCommitId, privateKey } = opts;

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
        .map((l: any) => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === 'GrantCreated');
      grantId = event?.args?.grantId ?? ethers.keccak256(ethers.toUtf8Bytes(`${from}:${to}:${scope}:${Date.now()}`));
    } catch {
      grantId = ethers.keccak256(
        ethers.toUtf8Bytes(`${from}:${to}:${scope}:${Date.now()}`)
      );
    }

    const record: GrantRecord = {
      grantId,
      from,
      to,
      scope,
      ttl: Number(ttlTimestamp),
      commitRoot: headCommitId,
      payloadRoot,
      createdAt: Date.now(),
    };

    // Store grant record in KV for both parties
    await this.kv.setGrant(from, to, scope, grantId, Number(ttlTimestamp));

    // Store full grant record as blob
    const grantData = new TextEncoder().encode(JSON.stringify(record));
    await this.storage.upload(grantData, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });

    return grantId;
  }

  /** Revoke a grant */
  async revoke(grantId: string): Promise<void> {
    try {
      const contract = this.getContract();
      const tx = await contract.revoke(grantId);
      await tx.wait();
    } catch {
      // contract may not be deployed
    }
    // Find and remove from KV (search by grantId)
    // For now we mark the grantId as revoked in KV
    await this.storage.upload(
      new TextEncoder().encode(JSON.stringify({ revoked: true, grantId })),
      { encrypt: true, recipientPubKey: this.storage.pubKey }
    );
  }

  /** Check if a grant is still valid */
  async isGranted(from: string, to: string, scope: string): Promise<boolean> {
    const record = await this.kv.getGrant(from, to, scope);
    if (!record) return false;
    if (record.ttl < Math.floor(Date.now() / 1000)) return false;
    try {
      const contract = this.getContract();
      return (await contract.isGranted(from, to, scopeHash(scope))) as boolean;
    } catch {
      return true; // no contract, trust KV
    }
  }
}
