# ZeroMem — Git-for-Agent-Memory on 0G

> Versioned · Encrypted · Multi-Agent · Sealed-Inference-Native

ZeroMem is a **TypeScript SDK** that gives AI agents persistent, encrypted, versioned memory — stored entirely on the 0G decentralized network.

Every memory is a signed commit on an append-only DAG (stored as an ECIES-encrypted blob on 0G Storage). The KV layer materializes fast-lookup indices. Branches, merges, time-travel replay, and cross-agent grants all work like Git primitives.

Built for the [0G Hackathon](https://build.0g.ai) — OpenClaw framework track.

---

## What ZeroMem does

- **Stores** agent memories as signed, encrypted commits on 0G Storage — permanent and tamper-proof
- **Recalls** memories semantically via cosine similarity over a vector index stored in 0G KV
- **Branches** memory — agents can fork, experiment, and merge back, just like Git
- **Grants** another agent read access to your memory — time-limited, on-chain revocable
- **Recovers** from a KV wipe by replaying the 0G blob DAG (`restore()`)
- **Integrates** with OpenClaw agents as a drop-in gateway plugin

---

## Quick start

```bash
git clone <repo> && cd zeromem
cp .env.example .env        # fill ZG_PRIVATE_KEY at minimum
npm install
cd packages/sdk && npm test  # 59 unit tests, no network needed
```

### Minimal usage

```ts
import { ZeroMem } from '@zeromem/sdk';

const mem = await ZeroMem.create({
  privateKey: process.env.ZG_PRIVATE_KEY,
  agentId: 'my-agent',
  branch: 'main',
});

// Store a memory — ECIES-encrypted blob on 0G, commit added to DAG, KV index updated
const commitId = await mem.remember('Alice prefers terse responses.');

// Semantic recall — cosine similarity over KV vector shards
const hits = await mem.recall('how should I respond to Alice?', { k: 5 });
// → [{ text, score, commitId, ts, tags }]
```

### Branching

```ts
const draft = await mem.branch('experiment-v2');
await draft.remember('Trying a new approach...');
await mem.merge('experiment-v2');   // keep it — fast-forward main
// or just abandon the branch — main is untouched
```

### Multi-agent grant

```ts
// Agent A grants Agent B read access for 24 hours
const grantId = await memA.grant({
  to: agentBAddress,
  toPubKey: agentBCompressedPubKey,
  scope: 'default',
  ttl: '24h',
});

// Agent B reads from A's memory
const hits = await memB.recall('what did A learn?', { from: agentAAddress });

// Revoke any time — fires on-chain event → KV entry auto-purged
await memA.revoke(grantId, { scope: 'default', to: agentBAddress });
```

### Reflector — episodic → semantic

```ts
// Reads recent 'remember' commits, runs sealed inference, writes a 'reflect' commit
await mem.reflect({ since: '24h' });
```

### Time-travel replay

```ts
const snapshot = await mem.replay({ at: someOldCommitId });
const pastHits  = await snapshot.recall('what did agent know on Tuesday?');
// snapshot is read-only (frozen)
```

### Rich search with filters

```ts
const hits = await mem.search({
  query: 'vector storage',
  tags: ['0g', 'storage'],   // only entries with ALL these tags
  since: '7d',               // only last 7 days
  minScore: 0.4,             // ignore weak matches
  recencyWeight: 0.2,        // blend recency into score (0–1)
  k: 10,
});
```

### Semantic deduplication (automatic)

```ts
// Near-identical memories (cosine ≥ 0.95) are skipped — no duplicate write
const id = await mem.remember('Alice prefers terse replies', { dedupe: true });
// If this memory already exists, returns existing commitId without any 0G write
```

### Stats

```ts
const s = await mem.stats();
// → { agentId, branches, namespaceStats, skills, headCommitId, approxTotalMemories }
```

### Garbage collect

```ts
// Remove tombstoned entries from all KV shards — reclaims storage, speeds up search
const { removed } = await mem.gc();
```

### Prove — Merkle attestation

```ts
const proof = await mem.prove(commitId);
// → { commitId, agentAddress, commitSig, attestationSig, storageExplorerUrl, ... }
// commitSig was written at store time; attestationSig is fresh — two-sig proof
```

### Diff two branches

```ts
const result = await mem.diff('main', 'experiment-v2');
// → { onlyInA, onlyInB, divergedAt }
```

### Named snapshots (Git tags)

```ts
await mem.snapshot('before-experiment');
const snap = await mem.checkout('before-experiment'); // frozen read-only ZeroMem
```

### Plan tracking

```ts
const plan = await mem.plan('Write release notes for v2');
await mem.completePlanTask(plan.commitId, 't1');   // mark task done
const updated = await mem.getPlan(plan.commitId);  // reload
```

### Bulk forget

```ts
// Tombstone all session memories older than 30 days
const removed = await mem.forgetBulk({ ns: 'sessions', olderThan: '30d' });
await mem.gc(); // actually reclaim the KV space
```

### Restore after KV wipe

```ts
// Blobs on 0G Storage are permanent — only KV is lost
const tipCommitId = '0x...'; // last known commitId from your logs
await mem.restore('main', { tipCommitId });
// Walks DAG → rebuilds vector index, head, branches
```

---

## OpenClaw gateway plugin

`packages/openclaw-zeromem` is the full OpenClaw framework plugin.

```ts
import { createZeroMemPlugin } from '@zeromem/openclaw-gateway';

const plugin = await createZeroMemPlugin({
  privateKey: process.env.ZEROMEM_PRIVATE_KEY,
  agentId: 'main',
  grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
});

// Register with your OpenClaw agent
agent.use(plugin);
```

**Hooks (auto-wired):**

| Hook | What it does |
|---|---|
| `before_prompt_build` | Recalls top-k memories, filters injection patterns, HTML-escapes, wraps in `<zeromem-memories>` block, appends namespace instruction to system context |
| `agent_end` | Captures last N messages, strips `<zeromem-memories>` tags, runs `shouldCapture` filter (skips filler words, short texts, detected injections), stores to 0G |

**Tools (exposed to agent):**

| Tool | What it does |
|---|---|
| `memory_search` | Agent-callable semantic search over long-term memory |
| `memory_store` | Agent-callable store — validates text, rejects injections, stores to 0G |

**Configure via `openclaw.json`:**

```json
{
  "plugins": ["@zeromem/openclaw-gateway"],
  "zeromem": {
    "privateKey": "${ZEROMEM_PRIVATE_KEY}",
    "agentId": "main",
    "grantRegistryAddress": "${GRANT_REGISTRY_ADDRESS}",
    "autoRecall": true,
    "autoCapture": true,
    "maxRecallResults": 5,
    "minRelevance": 0.3
  }
}
```

**Vercel AI SDK wrapper (alternative):**

```ts
import { withZeroMem } from '@zeromem/openclaw';
const model = withZeroMem(openai('gpt-4'), { mem, autoCapture: true });
```

---

## Architecture

```
OpenClaw Agent
├── before_prompt_build hook  ← inject recalled memories into system prompt
├── agent_end hook            ← auto-capture conversation to 0G
├── memory_search tool        ← agent explicitly queries memory
└── memory_store tool         ← agent explicitly saves to memory
         │
         ▼
  @zeromem/openclaw-gateway
         │
         ▼
  ┌────────────────────────────────────────────┐
  │  @zeromem/sdk                              │
  │  client.ts    — ZeroMem class (public API) │
  │  commit.ts    — DAG node build/sign/verify │
  │  storage.ts   — 0G upload/download/KV      │
  │  kv-views.ts  — all KV key namespaces      │
  │  vector.ts    — cosine search over shards  │
  │  git.ts       — branch/fork/merge/replay   │
  │  grant.ts     — grant/revoke + event listen│
  │  inference.ts — 0G Compute proxy           │
  │  skills.ts    — signed skill blobs         │
  └──────────────┬─────────────────────────────┘
                 │ 0G Storage SDK    │ 0G Compute
                 ▼                   ▼
         Log layer + KV         qwen-2.5-7b-instruct
                 │
                 ▼
     GrantRegistry.sol  (0G EVM, chain 16602)
```

### How a memory write works

1. Text → `embed()` via 0G Compute (or local WASM fallback)
2. `{ text, embedding, ts, tags }` → ECIES-encrypted → uploaded to 0G Storage → `rootHash`
3. `ZeroCommit { parent, op:"remember", payload_root: rootHash, sig }` → signed with agent's Ethereum key → uploaded to 0G Storage → `commitId`
4. KV writes: `head/{agent}/{branch}` updated, vector entry appended to shard

### Commit format

```
ZeroCommit {
  version:       1
  parent:        rootHash | null        ← DAG link
  agent_id:      string
  author_pubkey: secp256k1 compressed
  op:            remember | reflect | forget | skill_add | grant | revoke
  branch:        string
  namespace:     string
  payload_root:  rootHash               ← ECIES-encrypted blob on 0G
  metadata:      { ts, embedding_dim, tags[] }
  sig:           secp256k1 over all above
}
```

### KV materialized views

| Key | Value |
|---|---|
| `head/{agentId}/{branch}` | latest commitId |
| `root/{agentId}/{branch}` | first commitId (write-once — survives partial wipes) |
| `idx/{agentId}/{branch}/{ns}/count` | total item count (drives shard selection) |
| `idx/{agentId}/{branch}/{ns}/v/{shard}` | JSON vector shard (256 entries max) |
| `skill/{agentId}/{name}` | signed skill blob rootHash |
| `skill/{agentId}/__manifest__` | JSON list of skill names |
| `grant/{from}/{to}/{scope}` | `{ grantId, ttl, granterAgentId }` |
| `grantidx/{grantId}` | `{ from, to, scope }` — for revoke event lookup |
| `tomb/{agentId}/{commitId}` | redaction marker |
| `branches/{agentId}` | list of branch names |

---

## Unit tests

```bash
cd packages/sdk && npm test           # 59 tests — core SDK
cd packages/openclaw-zeromem && npm test  # 34 tests — gateway plugin
```

93 total tests, all in-memory, run in ~15 seconds.

| Suite | Tests | Covers |
|---|---|---|
| `commit.test.ts` | 7 | build/sign/verify, tamper detection, encode/decode |
| `kv-views.test.ts` | 23 | all KV keys, grant index, manifest, tombstone, root anchor |
| `vector.test.ts` | 15 | cosine order, 257-entry shard overflow, cross-shard search, merge |
| `client.test.ts` | 14 | remember/recall, branch isolation, merge, forget, restore, grant |
| `hooks.test.ts` | — | before_prompt_build, agent_end hooks |
| `security.test.ts` | — | injection detection, HTML escape, shouldCapture |
| `tools.test.ts` | — | memory_search, memory_store tools |
| `namespace.test.ts` | — | session key → namespace derivation |

---

## Project structure

```
zeromem/
├── .env.example
├── README.md
├── IMPLEMENTATION_PLAN.md
├── HANDOVER.md
├── packages/
│   ├── sdk/                         ← @zeromem/sdk (core)
│   │   └── src/
│   │       ├── client.ts            ← ZeroMem class
│   │       ├── commit.ts            ← DAG commit format + signing
│   │       ├── storage.ts           ← 0G upload/download/KV
│   │       ├── kv-views.ts          ← KV key schema
│   │       ├── vector.ts            ← cosine search
│   │       ├── git.ts               ← branch/fork/merge/replay/blame
│   │       ├── grant.ts             ← grant/revoke + event listener
│   │       ├── inference.ts         ← 0G Compute proxy
│   │       ├── skills.ts            ← procedural memory
│   │       └── __tests__/           ← 59 unit tests
│   ├── openclaw-zeromem/            ← @zeromem/openclaw-gateway (framework plugin)
│   │   └── src/
│   │       ├── index.ts             ← createZeroMemPlugin() factory
│   │       ├── types.ts             ← interfaces + defaults
│   │       ├── namespace.ts         ← session key → namespace
│   │       ├── security.ts          ← injection guard, shouldCapture
│   │       ├── hooks/               ← before_prompt_build, agent_end
│   │       ├── tools/               ← memory_search, memory_store
│   │       ├── cli/                 ← zeromem search / zeromem stats
│   │       └── __tests__/           ← 34 unit tests
│   ├── contracts/                   ← GrantRegistry.sol (0G EVM)
│   ├── openclaw-plugin/             ← @zeromem/openclaw (Vercel AI wrapper)
│   └── relayer/                     ← optional HTTP service
└── examples/
    ├── research-agent/              ← flagship 2-agent CLI demo
    └── visual-demo/                 ← Next.js UI for demo video
```

---

## Deploying to 0G testnet

### 1. Get testnet tokens

```
https://faucet.0g.ai   (0.1 0G per wallet per day)
```

You need **two funded wallets** for the multi-agent grant demo.

### 2. Fill `.env`

```bash
cp .env.example .env
# Required:
ZG_PRIVATE_KEY=0x...
RESEARCHER_PRIVATE_KEY=0x...
WRITER_PRIVATE_KEY=0x...
# After step 3:
GRANT_REGISTRY_ADDRESS=0x...
# Optional — enables real sealed inference:
ZG_COMPUTE_PROVIDER=0x...
ZG_COMPUTE_ENDPOINT=https://...
```

### 3. Deploy GrantRegistry

```bash
cd packages/contracts
npm install && npx hardhat compile
npm run deploy:testnet
# Paste the logged address into .env as GRANT_REGISTRY_ADDRESS
```

### 4. Run the research-agent demo

```bash
cd examples/research-agent
npm install && npm run dev
```

Covers: remember → branch → recall → reflect → plan → grant → cross-agent recall → revoke → restore → skills.

After running, check `https://storagescan-galileo.0g.ai` — your encrypted blobs appear live.

### 5. Run the visual demo

```bash
cd examples/visual-demo
npm install && npm run dev   # → http://localhost:3000
```

---

## Testnet reference

| Parameter | Value |
|---|---|
| Network | 0G Galileo Testnet |
| Chain ID | 16602 |
| RPC | `https://evmrpc-testnet.0g.ai` |
| Storage Indexer | `https://indexer-storage-testnet-turbo.0g.ai` |
| Flow Contract | `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296` |
| Chain Explorer | `https://chainscan-galileo.0g.ai` |
| Storage Explorer | `https://storagescan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai` |


