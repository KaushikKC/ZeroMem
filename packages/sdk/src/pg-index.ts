import { createRequire } from 'module';
import type { MemoryIndex } from './memory-index.js';
import type { StorageClient } from './storage.js';
import type { RecallResult, VectorEntry } from './types.js';
import { DEFAULTS } from './types.js';

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end?: () => Promise<void>;
};

function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

const RECENCY_HALF_LIFE_MS = 30 * 24 * 3600 * 1000;

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

export class PostgresVectorIndex implements MemoryIndex {
  private clientPromise: Promise<PgClient>;

  constructor(
    private storage: StorageClient,
    private agentId: string,
    private postgresUrl: string,
    private embeddingDim: number = DEFAULTS.EMBEDDING_DIM,
    private clientFactory?: () => Promise<PgClient>
  ) {
    this.clientPromise = this.connect();
  }

  async init(): Promise<void> {
    const client = await this.clientPromise;
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`
      CREATE TABLE IF NOT EXISTS vector_entries (
        agent_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        commit_id TEXT NOT NULL,
        payload_root TEXT NOT NULL,
        embedding vector(${this.embeddingDim}) NOT NULL,
        ts BIGINT NOT NULL,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_id, namespace, commit_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vector_entries_lookup
      ON vector_entries (agent_id, namespace)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vector_entries_embedding
      ON vector_entries USING hnsw (embedding vector_cosine_ops)
    `);
  }

  async insert(entry: VectorEntry & { payloadRoot?: string }): Promise<void> {
    if (!entry.payloadRoot) {
      throw new Error('PostgresVectorIndex.insert requires payloadRoot');
    }
    const client = await this.clientPromise;
    await client.query(
      `
        INSERT INTO vector_entries (
          agent_id, namespace, commit_id, payload_root, embedding, ts, tags
        ) VALUES ($1, $2, $3, $4, $5::vector, $6, $7::jsonb)
        ON CONFLICT (agent_id, namespace, commit_id)
        DO UPDATE SET
          payload_root = EXCLUDED.payload_root,
          embedding = EXCLUDED.embedding,
          ts = EXCLUDED.ts,
          tags = EXCLUDED.tags
      `,
      [
        this.agentId,
        entry.namespace,
        entry.commitId,
        entry.payloadRoot,
        toVectorLiteral(entry.embedding),
        entry.ts,
        JSON.stringify(entry.tags ?? []),
      ]
    );
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
    const tombstoned = Array.from(opts.tombstonedIds ?? []);
    const recencyWeight = Math.min(1, Math.max(0, opts.recencyWeight ?? 0));
    const semanticWeight = 1 - recencyWeight;
    const minScore = opts.minScore ?? 0;
    const sinceMs = opts.since ? parseSinceMs(opts.since) : 0;
    const untilMs = opts.until ? parseSinceMs(opts.until) : 0;

    const fetchLimit = Math.min(500, Math.max(k * 25, 40));
    const client = await this.clientPromise;

    const { rows } = await client.query(
      `
        SELECT commit_id, payload_root, ts, tags, (embedding <=> $3::vector) AS distance
        FROM vector_entries
        WHERE agent_id = $1
          AND namespace = $2
          AND NOT (commit_id = ANY($4::text[]))
        ORDER BY embedding <=> $3::vector
        LIMIT $5
      `,
      [this.agentId, ns, toVectorLiteral(query), tombstoned, fetchLimit]
    );

    const candidates: RecallResult[] = [];
    for (const row of rows) {
      try {
        const data = await this.storage.download(row.payload_root, {
          privateKey: this.storage.decryptKey,
        });
        const payload = JSON.parse(new TextDecoder().decode(data)) as {
          text?: string;
          tags?: string[];
        };
        if (!payload.text) continue;
        const ts = Number(row.ts);
        const tags = Array.isArray(row.tags) ? row.tags : payload.tags ?? [];

        if (sinceMs > 0 && ts < sinceMs) continue;
        if (untilMs > 0 && ts > untilMs) continue;

        if (opts.tags && opts.tags.length > 0) {
          if (!opts.tags.every((t) => tags.includes(t))) continue;
        }

        const semantic = 1 - Number(row.distance);
        const recency = recencyScore(ts);
        const score = semanticWeight * semantic + recencyWeight * recency;

        if (score < minScore) continue;

        candidates.push({
          commitId: row.commit_id,
          text: payload.text,
          score,
          ts,
          tags,
        });
      } catch {
        // Skip blobs that cannot be downloaded/decrypted
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, k);
  }

  async remove(namespace: string, commitId: string): Promise<void> {
    const client = await this.clientPromise;
    await client.query(
      `DELETE FROM vector_entries WHERE agent_id = $1 AND namespace = $2 AND commit_id = $3`,
      [this.agentId, namespace, commitId]
    );
  }

  async merge(srcNamespace: string, dstNamespace: string): Promise<void> {
    const client = await this.clientPromise;
    await client.query(
      `
        INSERT INTO vector_entries (
          agent_id, namespace, commit_id, payload_root, embedding, ts, tags
        )
        SELECT agent_id, $2, commit_id, payload_root, embedding, ts, tags
        FROM vector_entries
        WHERE agent_id = $1 AND namespace = $3
        ON CONFLICT (agent_id, namespace, commit_id)
        DO NOTHING
      `,
      [this.agentId, dstNamespace, srcNamespace]
    );
  }

  async gc(namespace: string, tombstonedIds: Set<string>): Promise<number> {
    if (tombstonedIds.size === 0) return 0;
    const ids = [...tombstonedIds];
    const client = await this.clientPromise;
    const res = await client.query(
      `DELETE FROM vector_entries WHERE agent_id = $1 AND namespace = $2 AND commit_id = ANY($3::text[])`,
      [this.agentId, namespace, ids]
    );
    return (res as { rowCount?: number }).rowCount ?? 0;
  }

  private async connect(): Promise<PgClient> {
    if (this.clientFactory) return this.clientFactory();
    let mod: any;
    try {
      const runtimeRequire = createRequire(__filename);
      mod = runtimeRequire('pg');
    } catch {
      throw new Error(
        "Postgres vector index requested but 'pg' is not installed. Run: npm install pg"
      );
    }
    const Client = mod.Client;
    const client = new Client({ connectionString: this.postgresUrl });
    await client.connect();
    return client as PgClient;
  }
}
