import { ethers } from 'ethers';
import { StorageClient } from './storage.js';
import { KvViews } from './kv-views.js';
import { VectorIndex } from './vector.js';
import { InferenceClient } from './inference.js';
import { GrantManager } from './grant.js';
import { SkillsManager } from './skills.js';
import {
  buildCommit,
  signCommit,
  storeCommit,
  loadCommit,
  walkCommits,
} from './commit.js';
import {
  forkBranch,
  mergeBranch,
  log as gitLog,
  replay as gitReplay,
  blame as gitBlame,
} from './git.js';
import type {
  ZeroMemConfig,
  RecallResult,
  Plan,
  ZeroCommit,
  DEFAULTS,
} from './types.js';
import { DEFAULTS as D } from './types.js';

export interface RememberOpts {
  ns?: string;
  tags?: string[];
}

export interface RecallOpts {
  k?: number;
  ns?: string;
  from?: string;
}

export class ZeroMem {
  private storage: StorageClient;
  private kv: KvViews;
  private vector: VectorIndex;
  private inference: InferenceClient;
  private grants: GrantManager;
  readonly skills: SkillsManager;

  private wallet: ethers.Wallet;
  readonly agentId: string;
  readonly currentBranch: string;
  private readonly privateKey: string;
  private frozen = false;

  private constructor(config: ZeroMemConfig & { _storage?: StorageClient; _branch?: string; _frozen?: boolean }) {
    this.privateKey = config.privateKey;
    this.agentId = config.agentId;
    this.currentBranch = config._branch ?? config.branch ?? 'main';
    this.frozen = config._frozen ?? false;

    this.storage =
      config._storage ??
      new StorageClient(config.privateKey, {
        rpcUrl: config.rpcUrl,
        indexerUrl: config.indexerUrl,
        kvUrl: config.kvUrl,
      });

    const provider = new ethers.JsonRpcProvider(config.rpcUrl ?? D.RPC_URL);
    this.wallet = new ethers.Wallet(config.privateKey, provider);

    this.kv = new KvViews(this.storage, this.wallet.address);
    this.vector = new VectorIndex(this.kv, this.agentId);

    this.inference = new InferenceClient({
      privateKey: config.privateKey,
      rpcUrl: config.rpcUrl,
      providerAddress: config.computeProviderAddress,
      endpoint: config.computeEndpoint,
    });

    this.grants = new GrantManager(
      this.storage,
      this.kv,
      this.wallet,
      config.grantRegistryAddress,
      config.rpcUrl
    );

    this.skills = new SkillsManager(
      this.storage,
      this.kv,
      this.agentId,
      config.privateKey
    );
  }

  /** Create a ZeroMem instance, registering the agent if a contract is configured */
  static async create(config: ZeroMemConfig): Promise<ZeroMem> {
    const instance = new ZeroMem(config);
    await instance.kv.addBranch(instance.agentId, instance.currentBranch);
    // Best-effort agent registration on-chain
    try {
      await instance.grants.registerAgent(instance.storage.pubKey);
    } catch {
      // ok — no contract deployed yet
    }
    return instance;
  }

  // ── Core: remember / recall ────────────────────────────────────────────────

  /**
   * Store text in memory:
   *   text → embed → encrypt → 0G Log (commit) → KV vector index updated
   */
  async remember(text: string, opts: RememberOpts = {}): Promise<string> {
    if (this.frozen) throw new Error('Cannot write to a frozen replay snapshot');

    const ns = opts.ns ?? 'default';
    const tags = opts.tags ?? [];

    // 1. Generate embedding
    const embedding = await this.inference.embed(text);

    // 2. Build and encrypt payload
    const payload = { text, embedding, ts: Date.now(), tags };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const payloadRoot = await this.storage.upload(payloadBytes, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });

    // 3. Build commit
    const parent = await this.kv.getHead(this.agentId, this.currentBranch);
    const partial = buildCommit({
      parent,
      agentId: this.agentId,
      authorPubkey: this.storage.pubKey,
      op: 'remember',
      branch: this.currentBranch,
      namespace: ns,
      payloadRoot,
      metadata: {
        ts: Date.now(),
        embedding_dim: embedding.length,
        tags,
      },
    });
    const commit = await signCommit(partial, this.wallet);

