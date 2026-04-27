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

  /**
   * Insert a vector entry.
   * Shard is derived from the persisted item count so restarts always
   * land in the correct bucket even after a KV wipe + restore.
   */
  async insert(entry: VectorEntry): Promise<void> {
    const count = await this.kv.getItemCount(this.agentId, entry.namespace);
    const shard = Math.floor(count / MAX_PER_SHARD);

    await this.kv.appendToShard(this.agentId, entry.namespace, shard, [entry]);
    await this.kv.incrementItemCount(this.agentId, entry.namespace);
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

    const itemCount = await this.kv.getItemCount(this.agentId, ns);
    // Always scan at least shard 0; add +1 so a partially-filled last shard is included
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

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

  /** Delete a specific entry by commitId (rebuilds affected shard) */
  async remove(namespace: string, commitId: string): Promise<void> {
    const itemCount = await this.kv.getItemCount(this.agentId, namespace);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

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

  /** Merge all entries from srcNamespace into dstNamespace */
  async merge(srcNamespace: string, dstNamespace: string): Promise<void> {
    const itemCount = await this.kv.getItemCount(this.agentId, srcNamespace);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

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
