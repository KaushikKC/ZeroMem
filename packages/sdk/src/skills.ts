import type { StorageClient } from './storage.js';
import type { KvViews } from './kv-views.js';
import type { Skill } from './types.js';
import { ethers } from 'ethers';

export class SkillsManager {
  constructor(
    private storage: StorageClient,
    private kv: KvViews,
    private agentId: string,
    private privateKey: string
  ) {}

  /** Add or update a skill — signs the skill blob and stores on 0G */
  async add(skill: Omit<Skill, 'version' | 'createdAt'>): Promise<string> {
    const existing = await this.getSkillRecord(skill.name);
    const version = existing ? existing.version + 1 : 1;

    const record: Skill = {
      ...skill,
      version,
      createdAt: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(record));

    // Sign the skill blob
    const hash = ethers.keccak256(data);
    const wallet = new ethers.Wallet(this.privateKey);
    const sig = await wallet.signMessage(ethers.getBytes(hash));

    const signed = { ...record, sig };
    const signedData = new TextEncoder().encode(JSON.stringify(signed));

    const blobRoot = await this.storage.upload(signedData, {
      encrypt: true,
      recipientPubKey: this.storage.pubKey,
    });

    await this.kv.setSkill(this.agentId, skill.name, blobRoot);
    return blobRoot;
  }

  /** Load a skill from KV + 0G Storage */
  async load(name: string): Promise<Skill & { sig: string }> {
    const blobRoot = await this.kv.getSkill(this.agentId, name);
    if (!blobRoot) throw new Error(`Skill '${name}' not found`);

    const data = await this.storage.download(blobRoot, {
      privateKey: this.privateKey,
    });
    return JSON.parse(new TextDecoder().decode(data)) as Skill & { sig: string };
  }

  /** List all skills for this agent */
  async list(opts: { from?: string } = {}): Promise<string[]> {
    const agentId = opts.from ?? this.agentId;
    // KV doesn't support prefix scan — return known skills from a manifest
    const manifestRoot = await this.kv.getSkill(agentId, '__manifest__');
    if (!manifestRoot) return [];
    const data = await this.storage.download(manifestRoot, {
      privateKey: this.privateKey,
    });
    return JSON.parse(new TextDecoder().decode(data)) as string[];
  }

  /** Run a loaded skill with given input */
  async run(name: string, input: unknown): Promise<unknown> {
    const skill = await this.load(name);

    // Execute skill code in a sandboxed eval context
    // In production this would use a WASM sandbox or worker
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
