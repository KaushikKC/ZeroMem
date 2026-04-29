import type { MemoryIndex } from './memory-index.js';
import type { VectorEntry, VectorRef, RecallResult } from './types.js';
import type { KvViews } from './kv-views.js';
import type { StorageClient } from './storage.js';

const MAX_PER_SHARD = 256;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 3600 * 1000; // 30-day half-life

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function recencyScore(ts: number): number {
  const ageMs = Date.now() - ts;
  return Math.exp((-Math.LN2 * ageMs) / RECENCY_HALF_LIFE_MS);
}

function parseSinceMs(since: string): number {
  const m = since.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms =
    unit === 's' ? n * 1000 :
    unit === 'm' ? n * 60_000 :
    unit === 'h' ? n * 3_600_000 :
    n * 86_400_000;
  return Date.now() - ms;
}

export class VectorIndex implements MemoryIndex {
  constructor(
    private kv: KvViews,
    private storage: StorageClient,
    private agentId: string
  ) {}

  /**
   * Insert a vector entry.
   * Embeddings live in Log blobs; KV shards store only small VectorRef records.
   */
  async insert(entry: VectorEntry & { payloadRoot?: string }): Promise<void> {
    const count = await this.kv.getItemCount(this.agentId, entry.namespace);
    const shard = Math.floor(count / MAX_PER_SHARD);
    const bytes = new TextEncoder().encode(JSON.stringify(entry));
    // Vector entries are stored UNENCRYPTED — they are index data (embeddings +
    // text snippet), not sensitive payload. Commit payload blobs are ECIES-protected.
    // Storing unencrypted makes cross-agent recall work: recipient can read
    // granter's index without needing the granter's private key.
    const rootHash = await this.storage.upload(bytes);

    await this.kv.appendToShard<VectorRef>(this.agentId, entry.namespace, shard, [
      { commitId: entry.commitId, rootHash },
    ]);
    await this.kv.incrementItemCount(this.agentId, entry.namespace);
  }

  async search(
    query: number[],
    opts: {
      k?: number;
      namespace?: string;
      tombstonedIds?: Set<string>;
      tags?: string[];
      since?: string;
      until?: string;
      minScore?: number;
      recencyWeight?: number;
    } = {}
  ): Promise<RecallResult[]> {
    const k = opts.k ?? 5;
    const ns = opts.namespace ?? 'default';
    const tombstoned = opts.tombstonedIds ?? new Set<string>();
    const recencyWeight = Math.min(1, Math.max(0, opts.recencyWeight ?? 0));
    const semanticWeight = 1 - recencyWeight;
    const minScore = opts.minScore ?? 0;
    const sinceMs = opts.since ? parseSinceMs(opts.since) : 0;
    const untilMs = opts.until ? parseSinceMs(opts.until) : 0;

    const itemCount = await this.kv.getItemCount(this.agentId, ns);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

    const shardArrays = await Promise.all(
      Array.from({ length: totalShards }, (_, s) =>
        this.kv.getShard<VectorRef>(this.agentId, ns, s)
      )
    );

    const candidates: Array<VectorEntry & { score: number }> = [];

    for (const refs of shardArrays) {
      for (const ref of refs) {
        if (tombstoned.has(ref.commitId)) continue;
        const e = await this.loadEntry(ref.rootHash);
        if (tombstoned.has(e.commitId)) continue;

        if (sinceMs > 0 && e.ts < sinceMs) continue;
        if (untilMs > 0 && e.ts > untilMs) continue;

        if (opts.tags && opts.tags.length > 0) {
          if (!opts.tags.every((t) => e.tags.includes(t))) continue;
        }

        const semantic = cosine(query, e.embedding);
        const recency = recencyScore(e.ts);
        const score = semanticWeight * semantic + recencyWeight * recency;

        if (score < minScore) continue;
        candidates.push({ ...e, score });
      }
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ commitId, text, score, ts, tags }) => ({
        commitId,
        text,
        score,
        ts,
        tags,
      }));
  }

  /** Delete a specific entry by commitId (rebuilds affected shard) */
  async remove(namespace: string, commitId: string): Promise<void> {
    const itemCount = await this.kv.getItemCount(this.agentId, namespace);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

    for (let s = 0; s < totalShards; s++) {
      const refs = await this.kv.getShard<VectorRef>(
        this.agentId,
        namespace,
        s
      );
      const filtered = refs.filter((e) => e.commitId !== commitId);
      if (filtered.length !== refs.length) {
        await this.kv.writeAll(this.agentId, namespace, s, filtered);
      }
    }
  }

  /** Merge all entries from srcNamespace into dstNamespace */
  async merge(srcNamespace: string, dstNamespace: string): Promise<void> {
    const itemCount = await this.kv.getItemCount(this.agentId, srcNamespace);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

    for (let s = 0; s < totalShards; s++) {
      const refs = await this.kv.getShard<VectorRef>(
        this.agentId,
        srcNamespace,
        s
      );
      for (const ref of refs) {
        const entry = await this.loadEntry(ref.rootHash);
        await this.insert({ ...entry, namespace: dstNamespace });
      }
    }
  }

  /**
   * Garbage collect: remove tombstoned entries from all shards.
   * Returns the number of entries removed.
   */
  async gc(namespace: string, tombstonedIds: Set<string>): Promise<number> {
    if (tombstonedIds.size === 0) return 0;

    const itemCount = await this.kv.getItemCount(this.agentId, namespace);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

    let removed = 0;
    for (let s = 0; s < totalShards; s++) {
      const refs = await this.kv.getShard<VectorRef>(this.agentId, namespace, s);
      const filtered = refs.filter((r) => !tombstonedIds.has(r.commitId));
      if (filtered.length < refs.length) {
        removed += refs.length - filtered.length;
        await this.kv.writeAll(this.agentId, namespace, s, filtered);
      }
    }

    if (removed > 0) {
      const newCount = Math.max(0, itemCount - removed);
      await this.kv.setItemCount(this.agentId, namespace, newCount);
    }

    return removed;
  }

  private async loadEntry(rootHash: string): Promise<VectorEntry> {
    // No decryption key needed — vector entries are stored unencrypted (see insert)
    const bytes = await this.storage.download(rootHash);
    return JSON.parse(new TextDecoder().decode(bytes)) as VectorEntry;
  }
}