    // 4. Store commit on 0G (encrypted to self)
    const commitId = await storeCommit(commit, this.storage);

    // 5. Update KV: head pointer + vector index
    await this.kv.setHead(this.agentId, this.currentBranch, commitId);
    await this.vector.insert({
      commitId,
      text,
      embedding,
      ts: Date.now(),
      tags,
      namespace: ns,
    });

    return commitId;
  }

  /**
   * Semantic recall — returns top-k relevant memories
   */
  async recall(query: string, opts: RecallOpts = {}): Promise<RecallResult[]> {
    const k = opts.k ?? 5;
    const ns = opts.ns ?? 'default';

    // If recalling from a grant, resolve via the granter's KV namespace
    if (opts.from) {
      return this.recallFromGrant(query, opts.from, ns, k);
    }

    const queryEmbedding = await this.inference.embed(query);
    return this.vector.search(queryEmbedding, { k, namespace: ns });
  }

  private async recallFromGrant(
    query: string,
    from: string,
    ns: string,
    k: number
  ): Promise<RecallResult[]> {
    const granted = await this.grants.isGranted(from, this.wallet.address, ns);
    if (!granted) throw new Error(`No valid grant from ${from} for scope ${ns}`);

    const grantRecord = await this.kv.getGrant(from, this.wallet.address, ns);
    if (!grantRecord) throw new Error('Grant record not found in KV');

    // Use a temporary vector index pointed at the granter's namespace
    const grantorKv = new KvViews(this.storage, from);
    const grantorVector = new VectorIndex(grantorKv, from);
    const queryEmbedding = await this.inference.embed(query);
    return grantorVector.search(queryEmbedding, { k, namespace: ns });
  }

  // ── Git operations ─────────────────────────────────────────────────────────

  /** Create a new branch forked from current HEAD — returns new ZeroMem on that branch */
  async branch(name: string): Promise<ZeroMem> {
    await forkBranch(
      {
        storage: this.storage,
        kv: this.kv,
        vector: this.vector,
        wallet: this.wallet,
        agentId: this.agentId,
        branch: this.currentBranch,
        privateKey: this.privateKey,
      },
      name
    );

    // Return new ZeroMem instance on the new branch
    const child = Object.create(ZeroMem.prototype) as ZeroMem;
    Object.assign(child, {
      storage: this.storage,
      kv: this.kv,
      vector: new VectorIndex(this.kv, this.agentId),
      inference: this.inference,
      grants: this.grants,
      skills: this.skills,
      wallet: this.wallet,
      agentId: this.agentId,
      currentBranch: name,
      privateKey: this.privateKey,
      frozen: false,
    });
    return child;
  }

  /** Merge a named branch into the current branch */
  async merge(
    branchName: string,
    opts: { strategy?: 'reflect' | 'fast-forward' } = {}
  ): Promise<void> {
    await mergeBranch(
      {
        storage: this.storage,
        kv: this.kv,
        vector: this.vector,
        wallet: this.wallet,
        agentId: this.agentId,
        branch: this.currentBranch,
        privateKey: this.privateKey,
      },
      branchName,
      opts.strategy ?? 'fast-forward'
    );
  }

  /** Time-travel to a specific commit — returns frozen read-only ZeroMem */
  async replay(opts: { at: string }): Promise<ZeroMem> {
    const snapshot = Object.create(ZeroMem.prototype) as ZeroMem;
    Object.assign(snapshot, {
      storage: this.storage,
      kv: this.kv,
      vector: this.vector,
      inference: this.inference,
      grants: this.grants,
      skills: this.skills,
      wallet: this.wallet,
      agentId: this.agentId,
      currentBranch: `replay/${opts.at.slice(0, 8)}`,
      privateKey: this.privateKey,
      frozen: true,
    });
    return snapshot;
  }

  /** Show commit history */
  async log(opts: { limit?: number; branch?: string } = {}): Promise<
    Array<{ commitId: string; commit: ZeroCommit }>
  > {
    return gitLog(
      {
        storage: this.storage,
        kv: this.kv,
        vector: this.vector,
        wallet: this.wallet,
        agentId: this.agentId,
        branch: this.currentBranch,
        privateKey: this.privateKey,
      },
      opts
    );
  }

  /** Find which commit introduced knowledge about a keyword */
  async blame(keyword: string): Promise<Array<{ commitId: string; ts: number; op: string }>> {
    return gitBlame(
      {
        storage: this.storage,
        kv: this.kv,
        vector: this.vector,
        wallet: this.wallet,
        agentId: this.agentId,
        branch: this.currentBranch,
        privateKey: this.privateKey,
      },
      keyword
    );
  }

  // ── Reflector ──────────────────────────────────────────────────────────────

  /**
   * Compact episodic → semantic: reads recent commits, runs sealed-inference
   * reflection, writes a 'reflect' commit with the semantic summary.
   */
  async reflect(opts: { since?: string; tier?: string } = {}): Promise<string> {
    const sinceMs = parseSince(opts.since ?? '24h');
    const ns = 'default';

    const head = await this.kv.getHead(this.agentId, this.currentBranch);
    if (!head) return '';

    const recentTexts: string[] = [];
    for await (const { commit } of walkCommits(
      head,
      this.storage,
      this.privateKey
    )) {
      if (commit.op !== 'remember') continue;
      if (commit.metadata.ts < sinceMs) break;
      try {
        const data = await this.storage.download(commit.payload_root, {
          privateKey: this.privateKey,
        });
        const payload = JSON.parse(new TextDecoder().decode(data)) as { text?: string };
        if (payload.text) recentTexts.push(payload.text);
      } catch {
        // skip
      }
    }

    if (recentTexts.length === 0) return '';

    const summary = await this.inference.reflect(recentTexts);
    const summaryCommitId = await this.remember(summary, {
      ns: 'semantic',
      tags: ['reflect', `since:${opts.since ?? '24h'}`],
    });

    // Store reflect commit
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ summary, sourceCount: recentTexts.length }));
    const payloadRoot = await this.storage.upload(payloadBytes, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });
    const parent = await this.kv.getHead(this.agentId, this.currentBranch);
    const partial = buildCommit({
      parent,
      agentId: this.agentId,
      authorPubkey: this.storage.pubKey,
      op: 'reflect',
      branch: this.currentBranch,
      namespace: 'semantic',
      payloadRoot,
      metadata: { ts: Date.now(), tags: ['reflect'] },
    });
    const commit = await signCommit(partial, this.wallet);
    const commitId = await storeCommit(commit, this.storage);
    await this.kv.setHead(this.agentId, this.currentBranch, commitId);

    return commitId;
  }

  // ── Planner ────────────────────────────────────────────────────────────────

  async plan(goal: string): Promise<Plan> {
    const context = await this.recall(goal, { k: 5 });
    const contextStr = context.map((r) => r.text).join('\n');

    const raw = await this.inference.plan(goal, contextStr) as any;
    const tasks = (raw.tasks ?? []).map((t: any) => ({
      id: t.id ?? crypto.randomUUID(),
      description: t.description ?? '',
      dependsOn: t.dependsOn ?? [],
      done: false,
    }));

    const planPayload = { goal, tasks };
    const data = new TextEncoder().encode(JSON.stringify(planPayload));
    const payloadRoot = await this.storage.upload(data, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });

    const parent = await this.kv.getHead(this.agentId, this.currentBranch);
    const partial = buildCommit({
      parent,
      agentId: this.agentId,
      authorPubkey: this.storage.pubKey,
      op: 'reflect',
      branch: this.currentBranch,
      namespace: 'plans',
      payloadRoot,
      metadata: { ts: Date.now(), tags: ['plan'] },
    });
    const commit = await signCommit(partial, this.wallet);
    const commitId = await storeCommit(commit, this.storage);
    await this.kv.setHead(this.agentId, this.currentBranch, commitId);

    return { goal, commitId, tasks };
  }

  // ── Grant / revoke ─────────────────────────────────────────────────────────

  async grant(opts: { to: string; toPubKey?: string; scope: string; ttl: string }): Promise<string> {
    const head = await this.kv.getHead(this.agentId, this.currentBranch);
    if (!head) throw new Error('Nothing to grant — no commits yet');

    const toPubKey = opts.toPubKey ?? opts.to; // fallback to address

    const grantId = await this.grants.createGrant({
      from: this.wallet.address,
      to: opts.to,
      toPubKey,
      scope: opts.scope,
      ttl: opts.ttl,
      headCommitId: head,
      privateKey: this.privateKey,
    });

    // Write 'grant' commit
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({ grantId, to: opts.to, scope: opts.scope, ttl: opts.ttl })
    );
    const payloadRoot = await this.storage.upload(payloadBytes, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });
    const parent = await this.kv.getHead(this.agentId, this.currentBranch);
    const partial = buildCommit({
      parent,
      agentId: this.agentId,
      authorPubkey: this.storage.pubKey,
      op: 'grant',
      branch: this.currentBranch,
      namespace: opts.scope,
      payloadRoot,
      metadata: { ts: Date.now(), tags: ['grant', `to:${opts.to}`] },
    });
    const commit = await signCommit(partial, this.wallet);
    const commitId = await storeCommit(commit, this.storage);
    await this.kv.setHead(this.agentId, this.currentBranch, commitId);

    return grantId;
  }

  async revoke(grantId: string): Promise<void> {
    await this.grants.revoke(grantId);
  }

  // ── Forget ─────────────────────────────────────────────────────────────────

  async forget(commitId: string): Promise<void> {
    await this.kv.setTomb(this.agentId, commitId);
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ commitId }));
    const payloadRoot = await this.storage.upload(payloadBytes, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });
    const parent = await this.kv.getHead(this.agentId, this.currentBranch);
    const partial = buildCommit({
      parent,
      agentId: this.agentId,
      authorPubkey: this.storage.pubKey,
      op: 'forget',
      branch: this.currentBranch,
      namespace: 'default',
      payloadRoot,
      metadata: { ts: Date.now(), tags: ['forget', commitId] },
    });
    const commit = await signCommit(partial, this.wallet);
    const forgotCommitId = await storeCommit(commit, this.storage);
    await this.kv.setHead(this.agentId, this.currentBranch, forgotCommitId);
    // Remove from vector index
    await this.vector.remove('default', commitId);
  }

  // ── Restore (KV rebuild from Log) ─────────────────────────────────────────

  async restore(branch?: string): Promise<void> {
    const b = branch ?? this.currentBranch;
    const head = await this.kv.getHead(this.agentId, b);
    if (!head) throw new Error(`No head for branch '${b}'`);

    let newHead: string | null = null;
    const allCommits: Array<{ commitId: string; commit: ZeroCommit }> = [];

    for await (const entry of walkCommits(head, this.storage, this.privateKey)) {
      allCommits.push(entry);
    }

    // Replay commits in chronological order to rebuild KV
    for (const { commitId, commit } of allCommits.reverse()) {
      if (commit.op === 'remember') {
        try {
          const data = await this.storage.download(commit.payload_root, {
            privateKey: this.privateKey,
          });
          const payload = JSON.parse(new TextDecoder().decode(data)) as {
            text?: string;
            embedding?: number[];
            tags?: string[];
          };
          if (payload.text && payload.embedding) {
            await this.vector.insert({
              commitId,
              text: payload.text,
              embedding: payload.embedding,
              ts: commit.metadata.ts,
              tags: payload.tags ?? [],
              namespace: commit.namespace,
            });
          }
        } catch {
          // skip corrupted commits
        }
      }
      newHead = commitId;
    }

    if (newHead) {
      await this.kv.setHead(this.agentId, b, newHead);
    }
  }

  // ── Escape hatch ───────────────────────────────────────────────────────────

  get raw() {
    return {
      upload: (data: Uint8Array, opts?: Parameters<StorageClient['upload']>[1]) =>
        this.storage.upload(data, opts),
      download: (rootHash: string, opts?: Parameters<StorageClient['download']>[1]) =>
        this.storage.download(rootHash, opts),
      commit: (text: string, opts?: RememberOpts) => this.remember(text, opts),
      storage: this.storage,
      kv: this.kv,
    };
  }
}

function parseSince(since: string): number {
  const now = Date.now();
  const m = since.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return now - 24 * 3600 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms =
    unit === 's' ? n * 1000 :
    unit === 'm' ? n * 60 * 1000 :
    unit === 'h' ? n * 3600 * 1000 :
    n * 86400 * 1000;
  return now - ms;
}
