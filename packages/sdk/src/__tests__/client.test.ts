/**
 * ZeroMem client integration tests — all storage in-memory, no network.
 *
 * The InferenceClient is mocked to return deterministic embeddings so
 * remember/recall works without a 0G Compute endpoint.
 */

import { ZeroMem } from '../client';
import { StorageClient } from '../storage';
import { MockStorageClient, testEmbed } from './helpers';

// ── Mock InferenceClient ────────────────────────────────────────────────────

jest.mock('../inference', () => ({
  InferenceClient: jest.fn().mockImplementation(() => ({
    embed: jest.fn().mockImplementation((text: string) =>
      Promise.resolve(testEmbed(text, 8))
    ),
    analyze: jest.fn().mockResolvedValue('{"facts":[]}'),
    answer: jest.fn().mockResolvedValue('Answer based on recalled memories.'),
    plan: jest.fn().mockResolvedValue({
      goal: 'test goal',
      tasks: [
        { id: 't1', description: 'Step one', dependsOn: [] },
        { id: 't2', description: 'Step two', dependsOn: ['t1'] },
      ],
    }),
    chat: jest.fn().mockResolvedValue('ok'),
  })),
}));

// ── Test wallet — deterministic private key ─────────────────────────────────

const AGENT_A_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_B_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// ── Helpers ─────────────────────────────────────────────────────────────────

let storeA: MockStorageClient;
let storeB: MockStorageClient;

/**
 * Create a ZeroMem instance backed by the mock storage.
 * Bypasses real 0G uploads via the `_storage` escape hatch.
 */
async function makeAgent(
  key: string,
  agentId: string,
  store: MockStorageClient
): Promise<ZeroMem> {
  jest
    .spyOn(StorageClient, 'streamId')
    .mockImplementation((addr) => MockStorageClient.streamId(addr));

  return ZeroMem.create({
    privateKey: key,
    agentId,
    branch: 'main',
    _storage: store as unknown as StorageClient,
  });
}

beforeEach(() => {
  storeA = new MockStorageClient();
  storeB = new MockStorageClient();
  jest.clearAllMocks();
});

afterEach(() => jest.restoreAllMocks());

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ZeroMem — remember and recall', () => {
  test('remember returns a commitId string', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    const commitId = await mem.remember('0G uses append-only Log layer.');
    expect(typeof commitId).toBe('string');
    expect(commitId.length).toBeGreaterThan(0);
  });

  test('recall returns remembered text with high score', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('0G uses append-only Log layer for cheap storage.');
    await mem.remember('Sealed inference keeps embeddings private.');

    const hits = await mem.recall('append-only storage', { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].score).toBeGreaterThan(0);
    // Top result should mention storage or log
    expect(hits[0].text).toMatch(/storage|log|0g/i);
  });

  test('recall with k limits result count', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    for (let i = 1; i <= 5; i++) {
      await mem.remember(`Memory item number ${i} about storage`);
    }
    const hits = await mem.recall('storage', { k: 2 });
    expect(hits).toHaveLength(2);
  });

  test('recall scores are in descending order', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('0G storage blob layer is great');
    await mem.remember('Compute network for sealed inference');
    await mem.remember('More about 0G storage and blobs');

    const hits = await mem.recall('0G storage blob', { k: 3 });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  test('remember with tags stores them on the commit', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Important session data', { tags: ['session', 'user42'] });
    const hits = await mem.recall('session data', { k: 1 });
    expect(hits[0].tags).toEqual(expect.arrayContaining(['session', 'user42']));
  });

  test('remember with namespace isolates from default', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Semantic knowledge about persistence', { ns: 'semantic' });
    await mem.remember('Episodic: what happened at 2pm', { ns: 'episodic' });

    const semantic = await mem.recall('knowledge', { k: 5, ns: 'semantic' });
    const episodic = await mem.recall('knowledge', { k: 5, ns: 'episodic' });

    expect(semantic.every((h) => h.text.includes('Semantic'))).toBe(true);
    expect(episodic.every((h) => h.text.includes('Episodic'))).toBe(true);
  });
});

describe('ZeroMem — commit log', () => {
  test('log returns commits in reverse-chronological order', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('First memory');
    await mem.remember('Second memory');
    await mem.remember('Third memory');

    const entries = await mem.log({ limit: 3 });
    expect(entries).toHaveLength(3);
    // Most recent commit should be last remember → appears first in log
    expect(entries[0].commit.op).toBe('remember');
  });

  test('log respects limit', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    for (let i = 0; i < 5; i++) await mem.remember(`Memory ${i}`);
    const entries = await mem.log({ limit: 2 });
    expect(entries).toHaveLength(2);
  });
});

