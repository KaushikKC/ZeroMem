import { Indexer, MemData, KvClient } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { DEFAULTS } from './types.js';
import { ZeroMemStorageError } from './errors.js';

/** Exponential backoff: attempt fn up to `attempts` times */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw new ZeroMemStorageError(
    `Operation failed after ${attempts} attempts`,
    lastErr
  );
}

export interface UploadOpts {
  encrypt?: boolean;
  recipientPubKey?: string;
  privateKey?: string;
}

export interface DownloadOpts {
  privateKey?: string;
}

export class StorageClient {
  private indexer: Indexer;
  private kvClient: KvClient;
  private signer: ethers.Wallet;
  private privateKey: string;
  private rpcUrl: string;
  private flowContract: string;
  /**
   * Write-through cache: zgs_kv replay lags chain by minutes; cache lets
   * same-process reads see writes immediately. Survives restart only via Log replay.
   * Also serves as the in-memory fallback when the KV node is unreachable.
   */
  private kvCache = new Map<string, Uint8Array>();
  /** Flipped to true on first KV network failure — avoids retrying a down node */
  private kvNodeDown = false;

  /**
   * Process-level shared KV fallback — used when the real KV node is down.
   * Shared across ALL StorageClient instances so cross-agent reads work
   * even when each agent has its own instance (e.g. writer-a reading agent-a's grants).
   */
  private static sharedKv = new Map<string, Uint8Array>();

