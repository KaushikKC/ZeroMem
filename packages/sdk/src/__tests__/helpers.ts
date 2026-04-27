/**
 * In-memory StorageClient mock for unit tests.
 * Stores blobs and KV data in Maps — no network required.
 */
export class MockStorageClient {
  private kvStore = new Map<string, Uint8Array>();
  readonly blobStore = new Map<string, Uint8Array>();
  private blobCounter = 0;

  readonly address = '0x742d35Cc6634C0532925a3b8D4C9b5d6b9f7abcd';
  readonly pubKey =
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

  async upload(data: Uint8Array, _opts?: unknown): Promise<string> {
    const rootHash = `0x${'0'.repeat(63)}${(++this.blobCounter).toString(16)}`;
    this.blobStore.set(rootHash, new Uint8Array(data));
    return rootHash;
  }

  async download(rootHash: string, _opts?: unknown): Promise<Uint8Array> {
    const data = this.blobStore.get(rootHash);
    if (!data) throw new Error(`Blob not found: ${rootHash}`);
    return data;
  }

  async kvGet(streamId: string, key: string): Promise<Uint8Array | null> {
    return this.kvStore.get(`${streamId}::${key}`) ?? null;
  }

  async kvSet(
    streamId: string,
    pairs: Array<{ key: string; value: Uint8Array }>
  ): Promise<void> {
    for (const { key, value } of pairs) {
      this.kvStore.set(`${streamId}::${key}`, new Uint8Array(value));
    }
  }

  // Mirrors the real static method signature
  static streamId(address: string): string {
    return `mock_stream_${address.toLowerCase()}`;
  }

  /** Wipe only KV (simulates a KV-layer wipe while blobs survive on 0G) */
  resetKv(): void {
    this.kvStore.clear();
  }

  /** Full reset — new test isolation */
  reset(): void {
    this.kvStore.clear();
    this.blobStore.clear();
    this.blobCounter = 0;
  }
}

/**
 * Deterministic pseudo-embedding for unit tests.
 * Produces a unit-norm vector of the given dimension based on text content.
 * Texts that share words will have higher cosine similarity.
 */
export function testEmbed(text: string, dim = 8): number[] {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const vec = new Array<number>(dim).fill(0);
  for (const word of words) {
    // Hash word to a bucket
    let h = 0;
    for (let i = 0; i < word.length; i++) {
      h = (h * 31 + word.charCodeAt(i)) % dim;
    }
    vec[h] += 1;
  }
  // Normalize to unit vector
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}