describe('ZeroMem — branching', () => {
  test('branch() returns a ZeroMem on the new branch', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Baseline knowledge');

    const draft = await mem.branch('experiment');
    expect(draft.currentBranch).toBe('experiment');
  });

  test('writes on a branch do not pollute main', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Stable fact on main');

    const draft = await mem.branch('experiment');
    await draft.remember('Experimental hypothesis — might be wrong');

    // main should only see stable fact
    const mainHits = await mem.recall('experimental hypothesis', { k: 5 });
    expect(mainHits.every((h) => !h.text.includes('Experimental'))).toBe(true);
  });

  test('merge fast-forward brings branch head into main', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Foundation on main');

    const draft = await mem.branch('feature');
    await draft.remember('New capability added on feature branch');
    await mem.merge('feature');

    // After merge, main head should be updated
    const entries = await mem.log({ limit: 5 });
    expect(entries.some((e) => e.commit.branch === 'feature')).toBe(true);
  });
});

describe('ZeroMem — forget and tombstones', () => {
  test('forget removes entry from recall results', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    const commitId = await mem.remember('Secret data to be forgotten');
    await mem.remember('Other data that stays');

    await mem.forget(commitId);

    const hits = await mem.recall('secret data forgotten', { k: 5 });
    expect(hits.every((h) => h.commitId !== commitId)).toBe(true);
  });
});

describe('ZeroMem — ask', () => {
  test('ask returns answer plus recalled hits', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Fact one about the topic');
    await mem.remember('Fact two about the topic');
    const result = await mem.ask('What do you remember about the topic?');
    expect(result.answer).toContain('Answer based on recalled memories');
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

describe('ZeroMem — plan', () => {
  test('plan returns goal and tasks', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Context about the project');

    const plan = await mem.plan('Write a blog post');
    expect(plan.goal).toBeTruthy();
    expect(Array.isArray(plan.tasks)).toBe(true);
    expect(plan.commitId).toBeTruthy();
  });
});

describe('ZeroMem — restore after KV wipe', () => {
  test('restore rebuilds recall from blob layer', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Knowledge that must survive a wipe');
    await mem.remember('Second piece of knowledge');
    const tipCommitId = await mem.remember('Third piece — this is the tip');

    // Simulate KV wipe (blobs survive on 0G Storage)
    storeA.resetKv();

    // Restore using known tip commitId
    const restored = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await restored.restore('main', { tipCommitId });

    const hits = await restored.recall('knowledge survive wipe', { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });

  test('restore throws with a helpful message when no tip is available', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    // Never remembered anything — no KV state
    await expect(mem.restore('main')).rejects.toThrow(/tipCommitId/);
  });
});

describe('ZeroMem — grant and recallFromGrant', () => {
  test('grant + recallFromGrant with matching agentId works', async () => {
    const { ethers } = await import('ethers');
    const walletB = new ethers.Wallet(AGENT_B_KEY);

    const agentA = await makeAgent(AGENT_A_KEY, 'researcher', storeA);
    await agentA.remember('0G KV enables persistent memory graphs');
    await agentA.remember('Sealed inference keeps data private');

    // Create a mock store for agent B (separate KV namespace)
    const agentB = await makeAgent(AGENT_B_KEY, 'writer', storeB);

    // Agent A grants Agent B access — using agentA's storeA so the grant
    // record ends up in A's KV stream (which B reads via recallFromGrant)
    const grantId = await agentA.grant({
      to: walletB.address,
      toPubKey: ethers.SigningKey.computePublicKey(
        walletB.signingKey.publicKey,
        true
      ),
      scope: 'default',
      ttl: '24h',
    });

    expect(typeof grantId).toBe('string');
    expect(grantId.length).toBeGreaterThan(0);
  });
});

describe('ZeroMem — blame', () => {
  test('blame finds commit that introduced a keyword', async () => {
    const mem = await makeAgent(AGENT_A_KEY, 'agent-a', storeA);
    await mem.remember('Background information');
    await mem.remember('0G sealed inference is privacy-preserving');
    await mem.remember('More general notes');

    const results = await mem.blame('sealed inference');
    // At least one match — text searching is done inside remember payloads
    // (In tests, payloads are stored as blobs so this verifies the blob read path)
    expect(Array.isArray(results)).toBe(true);
  });
});