  constructor(
    privateKey: string,
    opts: {
      rpcUrl?: string;
      indexerUrl?: string;
      kvUrl?: string;
      flowContract?: string;
    } = {}
  ) {
    this.privateKey = privateKey;
    this.rpcUrl = opts.rpcUrl ?? DEFAULTS.RPC_URL;
    const indexerUrl = opts.indexerUrl ?? DEFAULTS.INDEXER_URL;
    const kvUrl = opts.kvUrl ?? DEFAULTS.KV_URL;
    this.flowContract = opts.flowContract ?? DEFAULTS.FLOW_CONTRACT;

    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, provider);
    this.indexer = new Indexer(indexerUrl);
    this.kvClient = new KvClient(kvUrl);
  }

  get address(): string {
    return this.signer.address;
  }

  get decryptKey(): string {
    return this.privateKey;
  }

  get pubKey(): string {
    return ethers.SigningKey.computePublicKey(
      this.signer.signingKey.publicKey,
      true
    );
  }

  /** Pick storage nodes whose logSyncHeight is close to chain head, covering both shards */
  private async healthyNodes(): Promise<any[]> {
    const sdk: any = await import('@0gfoundation/0g-ts-sdk');
    const { StorageNode } = sdk;
    const sharded: any = await this.indexer.getShardedNodes();
    const trusted: any[] = sharded?.trusted ?? [];
    const head = await this.signer.provider!.getBlockNumber();
    const HEALTH_LAG = 200;
    const checks = await Promise.all(
      trusted.map(async (n: any) => {
        const sn = new StorageNode(n.url);
        try {
          const st: any = await Promise.race([
            sn.getStatus(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
          ]);
          const h = Number(st?.logSyncHeight ?? 0);
          return h >= head - HEALTH_LAG ? { node: n, client: sn } : null;
        } catch { return null; }
      })
    );
    const healthy = checks.filter((x): x is { node: any; client: any } => x !== null);
    if (healthy.length === 0) throw new Error(`no healthy storage nodes (chain head=${head})`);
    const byShard = new Map<number, any>();
    for (const { node, client } of healthy) {
      const sid = node.config.shardId;
      if (!byShard.has(sid)) byShard.set(sid, client);
    }
    return Array.from(byShard.values());
  }

  /** Upload arbitrary bytes, optionally ECIES-encrypted to recipient (3 retries) */
  async upload(data: Uint8Array, opts: UploadOpts = {}): Promise<string> {
    return withRetry(() => this._upload(data, opts));
  }

  private async _upload(data: Uint8Array, opts: UploadOpts = {}): Promise<string> {
    const memData = new MemData(data);

    const sdk: any = await import('@0gfoundation/0g-ts-sdk');
    const { Uploader, FixedPriceFlow__factory, mergeUploadOptions, calculatePrice, getMarketContract } = sdk;

    const uploadOpts: Record<string, unknown> = {};
    if (opts.encrypt && opts.recipientPubKey) {
      uploadOpts.encryption = { type: 'ecies', recipientPubKey: opts.recipientPubKey };
    }
    const merged = mergeUploadOptions
      ? mergeUploadOptions({ ...uploadOpts, finalityRequired: false, skipIfFinalized: true })
      : { expectedReplica: 1, taskSize: 1, finalityRequired: false, fragmentSize: 4 * 1024 * 1024 * 1024, skipIfFinalized: true, ...uploadOpts };

    const nodes = await this.healthyNodes();

    // Use the live flowAddress reported by the storage node (matches official Indexer.upload behaviour).
    // Falls back to the configured address if the node doesn't report one.
    let flowAddress = this.flowContract;
    try {
      const nodeStatus: any = await nodes[0].getStatus();
      if (nodeStatus?.networkIdentity?.flowAddress) {
        flowAddress = nodeStatus.networkIdentity.flowAddress;
      }
    } catch { /* use configured default */ }

    const flow = FixedPriceFlow__factory.connect(flowAddress, this.signer);

    // Pre-flight: check balance covers fee + realistic gas cost (500K gas @ current price).
    // This surfaces a clear error instead of the cryptic "require(false)" that appears when
    // ethers internally eth_call's with a 50M gas default and the balance check fails.
    try {
      const marketAddr = await flow.market();
      const market = getMarketContract(marketAddr, this.signer.provider);
      const pricePerSector = await market.pricePerSector();
      const [submission] = await memData.createSubmission('0x', this.signer.address);
      if (submission) {
        const fee: bigint = calculatePrice(submission, pricePerSector);
        const feeData = await this.signer.provider!.getFeeData();
        const gasPrice: bigint = feeData.gasPrice ?? 4_000_000_000n;
        const GAS_BUDGET = 500_000n;
        const required = fee + gasPrice * GAS_BUDGET;
        const balance: bigint = await this.signer.provider!.getBalance(this.signer.address);
        if (balance < required) {
          throw new Error(
            `Insufficient balance for 0G upload. ` +
            `Have ${balance} wei (${(Number(balance) / 1e18).toFixed(8)} ETH), ` +
            `need ~${required} wei (${(Number(required) / 1e18).toFixed(8)} ETH) ` +
            `[fee=${fee} + ${GAS_BUDGET} gas x ${gasPrice} gasPrice]. ` +
            `Fund wallet ${this.signer.address} with testnet ETH from https://faucet.0g.ai`
          );
        }
      }
    } catch (e: any) {
      if (e.message?.includes('Insufficient balance')) throw e;
      // Non-balance errors (e.g. node unreachable) — let upload attempt proceed
      console.warn('pre-flight check skipped:', e.message);
    }

    // Set explicit gasLimit so ethers doesn't estimateGas with the 50M default,
    // which causes a spurious "insufficient funds" failure during estimation.
    const SUBMIT_GAS_LIMIT = 500_000n;
    const uploader = new Uploader(nodes, this.rpcUrl, flow, BigInt(0), SUBMIT_GAS_LIMIT);

    /** SDK bug: waitForLogEntry breaks on the first null node instead of trying all nodes.
     *  With sharded storage (numShard=2), node[0] may not hold the shard for this blob,
     *  so the loop never reaches node[1] and polls forever. Fix: try ALL nodes per tick,
     *  succeed if any returns non-null, and add a 90s hard timeout for the post-upload
     *  confirmation (data is already on-chain once "All tasks processed" is logged). */
    uploader.waitForLogEntry = async function (
      root: string,
      finalityRequired: boolean,
      txSeq: number,
      useTxSeq: boolean,
      onProgress?: (msg: string) => void
    ) {
      console.log('Wait for log entry on storage node');
      const WAIT_TIMEOUT_MS = 90_000;
      const start = Date.now();
      let info: any = null;
      while (true) {
        if (Date.now() - start > WAIT_TIMEOUT_MS) {
          console.log('waitForLogEntry: 90s timeout — data is on-chain, continuing');
          return info;
        }
        await new Promise((r) => setTimeout(r, 1000));
        for (const client of (this as any).nodes) {
          try {
            const candidate = useTxSeq
              ? await client.getFileInfoByTxSeq(txSeq)
              : await client.getFileInfo(root, true);
            if (candidate !== null) {
              info = candidate;
              break;
            }
          } catch { /* skip unresponsive node */ }
        }
        if (info !== null && (!finalityRequired || info.finalized)) break;
        try {
          const status = await (this as any).nodes[0].getStatus();
          if (status?.logSyncHeight) {
            const msg = `Waiting for storage node to sync (height=${status.logSyncHeight})...`;
            console.log(msg);
            onProgress?.(msg);
          }
        } catch { /* status fetch optional */ }
      }
      return info;
    };

    const [result, err] = await uploader.splitableUpload(memData, merged);
    if (err != null) throw new Error(`0G upload failed: ${err.message ?? err}`);
    const rootHash = result?.rootHashes?.[0] ?? result?.rootHash;
    if (!rootHash) throw new Error('0G upload returned no rootHash');
    return rootHash as string;
  }

  /** Download bytes, optionally ECIES-decrypt with private key */
  async download(rootHash: string, opts: DownloadOpts = {}): Promise<Uint8Array> {
    const dlOpts: Record<string, unknown> = { proof: true };
    if (opts.privateKey) {
      dlOpts.decryption = { privateKey: opts.privateKey };
    }

    const [blob, err] = await this.indexer.downloadToBlob(
      rootHash,
      dlOpts as any
    );
    if (err !== null) throw new Error(`0G download failed: ${err}`);
    const ab = await (blob as Blob).arrayBuffer();
    return new Uint8Array(ab);
  }

  /** Detect encryption mode of a blob (null = plaintext, 1 = AES-256, 2 = ECIES) */
  async peekHeader(rootHash: string): Promise<number | null> {
    const [header, err] = await this.indexer.peekHeader(rootHash);
    if (err !== null) return null;
    return (header as any)?.version ?? null;
  }

  /** KV read — returns null if key missing.
   *  Falls back to sharedKv (process-level) if the KV node is unreachable,
   *  enabling cross-agent reads even with no live KV node. */
  async kvGet(streamId: string, key: string): Promise<Uint8Array | null> {
    const cacheKey = `${streamId}:${key}`;

    // 1. Check instance-local write-through cache
    const cached = this.kvCache.get(cacheKey);
    if (cached !== undefined) return cached;

    // 2. If KV is down, check process-level shared map (cross-agent fallback)
    if (this.kvNodeDown || StorageClient.sharedKv.has(cacheKey)) {
      return StorageClient.sharedKv.get(cacheKey) ?? null;
    }

    try {
      const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
      const b64Key = Buffer.from(keyBytes).toString('base64');
      const value: any = await this.kvClient.getValue(streamId, b64Key as any);
      if (value == null) return null;
      const data = typeof value === 'string' ? value : value.data;
      if (data == null || data === '') return null;
      const bytes = Buffer.from(data, 'base64');
      this.kvCache.set(cacheKey, bytes);
      StorageClient.sharedKv.set(cacheKey, bytes);
      return bytes;
    } catch (e: any) {
      if (this.isNetworkError(e)) {
        if (!this.kvNodeDown) {
          console.warn('[ZeroMem] KV node unreachable — falling back to process-level shared KV (session only).');
          this.kvNodeDown = true;
        }
        return StorageClient.sharedKv.get(cacheKey) ?? null;
      }
      throw e;
    }
  }

  /** KV write — on-chain transaction with shared in-memory fallback when node is down */
  async kvSet(streamId: string, pairs: Array<{ key: string; value: Uint8Array }>): Promise<void> {
    // Always update both caches immediately (instance + process-level shared)
    for (const { key, value } of pairs) {
      const cacheKey = `${streamId}:${key}`;
      this.kvCache.set(cacheKey, value);
      StorageClient.sharedKv.set(cacheKey, value);
    }

    if (this.kvNodeDown) return;

    try {
      await withRetry(() => this._kvSet(streamId, pairs), 2, 200);
    } catch (e: any) {
      if (this.isNetworkError(e)) {
        if (!this.kvNodeDown) {
          console.warn('[ZeroMem] KV write failed — shared in-memory fallback active.');
          this.kvNodeDown = true;
        }
        return;
      }
      throw e;
    }
  }

  private isNetworkError(e: any): boolean {
    const code = e?.code ?? e?.cause?.code ?? '';
    const msg = (e?.message ?? '').toLowerCase();
    return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' ||
      msg.includes('econnrefused') || msg.includes('enotfound') ||
      msg.includes('etimedout') || msg.includes('network') ||
      // AxiosError with empty message is always a network issue
      (e?.constructor?.name === 'AxiosError' && !e.message);
  }

  private async _origKvSet(streamId: string, pairs: Array<{ key: string; value: Uint8Array }>): Promise<void> {
    return this._kvSet(streamId, pairs);
  }

  private async _kvSet(streamId: string, pairs: Array<{ key: string; value: Uint8Array }>): Promise<void> {
    const sdk: any = await import('@0gfoundation/0g-ts-sdk');
    const { Batcher, FixedPriceFlow__factory } = sdk;

    const nodes = await this.healthyNodes();
    const flowContractInstance = FixedPriceFlow__factory.connect(
      this.flowContract,
      this.signer,
    );
    const batcher = new Batcher(1, nodes, flowContractInstance, this.rpcUrl);

    for (const { key, value } of pairs) {
      const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
      batcher.streamDataBuilder.set(streamId, keyBytes, value);
      this.kvCache.set(`${streamId}:${key}`, value);
    }

    const [, batchErr] = await batcher.exec();
    if (batchErr !== null) throw new Error(`KV write failed: ${batchErr}`);
  }

  /** Deterministic stream ID for an agent (bytes32 hex) */
  static streamId(agentAddress: string): string {
    return ethers.keccak256(
      ethers.toUtf8Bytes(`zeromem:${agentAddress.toLowerCase()}`)
    );
  }
}
