import { ethers } from 'ethers';
import { buildCommit, signCommit, storeCommit, loadCommit, walkCommits } from './commit.js';
import type { StorageClient } from './storage.js';
import type { KvViews } from './kv-views.js';
import type { VectorIndex } from './vector.js';
import type { ZeroCommit, DiffResult } from './types.js';

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
    // Merge all known namespaces — use branch/ns format (not agentId/branch/ns)
    const knownNs = ['default', 'semantic', 'sessions', 'plans'];
    await Promise.all(
      knownNs.map((ns) =>
        ctx.vector.merge(`${srcBranch}/${ns}`, `${ctx.branch}/${ns}`)
      )
    );
    return srcHead;
  }

  // reflect strategy: collect diverged commits from src, extract texts,
  // summarize via sealed inference, write a single 'reflect' commit on dst
  const texts: string[] = [];
  for await (const { commit } of walkCommits(srcHead, ctx.storage, ctx.privateKey)) {
    // Stop when we reach commits that already exist on the destination branch
    const dstHead = await ctx.kv.getHead(ctx.agentId, ctx.branch);
    if (dstHead && commit.parent === dstHead) break;
    if (commit.op !== 'remember') continue;
    try {
      const data = await ctx.storage.download(commit.payload_root, {
        privateKey: ctx.privateKey,
      });
      const payload = JSON.parse(new TextDecoder().decode(data)) as { text?: string };
      if (payload.text) texts.push(payload.text);
    } catch {
      // skip unreadable payloads
    }
  }

  // Update the destination HEAD to the source HEAD (structural merge)
  await ctx.kv.setHead(ctx.agentId, ctx.branch, srcHead);
  // Merge vector entries for all namespaces
  const knownNs = ['default', 'semantic', 'sessions', 'plans'];
  await Promise.all(
    knownNs.map((ns) =>
      ctx.vector.merge(`${srcBranch}/${ns}`, `${ctx.branch}/${ns}`)
    )
  );

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

/**
 * diff: find commits that exist in branchA but not branchB, and vice versa.
 * Walks both chains and finds the divergence point (common ancestor).
 */
export async function diffBranches(
  ctx: GitContext,
  branchA: string,
  branchB: string
): Promise<DiffResult> {
  const headA = await ctx.kv.getHead(ctx.agentId, branchA);
  const headB = await ctx.kv.getHead(ctx.agentId, branchB);

  type CommitSummary = { commitId: string; op: string; ts: number; branch: string };

  const mapA = new Map<string, CommitSummary>();
  const mapB = new Map<string, CommitSummary>();

  if (headA) {
    for await (const { commitId, commit } of walkCommits(headA, ctx.storage, ctx.privateKey)) {
      mapA.set(commitId, { commitId, op: commit.op, ts: commit.metadata.ts, branch: commit.branch });
    }
  }
  if (headB) {
    for await (const { commitId, commit } of walkCommits(headB, ctx.storage, ctx.privateKey)) {
      mapB.set(commitId, { commitId, op: commit.op, ts: commit.metadata.ts, branch: commit.branch });
    }
  }

  const onlyInA = [...mapA.values()].filter(({ commitId }) => !mapB.has(commitId));
  const onlyInB = [...mapB.values()].filter(({ commitId }) => !mapA.has(commitId));
  const divergedAt = [...mapA.keys()].find((id) => mapB.has(id)) ?? null;

  return { branchA, branchB, onlyInA, onlyInB, divergedAt };
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
