import 'dotenv/config';
import express from 'express';
import { ZeroMem } from '@zeromem/sdk';

/**
 * ZeroMem Relayer — self-hosted service boundary for framework users.
 *
 * POST /remember   { agentId, branch?, text, ns?, tags? }
 * POST /recall     { agentId, branch?, query, k?, ns?, from? }
 * POST /ask        { agentId, branch?, question, k?, ns?, from? }
 * POST /branch     { agentId, branch?, name }
 * POST /merge      { agentId, branch?, sourceBranch, strategy? }
 * POST /log        { agentId, branch?, limit? }
 * POST /blame      { agentId, branch?, keyword }
 * POST /restore    { agentId, branch?, tipCommitId? }
 * POST /grant      { agentId, branch?, to, toPubKey?, scope, ttl }
 * POST /revoke     { agentId, branch?, grantId }
 * POST /plan       { agentId, branch?, goal }
 * GET  /health
 */

const app = express();
app.use(express.json());

const PORT = process.env.RELAYER_PORT ? parseInt(process.env.RELAYER_PORT) : 3001;

// Cache of ZeroMem instances per agentId + branch
const instances = new Map<string, ZeroMem>();

async function getInstance(agentId: string, branch = 'main'): Promise<ZeroMem> {
  const key = `${agentId}:${branch}`;
  if (instances.has(key)) return instances.get(key)!;

  const mem = await ZeroMem.create({
    privateKey: process.env.ZG_PRIVATE_KEY!,
    agentId,
    branch,
    rpcUrl: process.env.ZG_RPC,
    indexerUrl: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
    postgresUrl: process.env.POSTGRES_URL,
    computeProviderAddress: process.env.ZG_COMPUTE_PROVIDER,
    computeEndpoint: process.env.ZG_COMPUTE_ENDPOINT,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  });

  instances.set(key, mem);
  return mem;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.post('/remember', async (req, res) => {
  try {
    const { agentId, branch, text, ns, tags } = req.body as {
      agentId: string;
      branch?: string;
      text: string;
      ns?: string;
      tags?: string[];
    };
    const mem = await getInstance(agentId, branch);
    const commitId = await mem.remember(text, { ns, tags });
    res.json({ commitId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/recall', async (req, res) => {
  try {
    const { agentId, branch, query, k, ns, from } = req.body as {
      agentId: string;
      branch?: string;
      query: string;
      k?: number;
      ns?: string;
      from?: string;
    };
    const mem = await getInstance(agentId, branch);
    const hits = await mem.recall(query, { k, ns, from });
    res.json({ hits });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/ask', async (req, res) => {
  try {
    const { agentId, branch, question, k, ns, from } = req.body as {
      agentId: string;
      branch?: string;
      question: string;
      k?: number;
      ns?: string;
      from?: string;
    };
    const mem = await getInstance(agentId, branch);
    const result = await mem.ask(question, { k, ns, from });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/branch', async (req, res) => {
  try {
    const { agentId, branch, name } = req.body as {
      agentId: string;
      branch?: string;
      name: string;
    };
    const mem = await getInstance(agentId, branch);
    await mem.branch(name);
    res.json({ branch: name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/merge', async (req, res) => {
  try {
    const { agentId, branch, sourceBranch, strategy } = req.body as {
      agentId: string;
      branch?: string;
      sourceBranch: string;
      strategy?: 'reflect' | 'fast-forward';
    };
    const mem = await getInstance(agentId, branch);
    await mem.merge(sourceBranch, { strategy });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/log', async (req, res) => {
  try {
    const { agentId, branch, limit } = req.body as {
      agentId: string;
      branch?: string;
      limit?: number;
    };
    const mem = await getInstance(agentId, branch);
    const entries = await mem.log({ branch, limit });
    res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/blame', async (req, res) => {
  try {
    const { agentId, branch, keyword } = req.body as {
      agentId: string;
      branch?: string;
      keyword: string;
    };
    const mem = await getInstance(agentId, branch);
    const matches = await mem.blame(keyword);
    res.json({ matches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/restore', async (req, res) => {
  try {
    const { agentId, branch, tipCommitId } = req.body as {
      agentId: string;
      branch?: string;
      tipCommitId?: string;
    };
    const mem = await getInstance(agentId, branch);
    await mem.restore(branch, { tipCommitId });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/grant', async (req, res) => {
  try {
    const { agentId, branch, to, toPubKey, scope, ttl } = req.body as {
      agentId: string;
      branch?: string;
      to: string;
      toPubKey?: string;
      scope: string;
      ttl: string;
    };
    const mem = await getInstance(agentId, branch);
    const grantId = await mem.grant({ to, toPubKey, scope, ttl });
    res.json({ grantId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/revoke', async (req, res) => {
  try {
    const { agentId, branch, grantId } = req.body as {
      agentId: string;
      branch?: string;
      grantId: string;
    };
    const mem = await getInstance(agentId, branch);
    await mem.revoke(grantId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/plan', async (req, res) => {
  try {
    const { agentId, branch, goal } = req.body as {
      agentId: string;
      branch?: string;
      goal: string;
    };
    const mem = await getInstance(agentId, branch);
    const plan = await mem.plan(goal);
    res.json({ plan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Express 4 error handler — catches any sync/async throws that escape route handlers
// and returns a proper 500 instead of closing the socket, which causes UND_ERR_SOCKET.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled relayer error:', err);
  res.status(500).json({ error: err?.message ?? String(err) });
});

// Keep process alive on uncaught errors so the relayer doesn't drop in-flight requests.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));

app.listen(PORT, () => {
  console.log(`ZeroMem Relayer running on :${PORT}`);
});
