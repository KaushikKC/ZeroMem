export type CommitOp =
  | 'remember'
  | 'reflect'
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

/** Vector entry stored inside a KV index shard */
export interface VectorEntry {
  commitId: string;
  text: string;
  embedding: number[];
  ts: number;
  tags: string[];
  namespace: string;
}

export interface RecallResult {
  text: string;
  score: number;
  commitId: string;
  ts: number;
  tags: string[];
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

export interface ZeroMemConfig {
  privateKey: string;
  agentId: string;
  branch?: string;
  rpcUrl?: string;
  indexerUrl?: string;
  kvUrl?: string;
  computeProviderAddress?: string;
  computeEndpoint?: string;
  grantRegistryAddress?: string;
}

export const DEFAULTS = {
  RPC_URL: 'https://evmrpc-testnet.0g.ai',
  INDEXER_URL: 'https://indexer-storage-testnet-turbo.0g.ai',
  KV_URL: 'http://3.101.147.150:6789',
  FLOW_CONTRACT: '0x22E03a6A89B950F1c82ec5e74F8eCa321a105296',
  CHAIN_ID: 16602,
  EMBEDDING_DIM: 384,
} as const;
