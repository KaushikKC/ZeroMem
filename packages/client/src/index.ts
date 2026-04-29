export interface ZeroMemClientConfig {
  agentId: string;
  serverUrl?: string;
  namespace?: string;
}

export interface RememberResponse {
  commitId: string;
}

export interface RecallHit {
  text: string;
  score: number;
  commitId: string;
  ts: number;
  tags: string[];
}

export interface RecallResponse {
  hits: RecallHit[];
}

export interface AskResponse {
  answer: string;
  hits: RecallHit[];
}

export interface PlanTask {
  id: string;
  description: string;
  dependsOn: string[];
  done: boolean;
}

export interface PlanResponse {
  plan: {
    goal: string;
    commitId: string;
    tasks: PlanTask[];
  };
}

export interface HealthResponse {
  status: string;
  ts: number;
}

export interface GrantResponse {
  grantId: string;
}

export interface RevokeResponse {
  ok: boolean;
}

export class ZeroMemClient {
  private readonly agentId: string;
  private readonly serverUrl: string;
  private readonly namespace?: string;

  private constructor(config: ZeroMemClientConfig) {
    this.agentId = config.agentId;
    this.serverUrl = (config.serverUrl ?? 'http://localhost:3001').replace(/\/$/, '');
    this.namespace = config.namespace;
  }

  static create(config: ZeroMemClientConfig): ZeroMemClient {
    return new ZeroMemClient(config);
  }

  async remember(
    text: string,
    opts: { ns?: string; tags?: string[] } = {}
  ): Promise<RememberResponse> {
    return this.post('/remember', {
      agentId: this.agentId,
      text,
      ns: opts.ns ?? this.namespace,
      tags: opts.tags,
    });
  }

  async recall(
    query: string,
    opts: { k?: number; ns?: string; from?: string } = {}
  ): Promise<RecallResponse> {
    return this.post('/recall', {
      agentId: this.agentId,
      query,
      k: opts.k ?? 5,
      ns: opts.ns ?? this.namespace,
      from: opts.from,
    });
  }

  async ask(
    question: string,
    opts: { k?: number; ns?: string; from?: string } = {}
  ): Promise<AskResponse> {
    return this.post('/ask', {
      agentId: this.agentId,
      question,
      k: opts.k ?? 5,
      ns: opts.ns ?? this.namespace,
      from: opts.from,
    });
  }

  async plan(goal: string): Promise<PlanResponse> {
    return this.post('/plan', {
      agentId: this.agentId,
      goal,
    });
  }

  async grant(opts: {
    to: string;
    toPubKey?: string;
    scope: string;
    ttl: string;
  }): Promise<GrantResponse> {
    return this.post('/grant', {
      agentId: this.agentId,
      ...opts,
    });
  }

  async revoke(grantId: string): Promise<RevokeResponse> {
    return this.post('/revoke', {
      agentId: this.agentId,
      grantId,
    });
  }

  async health(): Promise<HealthResponse> {
    const resp = await fetch(`${this.serverUrl}/health`);
    if (!resp.ok) {
      throw new Error(`ZeroMem health failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json() as Promise<HealthResponse>;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const resp = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`ZeroMem request failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json() as Promise<T>;
  }
}
