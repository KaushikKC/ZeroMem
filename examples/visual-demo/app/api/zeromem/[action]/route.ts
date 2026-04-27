import { NextRequest, NextResponse } from 'next/server';
import { ZeroMem } from '@zeromem/sdk';

// Server-side ZeroMem instance cache
const instances = new Map<string, ZeroMem>();

async function getInstance(agentId: string): Promise<ZeroMem> {
  if (instances.has(agentId)) return instances.get(agentId)!;
  const mem = await ZeroMem.create({
    privateKey: process.env.ZG_PRIVATE_KEY!,
    agentId,
    branch: 'main',
    rpcUrl: process.env.ZG_RPC,
    indexerUrl: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
    computeEndpoint: process.env.ZG_COMPUTE_ENDPOINT,
    computeProviderAddress: process.env.ZG_COMPUTE_PROVIDER,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  });
  instances.set(agentId, mem);
  return mem;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { action: string } }
) {
  const body = await request.json();
  const { agentId } = body as { agentId: string };
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });

  try {
    const mem = await getInstance(agentId);

    switch (params.action) {
      case 'remember': {
        const commitId = await mem.remember(body.text, { ns: body.ns, tags: body.tags });
        return NextResponse.json({ commitId });
      }
      case 'recall': {
        const hits = await mem.recall(body.query, { k: body.k ?? 5, ns: body.ns });
        return NextResponse.json({ hits });
      }
      case 'reflect': {
        const commitId = await mem.reflect({ since: body.since });
        return NextResponse.json({ commitId });
      }
      case 'log': {
        const raw = await mem.log({ limit: body.limit ?? 10 });
        const commits = await Promise.all(
          raw.map(async ({ commitId, commit }) => {
            let text = '';
            try {
              const data = await mem.raw.download(commit.payload_root, {
                privateKey: process.env.ZG_PRIVATE_KEY,
              } as any);
              const payload = JSON.parse(new TextDecoder().decode(data));
              text = payload.text ?? payload.summary ?? '';
            } catch {}
            return { commitId, text, op: commit.op, ts: commit.metadata.ts };
          })
        );
        return NextResponse.json({ commits });
      }
      case 'plan': {
        const plan = await mem.plan(body.goal);
        return NextResponse.json({ plan });
      }
      case 'grant': {
        const grantId = await mem.grant({
          to: body.to,
          toPubKey: body.toPubKey,
          scope: body.scope,
          ttl: body.ttl,
        });
        return NextResponse.json({ grantId });
      }
      case 'revoke': {
        await mem.revoke(body.grantId);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
