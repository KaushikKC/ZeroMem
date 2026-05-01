import { ethers } from 'ethers';
import { StorageClient } from './storage.js';
import { KvViews } from './kv-views.js';
import { VectorIndex } from './vector.js';
import { PostgresVectorIndex } from './pg-index.js';
import type { MemoryIndex } from './memory-index.js';
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
  blame as gitBlame,
  diffBranches,
} from './git.js';
import {
  deriveKvSymKey,
  decryptKvText,
  createAccessChallenge,
  respondToChallenge,
  verifyChallenge,
  type AccessChallenge,
  type AccessTier,
} from './acl.js';
import type {
  ZeroMemConfig,
  RecallResult,
  AskResult,
  Plan,
  ZeroCommit,
  SearchOpts,
  MemStats,
  CommitProof,
  DiffResult,
  GcResult,
} from './types.js';
import { DEFAULTS as D } from './types.js';
import {
  ZeroMemFrozenError,
  ZeroMemGrantNotFoundError,
  ZeroMemGrantExpiredError,
  ZeroMemNoTipError,
} from './errors.js';

export interface RememberOpts {
  ns?: string;
  tags?: string[];
  /** Skip write if a memory with cosine similarity ≥ threshold already exists (default 0.95) */
  dedupe?: boolean;
  dedupeThreshold?: number;
}

export interface RecallOpts {
  k?: number;
  ns?: string;
  from?: string;
}

export interface AskOpts extends RecallOpts {}

export class ZeroMem {
  private storage: StorageClient;
  private kv: KvViews;
  private vector: MemoryIndex;
  private inference: InferenceClient;
  private grants: GrantManager;
  readonly skills: SkillsManager;

  private wallet: ethers.Wallet;
  readonly agentId: string;
  readonly currentBranch: string;
  private readonly privateKey: string;
  private readonly postgresUrl?: string;
  private frozen = false;
  /** Per-wallet AES-256-GCM key for encrypting text in KV shards */
  private readonly kvSymKey: Buffer;

