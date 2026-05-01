export interface ZeroMemClientConfig {
  agentId: string;
  serverUrl?: string;
  namespace?: string;
  branch?: string;
  /** Request timeout in ms (default 180_000 — chain writes need ~30–90s) */
  timeoutMs?: number;
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

export interface BranchResponse {
  branch: string;
}

export interface LogEntry {
  commitId: string;
  commit: {
    op: string;
    branch: string;
    namespace: string;
    metadata: {
      ts: number;
      tags?: string[];
    };
  };
}

export interface LogResponse {
  entries: LogEntry[];
}

export interface BlameEntry {
  commitId: string;
  ts: number;
  op: string;
}

export interface BlameResponse {
  matches: BlameEntry[];
}

export interface MergeResponse {
  ok: boolean;
}

export interface RestoreResponse {
  ok: boolean;
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
  readonly branch: string;
  /** ms — write ops hit the chain so need generous headroom */
  private readonly timeoutMs: number;

  private constructor(config: ZeroMemClientConfig) {
    this.agentId = config.agentId;
    this.serverUrl = (config.serverUrl ?? 'http://localhost:3001').replace(/\/$/, '');
    this.namespace = config.namespace;
    this.branch = config.branch ?? 'main';
    this.timeoutMs = config.timeoutMs ?? 180_000;
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
      branch: this.branch,
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
      branch: this.branch,
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
      branch: this.branch,
      question,
      k: opts.k ?? 5,
      ns: opts.ns ?? this.namespace,
      from: opts.from,
    });
  }

  async plan(goal: string): Promise<PlanResponse> {
    return this.post('/plan', {
      agentId: this.agentId,
      branch: this.branch,
      goal,
    });
  }

  async branchOff(name: string): Promise<ZeroMemClient> {
    await this.post<BranchResponse>('/branch', {
      agentId: this.agentId,
      branch: this.branch,
      name,
    });
    return ZeroMemClient.create({
      agentId: this.agentId,
      serverUrl: this.serverUrl,
      namespace: this.namespace,
      branch: name,
      timeoutMs: this.timeoutMs,
    });
  }

  async merge(
    sourceBranch: string,
    opts: { strategy?: 'reflect' | 'fast-forward' } = {}
  ): Promise<MergeResponse> {
    return this.post('/merge', {
      agentId: this.agentId,
      branch: this.branch,
      sourceBranch,
      strategy: opts.strategy ?? 'fast-forward',
    });
  }

  async log(opts: { limit?: number; branch?: string } = {}): Promise<LogResponse> {
    return this.post('/log', {
      agentId: this.agentId,
      branch: opts.branch ?? this.branch,
      limit: opts.limit ?? 20,
    });
  }

  async blame(keyword: string, opts: { branch?: string } = {}): Promise<BlameResponse> {
    return this.post('/blame', {
      agentId: this.agentId,
      branch: opts.branch ?? this.branch,
      keyword,
    });
  }

  async restore(opts: { branch?: string; tipCommitId?: string } = {}): Promise<RestoreResponse> {
    return this.post('/restore', {
      agentId: this.agentId,
      branch: opts.branch ?? this.branch,
      tipCommitId: opts.tipCommitId,
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
      branch: this.branch,
      ...opts,
    });
  }

  async revoke(grantId: string): Promise<RevokeResponse> {
    return this.post('/revoke', {
      agentId: this.agentId,
      branch: this.branch,
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
    // undici (Node fetch) has a 30s headersTimeout independent of AbortSignal — chain
    // writes can take 60–120s before the server writes the first response byte.
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs });

    const resp = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      // @ts-expect-error undici dispatcher
      dispatcher,
    });
    if (!resp.ok) {
      throw new Error(`ZeroMem request failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json() as Promise<T>;
  }
}
