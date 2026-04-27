import type { StorageClient } from './storage.js';
import { KvViews } from './kv-views.js';
import type { Skill } from './types.js';
import { ethers } from 'ethers';

export class SkillsManager {
  constructor(
    private storage: StorageClient,
    private kv: KvViews,
    private agentId: string,
    private privateKey: string
  ) {}

  /** Add or update a skill — signs the skill blob, stores on 0G, updates manifest */
  async add(skill: Omit<Skill, 'version' | 'createdAt'>): Promise<string> {
    const existing = await this.getSkillRecord(skill.name);
    const version = existing ? existing.version + 1 : 1;

    const record: Skill = { ...skill, version, createdAt: Date.now() };
    const data = new TextEncoder().encode(JSON.stringify(record));

    const hash = ethers.keccak256(data);
    const wallet = new ethers.Wallet(this.privateKey);
    const sig = await wallet.signMessage(ethers.getBytes(hash));

    const signedData = new TextEncoder().encode(JSON.stringify({ ...record, sig }));
    const blobRoot = await this.storage.upload(signedData, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });

    await this.kv.setSkill(this.agentId, skill.name, blobRoot);

    // Keep manifest in KV so list() never needs a 0G download
    const manifest = await this.kv.getSkillManifest(this.agentId);
    if (!manifest.includes(skill.name)) {
      await this.kv.setSkillManifest(this.agentId, [...manifest, skill.name]);
    }

    return blobRoot;
  }

  /** Load a skill from KV → 0G blob */
  async load(name: string): Promise<Skill & { sig: string }> {
    const blobRoot = await this.kv.getSkill(this.agentId, name);
    if (!blobRoot) throw new Error(`Skill '${name}' not found`);
    const data = await this.storage.download(blobRoot, { privateKey: this.privateKey });
    return JSON.parse(new TextDecoder().decode(data)) as Skill & { sig: string };
  }

  /** List all skill names for this agent (or a granted agent) */
  async list(opts: { from?: string } = {}): Promise<string[]> {
    if (opts.from) {
      // Read the granter's manifest from their KV stream
      const grantorKv = new KvViews(this.storage, opts.from);
      return grantorKv.getSkillManifest(opts.from);
    }
    return this.kv.getSkillManifest(this.agentId);
  }

  /** Run a skill with given input (sandboxed eval — use WASM worker in production) */
  async run(name: string, input: unknown): Promise<unknown> {
    const skill = await this.load(name);
    const fn = new Function('input', skill.code);
    return fn(input);
  }

  private async getSkillRecord(name: string): Promise<Skill | null> {
    try {
      return await this.load(name);
    } catch {
      return null;
    }
  }
}
