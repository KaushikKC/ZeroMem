import { ethers } from 'ethers';
import { DEFAULTS } from './types.js';

export interface InferenceConfig {
  providerAddress?: string;
  endpoint?: string;
  rpcUrl?: string;
  privateKey: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class InferenceClient {
  private broker: unknown = null;
  private config: InferenceConfig;

  constructor(config: InferenceConfig) {
    this.config = config;
  }

  private async getBroker(): Promise<unknown> {
    if (this.broker) return this.broker;
    try {
      const { createZGComputeNetworkBroker } = await import(
        '@0glabs/0g-serving-broker'
      );
      const provider = new ethers.JsonRpcProvider(
        this.config.rpcUrl ?? DEFAULTS.RPC_URL
      );
      const wallet = new ethers.Wallet(this.config.privateKey, provider);
      this.broker = await createZGComputeNetworkBroker(wallet as any);
    } catch {
      // broker not available — fall back to direct HTTP
    }
    return this.broker;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    if (!this.config.providerAddress) return {};
    try {
      const broker = await this.getBroker() as any;
      if (!broker) return {};
      return await broker.inference.getRequestHeaders(
        this.config.providerAddress
      );
    } catch {
      return {};
    }
  }

  private endpoint(): string {
    return this.config.endpoint ?? '';
  }

  /** Call 0G Compute chat completions */
  async chat(
    messages: ChatMessage[],
    model = 'qwen-2.5-7b-instruct'
  ): Promise<string> {
    if (!this.endpoint()) {
      throw new Error('NO_INFERENCE_ENDPOINT');
    }
    const headers = await this.getHeaders();
    const resp = await fetch(`${this.endpoint()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ model, messages }),
    });
    if (!resp.ok) throw new Error(`Inference error: ${resp.status} ${await resp.text()}`);
    const json = (await resp.json()) as any;
    return json.choices[0].message.content as string;
  }

  /** Generate embedding for text — tries 0G /embeddings, falls back to local WASM */
  async embed(text: string, model = 'qwen-2.5-7b-instruct'): Promise<number[]> {
    // Try native embeddings endpoint
    if (this.endpoint()) {
      try {
        const headers = await this.getHeaders();
        const resp = await fetch(`${this.endpoint()}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ model, input: text }),
        });
        if (resp.ok) {
          const json = (await resp.json()) as any;
          if (json.data?.[0]?.embedding) return json.data[0].embedding as number[];
        }
      } catch {
        // fall through
      }
    }

    // Fallback: lightweight local embedding via @xenova/transformers if available
    try {
      const { pipeline } = await import('@xenova/transformers' as any);
      const extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      );
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array);
    } catch {
      // Deterministic pseudo-embedding as last resort (development only)
      return pseudoEmbed(text, DEFAULTS.EMBEDDING_DIM);
    }
  }

  /** Analyze text — extract key facts (for reflector) */
  async analyze(text: string): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content:
          'Extract a concise list of key facts from the following text. Return JSON: { "facts": string[] }',
      },
      { role: 'user', content: text },
    ]);
  }

  /** Reflect over episodic memories and produce semantic summary */
  async reflect(memories: string[]): Promise<string> {
    const combined = memories.join('\n---\n');
    try {
      return await this.chat([
      {
        role: 'system',
        content:
          'You are a memory reflector. Consolidate these episodic memories into a semantic summary that captures enduring facts, preferences, and patterns. Be concise.',
      },
      { role: 'user', content: combined },
    ]);
    } catch (e: any) {
      if (e?.message === 'NO_INFERENCE_ENDPOINT') {
        return '(reflector unavailable: ZG_COMPUTE_ENDPOINT not set)';
      }
      throw e;
    }
  }

  /** Generate a hierarchical task plan for a goal */
  async plan(goal: string, context: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await this.chat([
      {
        role: 'system',
        content: `You are a hierarchical task planner. Generate a JSON plan for the given goal using context.
Return: { "goal": string, "tasks": [{ "id": string, "description": string, "dependsOn": string[] }] }`,
      },
      {
        role: 'user',
        content: `Goal: ${goal}\n\nContext:\n${context}`,
      },
    ]);
    } catch (e: any) {
      if (e?.message === 'NO_INFERENCE_ENDPOINT') {
        return { goal, tasks: [{ id: 't1', description: '(planner unavailable: ZG_COMPUTE_ENDPOINT not set)', dependsOn: [] }] };
      }
      throw e;
    }
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : { goal, tasks: [] };
    } catch {
      return { goal, tasks: [] };
    }
  }
}

/** Deterministic pseudo-embedding for dev/testing (NOT semantically meaningful) */
function pseudoEmbed(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    vec[i % dim] = (vec[i % dim] + bytes[i] / 255) / 2;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}
