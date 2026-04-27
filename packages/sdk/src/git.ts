import { ethers } from 'ethers';
import { buildCommit, signCommit, storeCommit, loadCommit, walkCommits } from './commit.js';
import type { StorageClient } from './storage.js';
import type { KvViews } from './kv-views.js';
import type { VectorIndex } from './vector.js';
import type { ZeroCommit } from './types.js';

export interface GitContext {
  storage: StorageClient;
  kv: KvViews;
  vector: VectorIndex;
  wallet: ethers.Wallet;
  agentId: string;
  branch: string;
  privateKey: string;
}

/** Create a new branch from the current HEAD */
export async function forkBranch(
  ctx: GitContext,
  newBranch: string
): Promise<void> {
  const head = await ctx.kv.getHead(ctx.agentId, ctx.branch);
  if (head) {
    await ctx.kv.setHead(ctx.agentId, newBranch, head);
  }
  await ctx.kv.addBranch(ctx.agentId, newBranch);
}

/** Merge a source branch into the current branch using the chosen strategy */
export async function mergeBranch(
  ctx: GitContext,
  srcBranch: string,
  strategy: 'reflect' | 'fast-forward' = 'fast-forward'
): Promise<string | null> {
  const srcHead = await ctx.kv.getHead(ctx.agentId, srcBranch);
  if (!srcHead) return null;

  if (strategy === 'fast-forward') {
    await ctx.kv.setHead(ctx.agentId, ctx.branch, srcHead);
    // Merge vector index entries
    await ctx.vector.merge(
      `${ctx.agentId}/${srcBranch}/default`,
      `${ctx.agentId}/${ctx.branch}/default`
    );
    return srcHead;
  }

  // reflect strategy: collect all commits from src since divergence, summarize
  const commits: ZeroCommit[] = [];
  for await (const { commit } of walkCommits(srcHead, ctx.storage, ctx.privateKey)) {
    if (commit.op === 'remember') {
      const payload = await ctx.storage.download(commit.payload_root, {
        privateKey: ctx.privateKey,
      });
      commits.push({
        ...commit,
        payload_root: new TextDecoder().decode(payload),
      });
    }
  }

  return srcHead;
}

/** Build a view of the commit DAG rooted at HEAD (for blame/log) */
export async function log(
  ctx: GitContext,
  opts: { limit?: number; branch?: string } = {}
): Promise<Array<{ commitId: string; commit: ZeroCommit }>> {
  const branch = opts.branch ?? ctx.branch;
  const limit = opts.limit ?? 20;
  const head = await ctx.kv.getHead(ctx.agentId, branch);
  if (!head) return [];

  const result: Array<{ commitId: string; commit: ZeroCommit }> = [];
  for await (const entry of walkCommits(head, ctx.storage, ctx.privateKey)) {
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

/** Time-travel: return a read-only snapshot context at a specific commit */
export async function replay(
  ctx: GitContext,
  atCommitId: string
): Promise<GitContext & { frozen: true }> {
  // Verify the commit exists
  await loadCommit(atCommitId, ctx.storage, ctx.privateKey);
  return {
    ...ctx,
    branch: `replay/${atCommitId.slice(0, 8)}`,
    frozen: true,
  } as GitContext & { frozen: true };
}

/** blame: find which commit introduced knowledge about a topic */
export async function blame(
  ctx: GitContext,
  keyword: string,
  branch?: string
): Promise<Array<{ commitId: string; ts: number; op: string }>> {
  const b = branch ?? ctx.branch;
  const head = await ctx.kv.getHead(ctx.agentId, b);
  if (!head) return [];

  const matches: Array<{ commitId: string; ts: number; op: string }> = [];

  for await (const { commitId, commit } of walkCommits(
    head,
    ctx.storage,
    ctx.privateKey
  )) {
    if (commit.op !== 'remember' && commit.op !== 'reflect') continue;
    try {
      const data = await ctx.storage.download(commit.payload_root, {
        privateKey: ctx.privateKey,
      });
      const payload = JSON.parse(new TextDecoder().decode(data)) as { text?: string };
      if (payload.text?.toLowerCase().includes(keyword.toLowerCase())) {
        matches.push({ commitId, ts: commit.metadata.ts, op: commit.op });
      }
    } catch {
      // skip unreadable payloads
    }
  }

  return matches;
}
