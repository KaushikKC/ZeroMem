import { StorageClient } from './storage.js';

/** Namespaced KV keys for an agent */
export class KvViews {
  private streamId: string;

  constructor(private storage: StorageClient, agentAddress: string) {
    this.streamId = StorageClient.streamId(agentAddress);
  }

  // ── HEAD pointers ──────────────────────────────────────────────────────────

  headKey(agentId: string, branch: string): string {
    return `head/${agentId}/${branch}`;
  }

  async getHead(agentId: string, branch: string): Promise<string | null> {
    const val = await this.storage.kvGet(this.streamId, this.headKey(agentId, branch));
    if (!val) return null;
    return new TextDecoder().decode(val);
  }

  async setHead(agentId: string, branch: string, commitId: string): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.headKey(agentId, branch),
        value: new TextEncoder().encode(commitId),
      },
    ]);
  }

  // ── Vector index shards ────────────────────────────────────────────────────

  shardKey(agentId: string, ns: string, shard: number): string {
    return `idx/${agentId}/${ns}/v/${shard}`;
  }

  itemCountKey(agentId: string, ns: string): string {
    return `idx/${agentId}/${ns}/count`;
  }

  /** Returns total inserted item count (used to derive shard index) */
  async getItemCount(agentId: string, ns: string): Promise<number> {
    const val = await this.storage.kvGet(this.streamId, this.itemCountKey(agentId, ns));
    if (!val) return 0;
    return parseInt(new TextDecoder().decode(val), 10);
  }

  /** Atomically increments the per-namespace item counter */
  async incrementItemCount(agentId: string, ns: string): Promise<void> {
    const current = await this.getItemCount(agentId, ns);
    await this.storage.kvSet(this.streamId, [
      {
        key: this.itemCountKey(agentId, ns),
        value: new TextEncoder().encode(String(current + 1)),
      },
    ]);
  }

  async getShard<T>(agentId: string, ns: string, shard: number): Promise<T[]> {
    const val = await this.storage.kvGet(
      this.streamId,
      this.shardKey(agentId, ns, shard)
    );
    if (!val) return [];
    return JSON.parse(new TextDecoder().decode(val)) as T[];
  }

  async appendToShard<T>(
    agentId: string,
    ns: string,
    shard: number,
    entries: T[],
    maxPerShard = 256
  ): Promise<void> {
    const existing = await this.getShard<T>(agentId, ns, shard);
    const updated = [...existing, ...entries].slice(-maxPerShard);
    await this.storage.kvSet(this.streamId, [
      {
        key: this.shardKey(agentId, ns, shard),
        value: new TextEncoder().encode(JSON.stringify(updated)),
      },
    ]);
  }

  async writeAll(
    agentId: string,
    ns: string,
    shard: number,
    entries: unknown[]
  ): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.shardKey(agentId, ns, shard),
        value: new TextEncoder().encode(JSON.stringify(entries)),
      },
    ]);
  }

  // ── Grant views ────────────────────────────────────────────────────────────

  grantKey(from: string, to: string, scope: string): string {
    return `grant/${from}/${to}/${scope}`;
  }

  async setGrant(
    from: string,
    to: string,
    scope: string,
    grantId: string,
    ttl: number,
    granterAgentId: string
  ): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.grantKey(from, to, scope),
        value: new TextEncoder().encode(
          JSON.stringify({ grantId, ttl, granterAgentId })
        ),
      },
    ]);
  }

  async getGrant(
    from: string,
    to: string,
    scope: string
  ): Promise<{ grantId: string; ttl: number; granterAgentId: string } | null> {
    const val = await this.storage.kvGet(
      this.streamId,
      this.grantKey(from, to, scope)
    );
    if (!val) return null;
    const parsed = JSON.parse(new TextDecoder().decode(val));
    if (parsed === null) return null;
    return parsed;
  }

  async removeGrant(from: string, to: string, scope: string): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.grantKey(from, to, scope),
        value: new TextEncoder().encode('null'),
      },
    ]);
  }

  // ── Grant reverse-index (grantId → {from,to,scope}) ───────────────────────

  grantIndexKey(grantId: string): string {
    return `grantidx/${grantId}`;
  }

  async setGrantIndex(
    grantId: string,
    meta: { from: string; to: string; scope: string }
  ): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.grantIndexKey(grantId),
        value: new TextEncoder().encode(JSON.stringify(meta)),
      },
    ]);
  }

  async getGrantIndex(
    grantId: string
  ): Promise<{ from: string; to: string; scope: string } | null> {
    const val = await this.storage.kvGet(
      this.streamId,
      this.grantIndexKey(grantId)
    );
    if (!val) return null;
    return JSON.parse(new TextDecoder().decode(val));
  }

  // ── Skill blobs ────────────────────────────────────────────────────────────

  skillKey(agentId: string, name: string): string {
    return `skill/${agentId}/${name}`;
  }

  skillManifestKey(agentId: string): string {
    return `skill/${agentId}/__manifest__`;
  }

  async setSkill(agentId: string, name: string, blobRoot: string): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.skillKey(agentId, name),
        value: new TextEncoder().encode(blobRoot),
      },
    ]);
  }

  async getSkill(agentId: string, name: string): Promise<string | null> {
    const val = await this.storage.kvGet(this.streamId, this.skillKey(agentId, name));
    if (!val) return null;
    return new TextDecoder().decode(val);
  }

  async getSkillManifest(agentId: string): Promise<string[]> {
    const val = await this.storage.kvGet(
      this.streamId,
      this.skillManifestKey(agentId)
    );
    if (!val) return [];
    return JSON.parse(new TextDecoder().decode(val)) as string[];
  }

  async setSkillManifest(agentId: string, names: string[]): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.skillManifestKey(agentId),
        value: new TextEncoder().encode(JSON.stringify(names)),
      },
    ]);
  }

  // ── Tombstones (forget) ────────────────────────────────────────────────────

  tombKey(agentId: string, commitId: string): string {
    return `tomb/${agentId}/${commitId}`;
  }

  async setTomb(agentId: string, commitId: string): Promise<void> {
    await this.storage.kvSet(this.streamId, [
      {
        key: this.tombKey(agentId, commitId),
        value: new TextEncoder().encode('1'),
      },
    ]);
  }

  async isTombed(agentId: string, commitId: string): Promise<boolean> {
    const val = await this.storage.kvGet(this.streamId, this.tombKey(agentId, commitId));
    return val !== null && new TextDecoder().decode(val) === '1';
  }

  // ── Branch list ────────────────────────────────────────────────────────────

  branchListKey(agentId: string): string {
    return `branches/${agentId}`;
  }

  async getBranches(agentId: string): Promise<string[]> {
    const val = await this.storage.kvGet(this.streamId, this.branchListKey(agentId));
    if (!val) return [];
    return JSON.parse(new TextDecoder().decode(val)) as string[];
  }

  async addBranch(agentId: string, branch: string): Promise<void> {
    const existing = await this.getBranches(agentId);
    if (!existing.includes(branch)) {
      await this.storage.kvSet(this.streamId, [
        {
          key: this.branchListKey(agentId),
          value: new TextEncoder().encode(JSON.stringify([...existing, branch])),
        },
      ]);
    }
  }

  // ── Root commit (survives KV wipe) ─────────────────────────────────────────

  rootCommitKey(agentId: string, branch: string): string {
    return `root/${agentId}/${branch}`;
  }

  /** Written once on first commit — used by restore() after a KV wipe */
  async setRootCommitIfAbsent(
    agentId: string,
    branch: string,
    commitId: string
  ): Promise<void> {
    const existing = await this.storage.kvGet(
      this.streamId,
      this.rootCommitKey(agentId, branch)
    );
    if (existing) return; // never overwrite
    await this.storage.kvSet(this.streamId, [
      {
        key: this.rootCommitKey(agentId, branch),
        value: new TextEncoder().encode(commitId),
      },
    ]);
  }

  async getRootCommit(agentId: string, branch: string): Promise<string | null> {
    const val = await this.storage.kvGet(
      this.streamId,
      this.rootCommitKey(agentId, branch)
    );
    if (!val) return null;
    return new TextDecoder().decode(val);
  }
}
