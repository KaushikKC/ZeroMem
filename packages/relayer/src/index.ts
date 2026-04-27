import 'dotenv/config';
import express from 'express';
import { ZeroMem } from '@zeromem/sdk';

/**
 * ZeroMem Relayer — optional self-hosted service.
 *
 * Exposes an HTTP API so multiple agents on different machines
 * can share a single 0G wallet/signer without distributing private keys.
 *
 * POST /remember   { agentId, text, ns?, tags? }
 * POST /recall     { agentId, query, k?, ns? }
 * POST /reflect    { agentId, since? }
 * POST /grant      { agentId, to, toPubKey?, scope, ttl }
 * POST /revoke     { agentId, grantId }
 * GET  /health
 */

const app = express();
app.use(express.json());

const PORT = process.env.RELAYER_PORT ? parseInt(process.env.RELAYER_PORT) : 3001;

// Cache of ZeroMem instances per agentId
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
    computeProviderAddress: process.env.ZG_COMPUTE_PROVIDER,
    computeEndpoint: process.env.ZG_COMPUTE_ENDPOINT,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  });

  instances.set(agentId, mem);
  return mem;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.post('/remember', async (req, res) => {
  try {
    const { agentId, text, ns, tags } = req.body as {
      agentId: string;
      text: string;
      ns?: string;
      tags?: string[];
    };
    const mem = await getInstance(agentId);
    const commitId = await mem.remember(text, { ns, tags });
    res.json({ commitId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/recall', async (req, res) => {
  try {
    const { agentId, query, k, ns, from } = req.body as {
      agentId: string;
      query: string;
      k?: number;
      ns?: string;
      from?: string;
    };
    const mem = await getInstance(agentId);
    const hits = await mem.recall(query, { k, ns, from });
    res.json({ hits });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/reflect', async (req, res) => {
  try {
    const { agentId, since } = req.body as { agentId: string; since?: string };
    const mem = await getInstance(agentId);
    const commitId = await mem.reflect({ since });
    res.json({ commitId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/grant', async (req, res) => {
  try {
    const { agentId, to, toPubKey, scope, ttl } = req.body as {
      agentId: string;
      to: string;
      toPubKey?: string;
      scope: string;
      ttl: string;
    };
    const mem = await getInstance(agentId);
    const grantId = await mem.grant({ to, toPubKey, scope, ttl });
    res.json({ grantId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/revoke', async (req, res) => {
  try {
    const { agentId, grantId } = req.body as {
      agentId: string;
      grantId: string;
    };
    const mem = await getInstance(agentId);
    await mem.revoke(grantId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/plan', async (req, res) => {
  try {
    const { agentId, goal } = req.body as { agentId: string; goal: string };
    const mem = await getInstance(agentId);
    const plan = await mem.plan(goal);
    res.json({ plan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ZeroMem Relayer running on :${PORT}`);
});
