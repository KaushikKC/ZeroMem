import { NextRequest, NextResponse } from 'next/server';
import { ZeroMem } from '@zeromem/sdk';

const instances = new Map<string, ZeroMem>();

async function getInstance(agentId: string, branch = 'main'): Promise<ZeroMem> {
  const key = `${agentId}::${branch}`;
  if (instances.has(key)) return instances.get(key)!;
  const mem = await ZeroMem.create({
    privateKey: process.env.ZG_PRIVATE_KEY!,
    agentId,
    branch,
    rpcUrl: process.env.ZG_RPC,
    indexerUrl: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
    computeEndpoint: process.env.ZG_COMPUTE_ENDPOINT,
    computeProviderAddress: process.env.ZG_COMPUTE_PROVIDER,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  });
  instances.set(key, mem);
  return mem;
}

function ok(data: unknown) { return NextResponse.json(data); }
function err(msg: string, status = 500) { return NextResponse.json({ error: msg }, { status }); }

export async function POST(
  request: NextRequest,
  { params }: { params: { action: string } }
) {
  const body = await request.json().catch(() => ({}));
  const { agentId = 'demo-agent', branch = 'main' } = body as { agentId?: string; branch?: string };

  try {
    const mem = await getInstance(agentId, branch);

    switch (params.action) {

      // ── Memory ──────────────────────────────────────────────────────────────

      case 'remember': {
        const commitId = await mem.remember(body.text, {
          ns: body.ns,
          tags: body.tags,
          dedupe: body.dedupe ?? false,
        });
        return ok({ commitId });
      }

      case 'recall': {
        const hits = await mem.recall(body.query, {
          k: body.k ?? 5,
          ns: body.ns,
          from: body.from,
        });
        return ok({ hits });
      }

      case 'ask': {
        const result = await mem.ask(body.question, {
          k: body.k ?? 5,
          ns: body.ns,
          from: body.from,
        });
        return ok(result);
      }

      case 'search': {
        const hits = await mem.search({
          query: body.query,
          k: body.k ?? 5,
          ns: body.ns,
          tags: body.tags,
          since: body.since,
          until: body.until,
          minScore: body.minScore ? parseFloat(body.minScore) : undefined,
          recencyWeight: body.recencyWeight ? parseFloat(body.recencyWeight) : undefined,
        });
        return ok({ hits });
      }

      case 'forget': {
        await mem.forget(body.commitId);
        return ok({ ok: true });
      }

      case 'forgetBulk': {
        const removed = await mem.forgetBulk({
          tags: body.tags,
          olderThan: body.olderThan,
          ns: body.ns,
        });
        return ok({ removed });
      }

      // ── Git ─────────────────────────────────────────────────────────────────

      case 'log': {
        const raw = await mem.log({ limit: body.limit ?? 15 });
        const commits = await Promise.all(
          raw.map(async ({ commitId, commit }) => {
            let text = '';
            try {
              const data = await mem.raw.download(commit.payload_root, {
                privateKey: process.env.ZG_PRIVATE_KEY,
              } as any);
              const payload = JSON.parse(new TextDecoder().decode(data));
              text = payload.text ?? payload.summary ?? payload.goal ?? '';
            } catch {}
            return {
              commitId,
              text: text.slice(0, 100),
              op: commit.op,
              branch: commit.branch,
              ns: commit.namespace,
              ts: commit.metadata.ts,
              tags: commit.metadata.tags ?? [],
            };
          })
        );
        return ok({ commits });
      }

      case 'branch': {
        const child = await mem.branch(body.name);
        // Cache the branched instance
        instances.set(`${agentId}::${body.name}`, child);
        return ok({ branch: body.name, currentBranch: child.currentBranch });
      }

      case 'merge': {
        await mem.merge(body.from, { strategy: body.strategy ?? 'fast-forward' });
        return ok({ ok: true, merged: body.from, into: mem.currentBranch });
      }

      case 'diff': {
        const result = await mem.diff(body.branchA, body.branchB);
        return ok(result);
      }

      case 'blame': {
        const result = await mem.blame(body.keyword);
        return ok({ matches: result });
      }

      case 'replay': {
        const snap = await mem.replay({ at: body.commitId });
        return ok({ branch: snap.currentBranch, frozen: true });
      }

      case 'snapshot': {
        await mem.snapshot(body.name);
        return ok({ name: body.name });
      }

      case 'checkout': {
        const snap = await mem.checkout(body.name);
        return ok({ branch: snap.currentBranch, frozen: true });
      }

      // ── Reflect & Plan ───────────────────────────────────────────────────────

      case 'reflect': {
        const commitId = await mem.reflect({ since: body.since ?? '1h', force: body.force });
        return ok({ commitId });
      }

      case 'plan': {
        const plan = await mem.plan(body.goal);
        return ok({ plan });
      }

      case 'getPlan': {
        const plan = await mem.getPlan(body.commitId);
        return ok({ plan });
      }

      case 'completePlanTask': {
        const newCommitId = await mem.completePlanTask(body.planCommitId, body.taskId);
        return ok({ commitId: newCommitId });
      }

      // ── Grants ───────────────────────────────────────────────────────────────

      case 'grant': {
        const grantId = await mem.grant({
          to: body.to,
          toPubKey: body.toPubKey,
          scope: body.scope ?? 'default',
          ttl: body.ttl ?? '24h',
          tier: body.tier ?? 'READ_FULL',
        });
        return ok({ grantId });
      }

      case 'batchGrant': {
        const grantIds = await mem.batchGrant({
          recipients: body.recipients,
          scope: body.scope ?? 'default',
          ttl: body.ttl ?? '24h',
          tier: body.tier ?? 'READ_FULL',
        });
        return ok({ grantIds });
      }

      case 'revoke': {
        await mem.revoke(body.grantId, { scope: body.scope, to: body.to });
        return ok({ ok: true });
      }

      case 'createChallenge': {
        const challenge = await mem.createAccessChallenge(body.recipientAddress, body.scope ?? 'default');
        return ok({ challenge });
      }

      case 'signChallenge': {
        // In production the recipient signs client-side with their own wallet.
        // For demo: accept an explicit recipientPrivKey; fall back to server key.
        const recipientKey: string = body.recipientPrivKey || process.env.ZG_PRIVATE_KEY!;
        if (!recipientKey || recipientKey.length < 60) {
          return err('recipientPrivKey is required for signChallenge (paste WRITER_PRIVATE_KEY or RESEARCHER_PRIVATE_KEY)');
        }
        const proof = await ZeroMem.signAccessChallenge(recipientKey, body.challenge);
        // Derive the address that signed so the UI can confirm
        const { ethers } = await import('ethers');
        const signerAddress = new ethers.Wallet(recipientKey).address;
        return ok({ proof, signerAddress });
      }

      case 'grantVerified': {
        const grantId = await mem.grantVerified({
          challenge: body.challenge,
          proof: body.proof,
          toPubKey: body.toPubKey,
          ttl: body.ttl ?? '24h',
          tier: body.tier ?? 'READ_FULL',
        });
        return ok({ grantId });
      }

      // ── System ───────────────────────────────────────────────────────────────

      case 'stats': {
        const stats = await mem.stats();
        return ok({ stats });
      }

      case 'gc': {
        const result = await mem.gc({ ns: body.ns });
        return ok(result);
      }

      case 'prove': {
        const proof = await mem.prove(body.commitId);
        return ok({ proof });
      }

      case 'restore': {
        await mem.restore(body.branch, { tipCommitId: body.tipCommitId });
        // Invalidate cache so next call re-reads rebuilt KV
        instances.delete(`${agentId}::${body.branch ?? 'main'}`);
        return ok({ ok: true });
      }

      // ── Skills ───────────────────────────────────────────────────────────────

      case 'skillAdd': {
        const blobRoot = await mem.skills.add({
          name: body.name,
          code: body.code,
          schema: body.schema ?? {},
        });
        return ok({ blobRoot, name: body.name });
      }

      case 'skillList': {
        const names = await mem.skills.list();
        return ok({ skills: names });
      }

      case 'skillRun': {
        const result = await mem.skills.run(body.name, body.input ?? {});
        return ok({ result });
      }

      default:
        return err(`Unknown action: ${params.action}`, 404);
    }
  } catch (e: any) {
    return err(e.message ?? 'Internal error');
  }
}
