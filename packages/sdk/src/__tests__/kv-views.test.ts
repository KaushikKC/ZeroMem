import { KvViews } from '../kv-views';
import { StorageClient } from '../storage';
import { MockStorageClient } from './helpers';

function makeKv(): { kv: KvViews; store: MockStorageClient } {
  const store = new MockStorageClient();
  // Patch static method so KvViews uses the mock's stream ID derivation
  jest
    .spyOn(StorageClient, 'streamId')
    .mockImplementation((addr) => MockStorageClient.streamId(addr));
  const kv = new KvViews(store as unknown as StorageClient, '0xTestAgent');
  return { kv, store };
}

afterEach(() => jest.restoreAllMocks());

describe('KvViews — HEAD pointers', () => {
  test('getHead returns null when no head set', async () => {
    const { kv } = makeKv();
    const head = await kv.getHead('agent1', 'main');
    expect(head).toBeNull();
  });

  test('setHead then getHead returns the commitId', async () => {
    const { kv } = makeKv();
    await kv.setHead('agent1', 'main', '0xcommit1');
    expect(await kv.getHead('agent1', 'main')).toBe('0xcommit1');
  });

  test('setHead overwrites previous value', async () => {
    const { kv } = makeKv();
    await kv.setHead('agent1', 'main', '0xcommit1');
    await kv.setHead('agent1', 'main', '0xcommit2');
    expect(await kv.getHead('agent1', 'main')).toBe('0xcommit2');
  });

  test('different agents have independent heads', async () => {
    const { kv } = makeKv();
    await kv.setHead('agentA', 'main', '0xA');
    await kv.setHead('agentB', 'main', '0xB');
    expect(await kv.getHead('agentA', 'main')).toBe('0xA');
    expect(await kv.getHead('agentB', 'main')).toBe('0xB');
  });

  test('different branches have independent heads', async () => {
    const { kv } = makeKv();
    await kv.setHead('agent1', 'main', '0xMain');
    await kv.setHead('agent1', 'feature', '0xFeature');
    expect(await kv.getHead('agent1', 'main')).toBe('0xMain');
    expect(await kv.getHead('agent1', 'feature')).toBe('0xFeature');
  });
});

describe('KvViews — item count', () => {
  test('getItemCount returns 0 initially', async () => {
    const { kv } = makeKv();
    expect(await kv.getItemCount('agent1', 'default')).toBe(0);
  });

  test('incrementItemCount increments by 1', async () => {
    const { kv } = makeKv();
    await kv.incrementItemCount('agent1', 'default');
    expect(await kv.getItemCount('agent1', 'default')).toBe(1);
    await kv.incrementItemCount('agent1', 'default');
    expect(await kv.getItemCount('agent1', 'default')).toBe(2);
  });

  test('namespaces are independent', async () => {
    const { kv } = makeKv();
    await kv.incrementItemCount('agent1', 'ns1');
    await kv.incrementItemCount('agent1', 'ns1');
    await kv.incrementItemCount('agent1', 'ns2');
    expect(await kv.getItemCount('agent1', 'ns1')).toBe(2);
    expect(await kv.getItemCount('agent1', 'ns2')).toBe(1);
  });
});

describe('KvViews — grants', () => {
  test('getGrant returns null when not set', async () => {
    const { kv } = makeKv();
    expect(await kv.getGrant('0xFrom', '0xTo', 'research')).toBeNull();
  });

  test('setGrant / getGrant roundtrip includes granterAgentId', async () => {
    const { kv } = makeKv();
    await kv.setGrant('0xFrom', '0xTo', 'research', '0xGrantId', 9999999, 'researcher-v1');
    const record = await kv.getGrant('0xFrom', '0xTo', 'research');
    expect(record).not.toBeNull();
    expect(record!.grantId).toBe('0xGrantId');
    expect(record!.ttl).toBe(9999999);
    expect(record!.granterAgentId).toBe('researcher-v1');
  });

  test('removeGrant makes getGrant return null', async () => {
    const { kv } = makeKv();
    await kv.setGrant('0xFrom', '0xTo', 'research', '0xGrantId', 9999999, 'researcher-v1');
    await kv.removeGrant('0xFrom', '0xTo', 'research');
    expect(await kv.getGrant('0xFrom', '0xTo', 'research')).toBeNull();
  });
});

describe('KvViews — grant reverse-index', () => {
  test('setGrantIndex / getGrantIndex roundtrip', async () => {
    const { kv } = makeKv();
    await kv.setGrantIndex('0xGrantId123', { from: '0xA', to: '0xB', scope: 'work' });
    const meta = await kv.getGrantIndex('0xGrantId123');
    expect(meta).toEqual({ from: '0xA', to: '0xB', scope: 'work' });
  });

  test('getGrantIndex returns null for unknown grantId', async () => {
    const { kv } = makeKv();
    expect(await kv.getGrantIndex('0xUnknown')).toBeNull();
  });
});

describe('KvViews — skill manifest', () => {
  test('getSkillManifest returns [] when empty', async () => {
    const { kv } = makeKv();
    expect(await kv.getSkillManifest('agent1')).toEqual([]);
  });

  test('setSkillManifest / getSkillManifest roundtrip', async () => {
    const { kv } = makeKv();
    await kv.setSkillManifest('agent1', ['summarize', 'translate']);
    expect(await kv.getSkillManifest('agent1')).toEqual(['summarize', 'translate']);
  });

  test('overwrite manifest replaces fully', async () => {
    const { kv } = makeKv();
    await kv.setSkillManifest('agent1', ['a', 'b']);
    await kv.setSkillManifest('agent1', ['c']);
    expect(await kv.getSkillManifest('agent1')).toEqual(['c']);
  });
});

describe('KvViews — tombstones', () => {
  test('isTombed returns false initially', async () => {
    const { kv } = makeKv();
    expect(await kv.isTombed('agent1', '0xcommit1')).toBe(false);
  });

  test('setTomb / isTombed', async () => {
    const { kv } = makeKv();
    await kv.setTomb('agent1', '0xcommit1');
    expect(await kv.isTombed('agent1', '0xcommit1')).toBe(true);
    expect(await kv.isTombed('agent1', '0xcommit2')).toBe(false);
  });
});

describe('KvViews — branches', () => {
  test('getBranches returns [] initially', async () => {
    const { kv } = makeKv();
    expect(await kv.getBranches('agent1')).toEqual([]);
  });

  test('addBranch accumulates unique names', async () => {
    const { kv } = makeKv();
    await kv.addBranch('agent1', 'main');
    await kv.addBranch('agent1', 'feature');
    await kv.addBranch('agent1', 'main'); // duplicate — no-op
    expect(await kv.getBranches('agent1')).toEqual(['main', 'feature']);
  });
});

describe('KvViews — root commit anchor', () => {
  test('getRootCommit returns null when not set', async () => {
    const { kv } = makeKv();
    expect(await kv.getRootCommit('agent1', 'main')).toBeNull();
  });

  test('setRootCommitIfAbsent writes once then ignores', async () => {
    const { kv } = makeKv();
    await kv.setRootCommitIfAbsent('agent1', 'main', '0xRoot1');
    await kv.setRootCommitIfAbsent('agent1', 'main', '0xRoot2'); // must not overwrite
    expect(await kv.getRootCommit('agent1', 'main')).toBe('0xRoot1');
  });
});
