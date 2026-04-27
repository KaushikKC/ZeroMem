import type { VectorEntry, RecallResult } from './types.js';
import type { KvViews } from './kv-views.js';

const MAX_PER_SHARD = 256;

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

export class VectorIndex {
  constructor(
    private kv: KvViews,
    private agentId: string
  ) {}

  /** Insert a new vector entry into the appropriate KV shard */
  async insert(entry: VectorEntry): Promise<void> {
    const count = await this.kv.getShardCount(this.agentId, entry.namespace);
    let shard = Math.floor(count / MAX_PER_SHARD);

    const existing = await this.kv.getShard<VectorEntry>(
      this.agentId,
      entry.namespace,
      shard
    );

    if (existing.length >= MAX_PER_SHARD) {
      shard += 1;
    }

    await this.kv.appendToShard(this.agentId, entry.namespace, shard, [entry]);
  }

  /** Find top-k entries by cosine similarity across all shards */
  async search(
    query: number[],
    opts: {
      k?: number;
      namespace?: string;
      tombstonedIds?: Set<string>;
    } = {}
  ): Promise<RecallResult[]> {
    const k = opts.k ?? 5;
    const ns = opts.namespace ?? 'default';
    const tombstoned = opts.tombstonedIds ?? new Set<string>();

    const shardCount = await this.kv.getShardCount(this.agentId, ns);
    const totalShards = Math.max(1, Math.ceil(shardCount / MAX_PER_SHARD) + 1);

    const candidates: Array<VectorEntry & { score: number }> = [];

    for (let s = 0; s < totalShards; s++) {
      const entries = await this.kv.getShard<VectorEntry>(this.agentId, ns, s);
      for (const e of entries) {
        if (tombstoned.has(e.commitId)) continue;
        const score = cosine(query, e.embedding);
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

  /** Delete a specific entry by commitId (soft-delete via rebuild) */
  async remove(namespace: string, commitId: string): Promise<void> {
    const shardCount = await this.kv.getShardCount(this.agentId, namespace);
    const totalShards = Math.max(1, Math.ceil(shardCount / MAX_PER_SHARD) + 1);

    for (let s = 0; s < totalShards; s++) {
      const entries = await this.kv.getShard<VectorEntry>(
        this.agentId,
        namespace,
        s
      );
      const filtered = entries.filter((e) => e.commitId !== commitId);
      if (filtered.length !== entries.length) {
        await this.kv.writeAll(this.agentId, namespace, s, filtered);
      }
    }
  }

  /** Merge entries from another namespace/branch into this one */
  async merge(srcNamespace: string, dstNamespace: string): Promise<void> {
    const shardCount = await this.kv.getShardCount(this.agentId, srcNamespace);
    const totalShards = Math.max(1, Math.ceil(shardCount / MAX_PER_SHARD) + 1);

    for (let s = 0; s < totalShards; s++) {
      const entries = await this.kv.getShard<VectorEntry>(
        this.agentId,
        srcNamespace,
        s
      );
      for (const entry of entries) {
        await this.insert({ ...entry, namespace: dstNamespace });
      }
    }
  }
}
