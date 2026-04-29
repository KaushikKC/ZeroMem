import type { VectorEntry, RecallResult, SearchOpts } from './types.js';
import type { KvViews } from './kv-views.js';

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
  const ms = unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
  return Date.now() - ms;
}

export class VectorIndex {
  constructor(
    private kv: KvViews,
    private agentId: string
  ) {}

  /**
   * Insert a vector entry.
   * Shard index is derived from the persisted item count so restarts always
   * land in the correct bucket even after a KV wipe + restore.
   */
  async insert(entry: VectorEntry): Promise<void> {
    const count = await this.kv.getItemCount(this.agentId, entry.namespace);
    const shard = Math.floor(count / MAX_PER_SHARD);

    await this.kv.appendToShard(this.agentId, entry.namespace, shard, [entry]);
    await this.kv.incrementItemCount(this.agentId, entry.namespace);
  }

  /**
   * Find top-k entries by cosine similarity across all shards.
   * Shards are fetched in parallel for speed.
   * Supports optional tag, time, score, and recency filters.
   */
  async search(
    query: number[],
    opts: {
      k?: number;
      namespace?: string;
      tombstonedIds?: Set<string>;
      // SearchOpts subset:
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

    // Fetch all shards in parallel
    const shardArrays = await Promise.all(
      Array.from({ length: totalShards }, (_, s) =>
        this.kv.getShard<VectorEntry>(this.agentId, ns, s)
      )
    );

    const candidates: Array<VectorEntry & { score: number }> = [];

    for (const entries of shardArrays) {
      for (const e of entries) {
        if (tombstoned.has(e.commitId)) continue;

        // Time filters
        if (sinceMs > 0 && e.ts < sinceMs) continue;
        if (untilMs > 0 && e.ts > untilMs) continue;

        // Tag filter — entry must contain ALL requested tags
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

    const shardArrays = await Promise.all(
      Array.from({ length: totalShards }, (_, s) =>
        this.kv.getShard<VectorEntry>(this.agentId, namespace, s)
      )
    );

    for (let s = 0; s < shardArrays.length; s++) {
      const filtered = shardArrays[s].filter((e) => e.commitId !== commitId);
      if (filtered.length !== shardArrays[s].length) {
        await this.kv.writeAll(this.agentId, namespace, s, filtered);
      }
    }
  }

  /** Merge all entries from srcNamespace into dstNamespace */
  async merge(srcNamespace: string, dstNamespace: string): Promise<void> {
    const itemCount = await this.kv.getItemCount(this.agentId, srcNamespace);
    const totalShards = Math.max(1, Math.ceil(itemCount / MAX_PER_SHARD) + 1);

    const shardArrays = await Promise.all(
      Array.from({ length: totalShards }, (_, s) =>
        this.kv.getShard<VectorEntry>(this.agentId, srcNamespace, s)
      )
    );

    for (const entries of shardArrays) {
      for (const entry of entries) {
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

    const shardArrays = await Promise.all(
      Array.from({ length: totalShards }, (_, s) =>
        this.kv.getShard<VectorEntry>(this.agentId, namespace, s)
      )
    );

    let removed = 0;
    for (let s = 0; s < shardArrays.length; s++) {
      const original = shardArrays[s];
      const filtered = original.filter((e) => !tombstonedIds.has(e.commitId));
      if (filtered.length < original.length) {
        removed += original.length - filtered.length;
        await this.kv.writeAll(this.agentId, namespace, s, filtered);
      }
    }

    // Reset item count to reflect actual surviving entries
    if (removed > 0) {
      const newCount = Math.max(0, itemCount - removed);
      await this.kv.setItemCount(this.agentId, namespace, newCount);
    }

    return removed;
  }
}
