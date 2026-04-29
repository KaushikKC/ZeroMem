import { PostgresVectorIndex } from '../pg-index';
import { MockStorageClient, testEmbed } from './helpers';
import type { StorageClient } from '../storage';

type Row = {
  agent_id: string;
  namespace: string;
  commit_id: string;
  payload_root: string;
  embedding: number[];
  ts: number;
  tags: string[];
};

function parseVectorLiteral(input: string): number[] {
  return input
    .slice(1, -1)
    .split(',')
    .filter(Boolean)
    .map((x) => Number(x));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class FakePgClient {
  rows: Row[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    if (sql.includes('CREATE EXTENSION') || sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
      return { rows: [] };
    }

    if (sql.includes('INSERT INTO vector_entries') && sql.includes('VALUES')) {
      const [agent_id, namespace, commit_id, payload_root, vectorLiteral, ts, tagsJson] = params as [
        string,
        string,
        string,
        string,
        string,
        number,
        string,
      ];
      const existing = this.rows.find(
        (r) => r.agent_id === agent_id && r.namespace === namespace && r.commit_id === commit_id
      );
      const next: Row = {
        agent_id,
        namespace,
        commit_id,
        payload_root,
        embedding: parseVectorLiteral(vectorLiteral),
        ts,
        tags: JSON.parse(tagsJson),
      };
      if (existing) Object.assign(existing, next);
      else this.rows.push(next);
      return { rows: [] };
    }

    if (sql.includes('SELECT commit_id, payload_root, ts, tags')) {
      const [agentId, namespace, vectorLiteral, tombstoned, limit] = params as [
        string,
        string,
        string,
        string[],
        number,
      ];
      const queryVec = parseVectorLiteral(vectorLiteral);
      const filtered = this.rows
        .filter(
          (r) =>
            r.agent_id === agentId &&
            r.namespace === namespace &&
            !tombstoned.includes(r.commit_id)
        )
        .map((r) => ({
          commit_id: r.commit_id,
          payload_root: r.payload_root,
          ts: r.ts,
          tags: r.tags,
          distance: 1 - cosine(queryVec, r.embedding),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
      return { rows: filtered };
    }

    if (sql.startsWith('DELETE FROM vector_entries')) {
      const [agentId, namespace, commitId] = params as [string, string, string];
      this.rows = this.rows.filter(
        (r) => !(r.agent_id === agentId && r.namespace === namespace && r.commit_id === commitId)
      );
      return { rows: [] };
    }

    if (sql.includes('INSERT INTO vector_entries') && sql.includes('SELECT agent_id')) {
      const [agentId, dstNamespace, srcNamespace] = params as [string, string, string];
      const toCopy = this.rows.filter(
        (r) => r.agent_id === agentId && r.namespace === srcNamespace
      );
      for (const row of toCopy) {
        const exists = this.rows.some(
          (r) => r.agent_id === agentId && r.namespace === dstNamespace && r.commit_id === row.commit_id
        );
        if (!exists) {
          this.rows.push({ ...row, namespace: dstNamespace });
        }
      }
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in fake client: ${sql}`);
  }
}

describe('PostgresVectorIndex', () => {
  test('indexes payload roots and recalls only matched blobs', async () => {
    const store = new MockStorageClient();
    const client = new FakePgClient();
    const idx = new PostgresVectorIndex(
      store as unknown as StorageClient,
      'agent-a',
      'postgres://local/test',
      8,
      async () => client
    );

    await idx.init();

    const payload1 = new TextEncoder().encode(JSON.stringify({
      text: '0G storage uses merkle-rooted blobs',
      embedding: testEmbed('0G storage uses merkle-rooted blobs'),
      tags: ['storage'],
      ts: 1,
    }));
    const payload2 = new TextEncoder().encode(JSON.stringify({
      text: 'sealed inference keeps data private',
      embedding: testEmbed('sealed inference keeps data private'),
      tags: ['compute'],
      ts: 2,
    }));
    const root1 = await store.upload(payload1);
    const root2 = await store.upload(payload2);

    await idx.insert({
      commitId: 'c1',
      payloadRoot: root1,
      text: '0G storage uses merkle-rooted blobs',
      embedding: testEmbed('0G storage uses merkle-rooted blobs'),
      ts: 1,
      tags: ['storage'],
      namespace: 'main/default',
    });
    await idx.insert({
      commitId: 'c2',
      payloadRoot: root2,
      text: 'sealed inference keeps data private',
      embedding: testEmbed('sealed inference keeps data private'),
      ts: 2,
      tags: ['compute'],
      namespace: 'main/default',
    });

    const hits = await idx.search(testEmbed('0G storage uses merkle-rooted blobs'), {
      namespace: 'main/default',
      k: 1,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].commitId).toBe('c1');
    expect(hits[0].text).toContain('merkle-rooted blobs');
  });

  test('remove and merge operate on namespace-scoped rows', async () => {
    const store = new MockStorageClient();
    const client = new FakePgClient();
    const idx = new PostgresVectorIndex(
      store as unknown as StorageClient,
      'agent-a',
      'postgres://local/test',
      8,
      async () => client
    );
    await idx.init();

    const payload = new TextEncoder().encode(JSON.stringify({
      text: 'experimental branch note',
      embedding: testEmbed('experimental branch note'),
      tags: [],
      ts: 1,
    }));
    const root = await store.upload(payload);
    await idx.insert({
      commitId: 'c1',
      payloadRoot: root,
      text: 'experimental branch note',
      embedding: testEmbed('experimental branch note'),
      ts: 1,
      tags: [],
      namespace: 'feature/default',
    });

    await idx.merge('feature/default', 'main/default');
    let hits = await idx.search(testEmbed('experimental note'), {
      namespace: 'main/default',
      k: 5,
    });
    expect(hits.some((h) => h.commitId === 'c1')).toBe(true);

    await idx.remove('main/default', 'c1');
    hits = await idx.search(testEmbed('experimental note'), {
      namespace: 'main/default',
      k: 5,
    });
    expect(hits.some((h) => h.commitId === 'c1')).toBe(false);
  });
});