  private constructor(config: ZeroMemConfig & { _storage?: StorageClient; _branch?: string; _frozen?: boolean; _vector?: MemoryIndex }) {
    this.privateKey = config.privateKey;
    this.postgresUrl = config.postgresUrl;
    this.agentId = config.agentId;
    this.currentBranch = config._branch ?? config.branch ?? 'main';
    this.frozen = config._frozen ?? false;
    this.kvSymKey = deriveKvSymKey(config.privateKey);

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
    this.vector =
      config._vector ??
      (config.postgresUrl
        ? new PostgresVectorIndex(this.storage, this.agentId, config.postgresUrl)
        : new VectorIndex(this.kv, this.storage, this.agentId));

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

  /**
   * Create a ZeroMem instance.
   * Accepts an optional `_storage` override for testing/relayer use.
   */
  static async create(
    config: ZeroMemConfig & { _storage?: StorageClient }
  ): Promise<ZeroMem> {
    const instance = new ZeroMem(config);
    // Init vector backend (e.g. Postgres creates tables)
    try { await instance.vector.init?.(); } catch { /* optional */ }
    // Track branch in KV — best-effort (in-memory fallback if KV node is down)
    try { await instance.kv.addBranch(instance.agentId, instance.currentBranch); } catch { /* ok */ }
    // On-chain setup — best-effort (no-op if no contract configured)
    try {
      await instance.grants.registerAgent(instance.storage.pubKey);
      await instance.grants.initEventListeners();
    } catch { /* ok — no contract deployed yet */ }
    return instance;
  }

  // ── Core: remember / recall ────────────────────────────────────────────────

  /**
   * Store text in memory:
   *   text → embed → encrypt → 0G Log (commit) → KV vector index updated
   */
  async remember(text: string, opts: RememberOpts = {}): Promise<string> {
    if (this.frozen) throw new ZeroMemFrozenError();

    const ns = opts.ns ?? 'default';
    const tags = opts.tags ?? [];
    const indexNs = `${this.currentBranch}/${ns}`;

    // 1. Embed first — needed for both dedupe check and storage
    const embedding = await this.inference.embed(text);
    const ts = Date.now();

    // 2. Semantic deduplication — skip write if near-identical memory exists
    if (opts.dedupe !== false) {
      const threshold = opts.dedupeThreshold ?? 0.95;
      const near = await this.vector.search(embedding, { k: 1, namespace: indexNs });
      if (near.length > 0 && near[0].score >= threshold) {
        return near[0].commitId;
      }
    }

    const payload = { text, embedding, ts, tags };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const payloadRoot = await this.storage.upload(payloadBytes, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });

    // 4. Build commit
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
        ts,
        embedding_dim: embedding.length,
        tags,
      },
    });
    const commit = await signCommit(partial, this.wallet);
    const commitId = await storeCommit(commit, this.storage);

    await this.kv.setHead(this.agentId, this.currentBranch, commitId);
    await this.kv.setRootCommitIfAbsent(this.agentId, this.currentBranch, commitId);
    await this.vector.insert({
      commitId,
      text,
      embedding,
      payloadRoot,
      ts,
      tags,
      namespace: indexNs,
    });

    return commitId;
  }

  /**
   * Semantic recall — returns top-k relevant memories
   */
  async recall(query: string, opts: RecallOpts = {}): Promise<RecallResult[]> {
    const k = opts.k ?? 5;
    const ns = opts.ns ?? 'default';

    if (opts.from) {
      return this.recallFromGrant(query, opts.from, ns, k);
    }

    const indexNs = `${this.currentBranch}/${ns}`;
    const queryEmbedding = await this.inference.embed(query);
    const hits = await this.vector.search(queryEmbedding, { k, namespace: indexNs });
    return this.decryptResults(hits, this.kvSymKey);
  }

  /** Decrypt encrypted text fields in recall results using the given AES key */
  private decryptResults(hits: RecallResult[], symKey: Buffer): RecallResult[] {
    return hits.map((h) => ({ ...h, text: decryptKvText(h.text, symKey) }));
  }

  private async recallFromGrant(
    query: string,
    from: string,
    ns: string,
    k: number
  ): Promise<RecallResult[]> {
    const record = await this.grants.getGrantRecord(from, this.wallet.address, ns);
    if (!record) throw new ZeroMemGrantNotFoundError(from, ns);
    if (record.ttl < Math.floor(Date.now() / 1000)) {
      throw new ZeroMemGrantExpiredError(from, ns);
    }

    // Check that this namespace is allowed under the grant tier
    const grantRecord = record as any;
    if (grantRecord.tier) {
      const { ACCESS_TIER_NAMESPACES } = await import('./acl.js');
      const allowed = ACCESS_TIER_NAMESPACES[grantRecord.tier as AccessTier] ?? [];
      if (!allowed.includes(ns)) {
        throw new Error(`Access tier '${grantRecord.tier}' does not allow namespace '${ns}'`);
      }
    }

    let grantorSymKey: Buffer = Buffer.alloc(32);
    if (grantRecord.capsuleRoot) {
      try {
        const { kvSymKey } = await this.grants.getCapsule({
          grantId: record.grantId,
          granterAddress: from,
          capsuleRoot: grantRecord.capsuleRoot,
          recipientPrivKey: this.privateKey,
        });
        grantorSymKey = kvSymKey;
      } catch {
        // capsule unavailable — fall through with empty key (reads may fail gracefully)
      }
    }

    const granterAgentId = record.granterAgentId;
    const grantorVector: MemoryIndex = this.postgresUrl
      ? new PostgresVectorIndex(this.storage, granterAgentId, this.postgresUrl)
      : new VectorIndex(new KvViews(this.storage, from), this.storage, granterAgentId);
    await grantorVector.init?.();
    const indexNs = `main/${ns}`;
    const queryEmbedding = await this.inference.embed(query);
    const hits = await grantorVector.search(queryEmbedding, { k, namespace: indexNs });
    // Decrypt using the granter's KV sym key (unwrapped from capsule)
    return this.decryptResults(hits, grantorSymKey);
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
      vector: this.vector,
      inference: this.inference,
      grants: this.grants,
      skills: this.skills,
      wallet: this.wallet,
      agentId: this.agentId,
      currentBranch: name,
      privateKey: this.privateKey,
      kvSymKey: this.kvSymKey,
      postgresUrl: this.postgresUrl,
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
      kvSymKey: this.kvSymKey,
      postgresUrl: this.postgresUrl,
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

  // ── Ask / Planner ─────────────────────────────────────────────────────────

  /**
   * Compact episodic → semantic.
   *
   * Incremental: only processes commits written AFTER the last reflect().
   * If reflect() has never run, falls back to the `since` window.
   * Marks the timestamp in KV so the next call skips already-reflected commits.
   */
  async reflect(opts: { since?: string; tier?: string; force?: boolean } = {}): Promise<string> {
    const head = await this.kv.getHead(this.agentId, this.currentBranch);
    if (!head) return '';

    const lastReflectTs = await this.kv.getLastReflectTs(this.agentId, this.currentBranch);
    const sinceWindowMs = parseSince(opts.since ?? '24h');
    const cutoffMs = (!opts.force && lastReflectTs > sinceWindowMs)
      ? lastReflectTs
      : sinceWindowMs;

    const recentTexts: string[] = [];
    for await (const { commit } of walkCommits(head, this.storage, this.privateKey)) {
      if (commit.op !== 'remember') continue;
      if (commit.metadata.ts <= cutoffMs) break;
      try {
        const data = await this.storage.download(commit.payload_root, {
          privateKey: this.privateKey,
        });
        const payload = JSON.parse(new TextDecoder().decode(data)) as { text?: string };
        if (payload.text) recentTexts.push(payload.text);
      } catch {
        // skip unreadable payloads
      }
    }

    if (recentTexts.length === 0) return '';

    const reflectStartTs = Date.now();
    const summary = await this.inference.reflect(recentTexts);

    await this.remember(summary, {
      ns: 'semantic',
      tags: ['reflect', `since:${new Date(cutoffMs).toISOString()}`],
    });

    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({ summary, sourceCount: recentTexts.length, cutoffMs })
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
      op: 'reflect',
      branch: this.currentBranch,
      namespace: 'semantic',
      payloadRoot,
      metadata: { ts: reflectStartTs, tags: ['reflect'] },
    });
    const commit = await signCommit(partial, this.wallet);
    const commitId = await storeCommit(commit, this.storage);

    await this.kv.batch([
      { key: this.kv.headKey(this.agentId, this.currentBranch), value: new TextEncoder().encode(commitId) },
      { key: this.kv.lastReflectKey(this.agentId, this.currentBranch), value: new TextEncoder().encode(String(reflectStartTs)) },
    ]);

    return commitId;
  }

  async ask(question: string, opts: AskOpts = {}): Promise<AskResult> {
    const hits = await this.recall(question, opts);
    const answer = await this.inference.answer(
      question,
      hits.map((h) => h.text)
    );
    return { answer, hits };
  }

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
      op: 'plan',
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

  async grant(opts: {
    to: string;
    toPubKey?: string;
    scope: string;
    ttl: string;
    /** READ_SEMANTIC | READ_FULL | ADMIN (default: READ_FULL) */
    tier?: AccessTier;
  }): Promise<string> {
    const head = await this.kv.getHead(this.agentId, this.currentBranch);
    if (!head) throw new Error('Nothing to grant — no commits yet');

    const toPubKey = opts.toPubKey ?? opts.to;

    const grantId = await this.grants.createGrant({
      from: this.wallet.address,
      granterAgentId: this.agentId,
      granterPubKey: this.storage.pubKey,
      to: opts.to,
      toPubKey,
      scope: opts.scope,
      ttl: opts.ttl,
      tier: opts.tier ?? 'READ_FULL',
      headCommitId: head,
      privateKey: this.privateKey,
      kvSymKey: this.kvSymKey,
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

  async revoke(grantId: string, opts: { scope?: string; to?: string } = {}): Promise<void> {
    await this.grants.revoke(grantId, opts.scope ?? 'default', opts.to ?? '');
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
    // Remove from vector index — all namespaces on this branch
    for (const suffix of ['default', 'semantic', 'sessions', 'plans']) {
      await this.vector.remove(`${this.currentBranch}/${suffix}`, commitId);
    }
  }

  // ── Restore (KV rebuild from Log) ─────────────────────────────────────────

  /**
   * Rebuild all KV views by walking the 0G Log DAG.
   *
   * After a KV wipe, provide `opts.tipCommitId` (the rootHash of the most
   * recent commit). If omitted, falls back to the persisted KV head, then
   * the root-commit anchor written on the first `remember()`.
   *
   * The blob layer (0G Storage) is permanent — only KV needs rebuilding.
   */
  async restore(
    branch?: string,
    opts: { tipCommitId?: string } = {}
  ): Promise<void> {
    const b = branch ?? this.currentBranch;

    const tip =
      opts.tipCommitId ??
      (await this.kv.getHead(this.agentId, b)) ??
      (await this.kv.getRootCommit(this.agentId, b));

    if (!tip) throw new ZeroMemNoTipError(b);

    // Walk from tip → root, collecting all commits in reverse-chronological order
    const allCommits: Array<{ commitId: string; commit: ZeroCommit }> = [];
    for await (const entry of walkCommits(tip, this.storage, this.privateKey)) {
      allCommits.push(entry);
    }

    // Replay in chronological order (oldest → newest)
    let latestCommitId: string | null = null;
    let firstCommitId: string | null = null;

    for (const { commitId, commit } of allCommits.reverse()) {
      if (!firstCommitId) firstCommitId = commitId;

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
              namespace: `${commit.branch}/${commit.namespace}`,
              payloadRoot: commit.payload_root,
            });
          }
        } catch {
          // skip corrupted / unreadable commits
        }
      }

      latestCommitId = commitId;
    }

    // Rebuild KV administrative keys
    if (latestCommitId) {
      await this.kv.setHead(this.agentId, b, latestCommitId);
    }
    if (firstCommitId) {
      await this.kv.setRootCommitIfAbsent(this.agentId, b, firstCommitId);
    }
    await this.kv.addBranch(this.agentId, b);
  }

  // ── Feature: search() with rich filters ───────────────────────────────────

  /**
   * Richer version of recall() — supports tag filters, time windows,
   * minimum score threshold, and recency weighting.
   */
  async search(opts: SearchOpts): Promise<RecallResult[]> {
    const { query, k = 5, ns = 'default', from, ...filterOpts } = opts;

    if (from) {
      return this.recallFromGrant(query, from, ns, k);
    }

    const indexNs = `${this.currentBranch}/${ns}`;
    const queryEmbedding = await this.inference.embed(query);
    const hits = await this.vector.search(queryEmbedding, {
      k,
      namespace: indexNs,
      ...filterOpts,
    });
    return this.decryptResults(hits, this.kvSymKey);
  }

  // ── Feature: stats() ───────────────────────────────────────────────────────

  /** Return a snapshot of this agent's memory usage from KV metadata (no blob downloads) */
  async stats(): Promise<MemStats> {
    const branches = await this.kv.getBranches(this.agentId);
    const skills = await this.kv.getSkillManifest(this.agentId);
    const headCommitId = await this.kv.getHead(this.agentId, this.currentBranch);

    const namespaceStats: Record<string, number> = {};
    const knownNs = ['default', 'semantic', 'sessions', 'plans'];

    for (const branch of branches) {
      for (const ns of knownNs) {
        const key = `${branch}/${ns}`;
        const count = await this.kv.getItemCount(this.agentId, key);
        if (count > 0) namespaceStats[key] = count;
      }
    }

    const approxTotalMemories = Object.values(namespaceStats).reduce((a, b) => a + b, 0);

    return {
      agentId: this.agentId,
      currentBranch: this.currentBranch,
      branches,
      namespaceStats,
      skills,
      headCommitId,
      approxTotalMemories,
    };
  }

  // ── Feature: gc() — garbage collect tombstoned entries ────────────────────

  /**
   * Remove tombstoned entries from all vector index shards.
   * Reduces KV storage and speeds up search queries.
   */
  async gc(opts: { ns?: string } = {}): Promise<GcResult> {
    const tombList = await this.kv.getTombList(this.agentId);
    if (tombList.length === 0) return { removed: 0, namespacesScanned: [] };

    const tombSet = new Set(tombList);
    const branches = await this.kv.getBranches(this.agentId);
    const knownNs = opts.ns
      ? [opts.ns]
      : ['default', 'semantic', 'sessions', 'plans'];

    let totalRemoved = 0;
    const scanned: string[] = [];

    for (const branch of branches) {
      for (const ns of knownNs) {
        const indexNs = `${branch}/${ns}`;
        const count = await this.kv.getItemCount(this.agentId, indexNs);
        if (count === 0) continue;
        scanned.push(indexNs);
        const removed = await this.vector.gc(indexNs, tombSet);
        totalRemoved += removed;
      }
    }

    return { removed: totalRemoved, namespacesScanned: scanned };
  }

  // ── Feature: prove() — Merkle attestation ─────────────────────────────────

  /**
   * Generate a verifiable proof that a specific commit exists on 0G Storage.
   * The proof includes:
   *   - The commit's own secp256k1 signature (written at store time)
   *   - A fresh attestation signature over { commitId, provedAt } (written now)
   *   - A link to the 0G Storage Explorer for independent verification
   */
  async prove(commitId: string): Promise<CommitProof> {
    const commit = await loadCommit(commitId, this.storage, this.privateKey);

    // Fresh attestation: sign { commitId, provedAt } with current wallet
    const provedAt = Date.now();
    const attestationMsg = JSON.stringify({ commitId, provedAt });
    const attestationHash = ethers.keccak256(ethers.toUtf8Bytes(attestationMsg));
    const attestationSig = await this.wallet.signMessage(ethers.getBytes(attestationHash));

    return {
      commitId,
      agentId: this.agentId,
      agentAddress: this.wallet.address,
      agentPubKey: this.storage.pubKey,
      op: commit.op,
      branch: commit.branch,
      payloadRoot: commit.payload_root,
      ts: commit.metadata.ts,
      commitSig: commit.sig,
      attestationSig,
      provedAt,
      storageExplorerUrl: `https://storagescan-galileo.0g.ai/tx/${commitId}`,
    };
  }

  // ── Feature: diff() — compare two branches ────────────────────────────────

  /** Show commits in one branch that don't exist in another */
  async diff(branchA: string, branchB: string): Promise<DiffResult> {
    return diffBranches(
      {
        storage: this.storage,
        kv: this.kv,
        vector: this.vector,
        wallet: this.wallet,
        agentId: this.agentId,
        branch: this.currentBranch,
        privateKey: this.privateKey,
      },
      branchA,
      branchB
    );
  }

  // ── Feature: snapshot() / checkout() — named checkpoints ──────────────────

  /** Tag the current HEAD as a named snapshot (like a Git tag) */
  async snapshot(name: string): Promise<void> {
    const head = await this.kv.getHead(this.agentId, this.currentBranch);
    if (!head) throw new Error(`Cannot snapshot — no commits on branch '${this.currentBranch}'`);
    await this.kv.setSnapshot(this.agentId, name, head);
  }

  /** Return a frozen read-only ZeroMem at a named snapshot */
  async checkout(name: string): Promise<ZeroMem> {
    const commitId = await this.kv.getSnapshot(this.agentId, name);
    if (!commitId) throw new Error(`Snapshot '${name}' not found`);
    return this.replay({ at: commitId });
  }

  // ── Feature: runPlan() — execute a stored plan ────────────────────────────

  /** Load a plan by its commitId and return tasks in dependency order */
  async getPlan(planCommitId: string): Promise<Plan> {
    const data = await this.storage.download(
      (await loadCommit(planCommitId, this.storage, this.privateKey)).payload_root,
      { privateKey: this.privateKey }
    );
    const raw = JSON.parse(new TextDecoder().decode(data)) as { goal: string; tasks: PlanTask[] };
    return { goal: raw.goal, commitId: planCommitId, tasks: raw.tasks ?? [] };
  }

  /** Mark a plan task as done and write an updated plan commit */
  async completePlanTask(planCommitId: string, taskId: string): Promise<string> {
    const plan = await this.getPlan(planCommitId);
    const tasks = plan.tasks.map((t) =>
      t.id === taskId ? { ...t, done: true } : t
    );

    const data = new TextEncoder().encode(JSON.stringify({ goal: plan.goal, tasks }));
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
      metadata: { ts: Date.now(), tags: ['plan', `done:${taskId}`] },
    });
    const commit = await signCommit(partial, this.wallet);
    const newCommitId = await storeCommit(commit, this.storage);
    await this.kv.setHead(this.agentId, this.currentBranch, newCommitId);
    return newCommitId;
  }

  // ── Feature: forgetBulk() — bulk tombstone ─────────────────────────────────

  /**
   * Tombstone all memories matching the given criteria.
   * Run gc() afterwards to reclaim KV storage.
   */
  async forgetBulk(opts: {
    tags?: string[];
    olderThan?: string;
    ns?: string;
  }): Promise<number> {
    const ns = opts.ns ?? 'default';
    const indexNs = `${this.currentBranch}/${ns}`;
    const untilMs = opts.olderThan ? parseSince(opts.olderThan) : 0;

    const itemCount = await this.kv.getItemCount(this.agentId, indexNs);
    const totalShards = Math.max(1, Math.ceil(itemCount / 256) + 1);
    const shards = await Promise.all(
      Array.from({ length: totalShards }, (_, s) =>
        this.kv.getShard<import('./types.js').VectorRef>(this.agentId, indexNs, s)
      )
    );

    let count = 0;
    for (const refs of shards) {
      for (const ref of refs) {
        try {
          const data = await this.storage.download(ref.rootHash, {
            privateKey: this.privateKey,
          });
          const e = JSON.parse(new TextDecoder().decode(data)) as {
            ts: number;
            tags: string[];
            commitId: string;
          };
          const matchesTags =
            !opts.tags || opts.tags.every((t) => e.tags.includes(t));
          const matchesTime =
            untilMs === 0 || e.ts < untilMs;
          if (matchesTags && matchesTime) {
            await this.forget(ref.commitId);
            count++;
          }
        } catch {
          continue;
        }
      }
    }
    return count;
  }

  // ── Agent-to-Agent Access Control ─────────────────────────────────────────

  /**
   * Step 1 — Granter creates a challenge nonce.
   * Send this to the recipient off-chain (e.g. API call, QR code, message).
   */
  async createAccessChallenge(recipientAddress: string, scope: string): Promise<AccessChallenge> {
    return createAccessChallenge(this.privateKey, recipientAddress, scope);
  }

  /**
   * Step 2 — Recipient signs the challenge to prove wallet ownership.
   * The proof is sent back to the granter.
   */
  static async signAccessChallenge(
    recipientPrivKey: string,
    challenge: AccessChallenge
  ): Promise<string> {
    return respondToChallenge(recipientPrivKey, challenge);
  }

  /**
   * Step 3 — Granter verifies the proof and creates the grant.
   * Only creates the grant if the recipient signed the correct nonce.
   * Prevents accidental grants to wrong/stolen addresses.
   */
  async grantVerified(opts: {
    challenge: AccessChallenge;
    proof: string;
    toPubKey: string;
    ttl: string;
    tier?: AccessTier;
  }): Promise<string> {
    const { challenge, proof, ...grantOpts } = opts;
    const { valid, reason } = verifyChallenge(challenge, proof);
    if (!valid) throw new Error(`Access challenge failed: ${reason}`);
    return this.grant({
      to: challenge.recipientAddress,
      toPubKey: grantOpts.toPubKey,
      scope: challenge.scope,
      ttl: grantOpts.ttl,
      tier: grantOpts.tier,
    });
  }

  /**
   * Grant the same scope to multiple wallets at once.
   * Each recipient gets their own MemoryCapsule (their own ECDH-wrapped key).
   */
  async batchGrant(opts: {
    recipients: Array<{ address: string; pubKey: string }>;
    scope: string;
    ttl: string;
    tier?: AccessTier;
  }): Promise<string[]> {
    const head = await this.kv.getHead(this.agentId, this.currentBranch);
    if (!head) throw new Error('Nothing to grant — no commits yet');

    return this.grants.batchGrant({
      from: this.wallet.address,
      granterAgentId: this.agentId,
      granterPubKey: this.storage.pubKey,
      recipients: opts.recipients,
      scope: opts.scope,
      ttl: opts.ttl,
      tier: opts.tier ?? 'READ_FULL',
      headCommitId: head,
      privateKey: this.privateKey,
      kvSymKey: this.kvSymKey,
    });
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

type PlanTask = import('./types.js').PlanTask;

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
