import { Indexer, MemData, KvClient } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { DEFAULTS } from './types.js';

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
  private rpcUrl: string;
  private flowContract: string;

  constructor(
    privateKey: string,
    opts: {
      rpcUrl?: string;
      indexerUrl?: string;
      kvUrl?: string;
      flowContract?: string;
    } = {}
  ) {
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

  get pubKey(): string {
    return ethers.SigningKey.computePublicKey(
      this.signer.signingKey.publicKey,
      true
    );
  }

  /** Upload arbitrary bytes, optionally ECIES-encrypted to recipient */
  async upload(data: Uint8Array, opts: UploadOpts = {}): Promise<string> {
    const memData = new MemData(data);

    let uploadOpts: Record<string, unknown> | undefined;
    if (opts.encrypt && opts.recipientPubKey) {
      uploadOpts = {
        encryption: { type: 'ecies', recipientPubKey: opts.recipientPubKey },
      };
    }

    const [tx, err] = await this.indexer.upload(
      memData,
      this.rpcUrl,
      this.signer,
      uploadOpts as any
    );
    if (err !== null) throw new Error(`0G upload failed: ${err}`);
    return (tx as any).rootHash as string;
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

  /** KV read — returns null if key missing */
  async kvGet(streamId: string, key: string): Promise<Uint8Array | null> {
    const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
    const b64Key = Buffer.from(keyBytes).toString('base64');
    const value = await this.kvClient.getValue(streamId, b64Key as any);
    if (value == null) return null;
    return Buffer.from(value as unknown as string, 'base64');
  }

  /** KV write — on-chain transaction */
  async kvSet(streamId: string, pairs: Array<{ key: string; value: Uint8Array }>): Promise<void> {
    const [nodes, err] = await this.indexer.selectNodes(1);
    if (err !== null) throw new Error(`selectNodes failed: ${err}`);

    const { Batcher } = await import('@0gfoundation/0g-ts-sdk') as any;
    // flowContract as ethers.Contract instance so Batcher can sign transactions
    const flowContractInstance = new ethers.Contract(
      this.flowContract,
      [],
      this.signer
    );
    const batcher = new Batcher(1, nodes, flowContractInstance, this.rpcUrl);

    for (const { key, value } of pairs) {
      const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
      batcher.streamDataBuilder.set(streamId, keyBytes, value);
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
