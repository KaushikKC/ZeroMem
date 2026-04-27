import { ethers } from 'ethers';
import type { ZeroCommit, CommitOp, CommitMetadata } from './types.js';
import type { StorageClient } from './storage.js';

export interface CommitInput {
  parent: string | null;
  agentId: string;
  authorPubkey: string;
  op: CommitOp;
  branch: string;
  namespace: string;
  payloadRoot: string;
  metadata: CommitMetadata;
}

/** Canonical JSON for signing (no sig field) */
function signable(c: Omit<ZeroCommit, 'sig'>): string {
  return JSON.stringify({
    version: c.version,
    parent: c.parent,
    agent_id: c.agent_id,
    author_pubkey: c.author_pubkey,
    op: c.op,
    branch: c.branch,
    namespace: c.namespace,
    payload_root: c.payload_root,
    metadata: c.metadata,
  });
}

export function buildCommit(input: CommitInput): Omit<ZeroCommit, 'sig'> {
  return {
    version: 1,
    parent: input.parent,
    agent_id: input.agentId,
    author_pubkey: input.authorPubkey,
    op: input.op,
    branch: input.branch,
    namespace: input.namespace,
    payload_root: input.payloadRoot,
    metadata: input.metadata,
  };
}

export async function signCommit(
  partial: Omit<ZeroCommit, 'sig'>,
  wallet: ethers.Wallet
): Promise<ZeroCommit> {
  const msgHash = ethers.keccak256(ethers.toUtf8Bytes(signable(partial)));
  const sig = await wallet.signMessage(ethers.getBytes(msgHash));
  return { ...partial, sig };
}

export function verifyCommit(commit: ZeroCommit): string {
  const { sig, ...rest } = commit;
  const msgHash = ethers.keccak256(ethers.toUtf8Bytes(signable(rest)));
  return ethers.verifyMessage(ethers.getBytes(msgHash), sig);
}

/** Serialize commit to bytes for 0G upload */
export function encodeCommit(commit: ZeroCommit): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(commit));
}

export function decodeCommit(bytes: Uint8Array): ZeroCommit {
  return JSON.parse(new TextDecoder().decode(bytes)) as ZeroCommit;
}

/** Upload a signed commit as encrypted blob, return its root hash (= commitId) */
export async function storeCommit(
  commit: ZeroCommit,
  storage: StorageClient
): Promise<string> {
  const data = encodeCommit(commit);
  return storage.upload(data, {
    encrypt: true,
    recipientPubKey: storage.pubKey,
  });
}

/** Load a commit by rootHash */
export async function loadCommit(
  commitId: string,
  storage: StorageClient,
  privateKey: string
): Promise<ZeroCommit> {
  const data = await storage.download(commitId, { privateKey });
  return decodeCommit(data);
}

/** Walk commit DAG from tip toward root, yield each commit */
export async function* walkCommits(
  tipCommitId: string,
  storage: StorageClient,
  privateKey: string
): AsyncGenerator<{ commitId: string; commit: ZeroCommit }> {
  let current: string | null = tipCommitId;
  const seen = new Set<string>();

  while (current && !seen.has(current)) {
    seen.add(current);
    const commit = await loadCommit(current, storage, privateKey);
    yield { commitId: current, commit };
    current = commit.parent;
  }
}
