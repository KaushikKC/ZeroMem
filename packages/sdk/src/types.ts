export type CommitOp =
  | 'remember'
  | 'reflect'
  | 'plan'
  | 'forget'
  | 'skill_add'
  | 'grant'
  | 'revoke';

export interface CommitMetadata {
  ts: number;
  model_id?: string;
  embedding_dim?: number;
  tags?: string[];
}

/** Append-only DAG node stored as encrypted blob on 0G Log layer */
export interface ZeroCommit {
  version: 1;
  parent: string | null;
  agent_id: string;
  author_pubkey: string;
  op: CommitOp;
  branch: string;
  namespace: string;
  payload_root: string;
  metadata: CommitMetadata;
  sig: string;
}

/** Vector entry stored as a blob; KV shards keep only its rootHash */
export interface VectorEntry {
  commitId: string;
  text: string;
  embedding: number[];
  ts: number;
  tags: string[];
  namespace: string;
}

/** Small KV record pointing to a vector-entry blob */
export interface VectorRef {
  commitId: string;
  rootHash: string;
}

export interface RecallResult {
  text: string;
  score: number;
  commitId: string;
  ts: number;
  tags: string[];
}

export interface AskResult {
  answer: string;
  hits: RecallResult[];
}

export interface GrantRecord {
  grantId: string;
  from: string;
  to: string;
  scope: string;
  ttl: number;
  commitRoot: string;
  payloadRoot: string;
  createdAt: number;
}

export interface Skill {
  name: string;
  code: string;
  schema: Record<string, unknown>;
  version: number;
  createdAt: number;
}

export interface Plan {
  goal: string;
  commitId: string;
  tasks: PlanTask[];
}

export interface PlanTask {
  id: string;
  description: string;
  dependsOn: string[];
  done: boolean;
}

/** Options for mem.search() — richer than recall() */
export interface SearchOpts {
  query: string;
  k?: number;
  ns?: string;
  /** Only return entries that contain ALL of these tags */
  tags?: string[];
  /** Only entries newer than this (e.g. '7d', '1h') */
  since?: string;
  /** Only entries older than this (e.g. '1d') */
  until?: string;
  /** Minimum cosine score (0–1) */
  minScore?: number;
  /** 0–1: weight recency vs pure semantic similarity. Default 0. */
  recencyWeight?: number;
  /** Granter address for cross-agent search */
  from?: string;
}

/** Return type of mem.stats() */
export interface MemStats {
  agentId: string;
  currentBranch: string;
  branches: string[];
  /** Per branch/namespace item count */
  namespaceStats: Record<string, number>;
  skills: string[];
  headCommitId: string | null;
  approxTotalMemories: number;
}

/** Verifiable proof that a commit exists on 0G */
export interface CommitProof {
  commitId: string;
  agentId: string;
  agentAddress: string;
  agentPubKey: string;
  op: string;
  branch: string;
  payloadRoot: string;
  ts: number;
  /** Signature by agent at write time — over the full commit body */
  commitSig: string;
  /** Fresh attestation signature — agent signs { commitId, provedAt } now */
  attestationSig: string;
  provedAt: number;
  storageExplorerUrl: string;
}

/** Return type of mem.diff() */
export interface DiffResult {
  branchA: string;
  branchB: string;
  /** Commits only in A (not in B) */
  onlyInA: Array<{ commitId: string; op: string; ts: number; branch: string }>;
  /** Commits only in B (not in A) */
  onlyInB: Array<{ commitId: string; op: string; ts: number; branch: string }>;
  /** Most recent common ancestor commitId */
  divergedAt: string | null;
}

/** Return type of mem.gc() */
export interface GcResult {
  removed: number;
  namespacesScanned: string[];
}

export interface ZeroMemConfig {
  privateKey: string;
  agentId: string;
  branch?: string;
  rpcUrl?: string;
  indexerUrl?: string;
  kvUrl?: string;
  postgresUrl?: string;
  computeProviderAddress?: string;
  computeEndpoint?: string;
  grantRegistryAddress?: string;
  /** OpenRouter API key — when set, ask/plan/reflect use OpenRouter instead of 0G Compute */
  openrouterApiKey?: string;
  /** OpenRouter model id (default 'openai/gpt-4o-mini') */
  openrouterModel?: string;
  /** OpenAI-compatible base URL (default 'https://openrouter.ai/api/v1') */
  openrouterBaseUrl?: string;
}

export const DEFAULTS = {
  RPC_URL: 'https://evmrpc-testnet.0g.ai',
  INDEXER_URL: 'https://indexer-storage-testnet-turbo.0g.ai',
  KV_URL: 'http://localhost:6789',
  FLOW_CONTRACT: '0x22E03a6A89B950F1c82ec5e74F8eCa321a105296',
  CHAIN_ID: 16602,
  EMBEDDING_DIM: 384,
} as const;
