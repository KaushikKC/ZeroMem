import { VectorIndex } from '../vector';
import { KvViews } from '../kv-views';
import { StorageClient } from '../storage';
import { MockStorageClient, testEmbed } from './helpers';
import type { VectorEntry } from '../types';

function makeIndex(): { idx: VectorIndex; kv: KvViews } {
  const store = new MockStorageClient();
  jest
    .spyOn(StorageClient, 'streamId')
    .mockImplementation((addr) => MockStorageClient.streamId(addr));
  const kv = new KvViews(store as unknown as StorageClient, '0xTestAgent');
  const idx = new VectorIndex(kv, store as unknown as StorageClient, 'test-agent');
  return { idx, kv };
}

afterEach(() => jest.restoreAllMocks());

function makeEntry(
  commitId: string,
  text: string,
  namespace = 'default'
): VectorEntry {
  return {
    commitId,
    text,
    embedding: testEmbed(text),
    ts: Date.now(),
    tags: [],
    namespace,
  };
}

describe('VectorIndex — insert and search', () => {
  test('insert then search returns the inserted entry', async () => {
    const { idx } = makeIndex();
    await idx.insert(makeEntry('c1', 'hello world storage'));
    const results = await idx.search(testEmbed('hello world storage'), { k: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].commitId).toBe('c1');
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  test('returns empty array when no entries exist', async () => {
    const { idx } = makeIndex();
    const results = await idx.search(testEmbed('anything'), { k: 5 });
    expect(results).toHaveLength(0);
  });

  test('search respects k limit', async () => {
    const { idx } = makeIndex();
    for (let i = 1; i <= 5; i++) {
      await idx.insert(makeEntry(`c${i}`, `memory number ${i}`));
    }
    const results = await idx.search(testEmbed('memory'), { k: 3 });
    expect(results).toHaveLength(3);
  });

  test('results are sorted by score descending', async () => {
    const { idx } = makeIndex();
    await idx.insert(makeEntry('cA', 'blockchain storage layer'));
    await idx.insert(makeEntry('cB', 'sealed inference compute gpu'));
    await idx.insert(makeEntry('cC', 'blockchain storage merkle'));

    // Query most similar to "storage" entries
    const results = await idx.search(testEmbed('blockchain storage'), { k: 3 });
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    // Top result should mention blockchain or storage
    expect(['cA', 'cC']).toContain(results[0].commitId);
  });

  test('tombstoned entries are excluded from search', async () => {
    const { idx } = makeIndex();
    await idx.insert(makeEntry('c1', 'important memory'));
    await idx.insert(makeEntry('c2', 'other memory'));

    const tombstoned = new Set(['c1']);
    const results = await idx.search(testEmbed('important memory'), {
      k: 5,
      tombstonedIds: tombstoned,
    });
    expect(results.every((r) => r.commitId !== 'c1')).toBe(true);
  });
});

describe('VectorIndex — item count tracking', () => {
  test('item count increments on each insert', async () => {
    const { idx, kv } = makeIndex();
    expect(await kv.getItemCount('test-agent', 'default')).toBe(0);
    await idx.insert(makeEntry('c1', 'first'));
    expect(await kv.getItemCount('test-agent', 'default')).toBe(1);
    await idx.insert(makeEntry('c2', 'second'));
    expect(await kv.getItemCount('test-agent', 'default')).toBe(2);
  });

  test('namespaces have independent counts', async () => {
    const { idx, kv } = makeIndex();
    await idx.insert(makeEntry('c1', 'entry a', 'ns1'));
    await idx.insert(makeEntry('c2', 'entry b', 'ns1'));
    await idx.insert(makeEntry('c3', 'entry c', 'ns2'));
    expect(await kv.getItemCount('test-agent', 'ns1')).toBe(2);
    expect(await kv.getItemCount('test-agent', 'ns2')).toBe(1);
  });
});

describe('VectorIndex — sharding', () => {
  test('entries overflow into shard 1 after 256', async () => {
    const { idx, kv } = makeIndex();
    // Insert 257 entries
    for (let i = 0; i < 257; i++) {
      await idx.insert(makeEntry(`c${i}`, `memory item ${i}`));
    }
    const count = await kv.getItemCount('test-agent', 'default');
    expect(count).toBe(257);

    // Shard 0 should have 256 entries, shard 1 should have 1
    const shard0 = await kv.getShard('test-agent', 'default', 0);
    const shard1 = await kv.getShard('test-agent', 'default', 1);
    expect(shard0).toHaveLength(256);
    expect(shard1).toHaveLength(1);
  });

  test('search finds entries across both shards', async () => {
    const { idx } = makeIndex();
    // Fill shard 0 and overflow into shard 1
    for (let i = 0; i < 256; i++) {
      await idx.insert(makeEntry(`c${i}`, `generic item number ${i}`));
    }
    // This one goes into shard 1
    await idx.insert(makeEntry('needle', 'unique zebra quartz knowledge'));

    const results = await idx.search(testEmbed('unique zebra quartz knowledge'), {
      k: 1,
    });
    expect(results[0].commitId).toBe('needle');
  });
});

describe('VectorIndex — remove', () => {
  test('remove deletes entry from search results', async () => {
    const { idx } = makeIndex();
    await idx.insert(makeEntry('c1', 'memory to keep'));
    await idx.insert(makeEntry('c2', 'memory to delete'));
    await idx.remove('default', 'c2');

    const results = await idx.search(testEmbed('memory to delete'), { k: 5 });
    expect(results.every((r) => r.commitId !== 'c2')).toBe(true);
  });

  test('remove on non-existent commitId is a no-op', async () => {
    const { idx } = makeIndex();
    await idx.insert(makeEntry('c1', 'keep this'));
    await expect(idx.remove('default', 'nonexistent')).resolves.not.toThrow();
    const results = await idx.search(testEmbed('keep this'), { k: 5 });
    expect(results).toHaveLength(1);
  });
});

describe('VectorIndex — merge', () => {
  test('merge copies all entries from src to dst namespace', async () => {
    const { idx, kv } = makeIndex();
    await idx.insert(makeEntry('c1', 'research finding one', 'experiment'));
    await idx.insert(makeEntry('c2', 'research finding two', 'experiment'));

    await idx.merge('experiment', 'main');

    const mainCount = await kv.getItemCount('test-agent', 'main');
    expect(mainCount).toBe(2);

    const results = await idx.search(testEmbed('research finding'), {
      k: 5,
      namespace: 'main',
    });
    expect(results).toHaveLength(2);
  });
});
