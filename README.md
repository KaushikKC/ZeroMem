# ZeroMem — Git-for-Agent-Memory on 0G

> Versioned · Encrypted · Multi-Agent · Sealed-Inference-Native

ZeroMem turns **0G Storage + Compute** into a Git-like memory layer for AI agents.
Every memory is a signed commit on an append-only DAG, stored as an ECIES-encrypted blob on 0G.
The KV layer materializes HEADs, vector indices, and grant records.
Branches, merges, time-travel replay, and cross-agent grants all work like Git primitives.

Built for the [0G Hackathon](https://build.0g.ai) — OpenClaw framework track.

---

## Why ZeroMem vs MemWal

| Feature | MemWal (Walrus/Sui) | ZeroMem (0G) |
|---|---|---|
| Storage | Walrus blob | 0G Log (append-only DAG) |
| Vector index | Postgres + pgvector | 0G KV (cosine shards) |
| History / branching | ❌ flat UUIDs | ✅ branch / fork / replay / blame |
| Agent-to-agent transfer | ❌ | ✅ grant / revoke (on-chain + KV event listener) |
| Embedding privacy | Leaks to OpenAI | ✅ 0G Compute (sealed inference) |
| KV rebuild after wipe | ❌ | ✅ `restore(tipCommitId)` walks DAG |
| Skills / procedural memory | ❌ | ✅ signed blobs + manifest |

---

## Quick start

```bash
git clone <repo>
cd zeromem
cp .env.example .env        # fill ZG_PRIVATE_KEY at minimum
npm install
cd packages/sdk && npm test # 59 unit tests, no network needed
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

### Branching (Git-style)

```ts
const draft = await mem.branch('experiment-v2');
await draft.remember('Trying a new approach...');

await mem.merge('experiment-v2');  // fast-forward main to draft
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

// Agent B reads from A's memory via the grant
const hits = await memB.recall("what did A learn?", { from: agentAAddress });

// Revoke any time — fires on-chain event → KV entry purged
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
const pastHits = await snapshot.recall('what did agent know on Tuesday?');
// snapshot is read-only — frozen: true
```

### KV restore after wipe

```ts
// After KV is wiped — blobs on 0G are permanent
const tipCommitId = '0x...'; // last known commitId (from logs / local backup)
await mem.restore('main', { tipCommitId });
// Walks DAG, rebuilds vector index, head, branches
```

### OpenClaw / Vercel AI drop-in

```ts
import { withZeroMem } from '@zeromem/openclaw';

const model = withZeroMem(openai('gpt-4'), { mem, autoCapture: true });
// Before each call: top-k memories injected into system prompt
// After each call:  response auto-remembered
```

### Skills (procedural memory)

```ts
await mem.skills.add({
  name: 'summarize',
  code: `return { summary: input.text.split('\\n').slice(0,3).join(' | ') };`,
  schema: {},
});
const result = await mem.skills.run('summarize', { text: 'line1\nline2\nline3' });
```

---

## Architecture

```
OpenClaw Agent (TS)
├─ planner   (hierarchical, sealed inference)
├─ reflector (Episodic → Semantic compaction)
└─ ZeroMem SDK
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  @zeromem/sdk                               │
  │  client.ts    — ZeroMem class (public API)  │
  │  commit.ts    — DAG node build/sign/verify  │
  │  storage.ts   — 0G upload/download/KV       │
  │  kv-views.ts  — all KV key namespaces       │
  │  vector.ts    — cosine search over KV shards│
  │  git.ts       — branch/fork/merge/replay    │
  │  grant.ts     — grant/revoke + event listen │
  │  inference.ts — 0G Compute proxy            │
  │  skills.ts    — signed skill blobs          │
  └────────────────┬───────────────────────────┘
                   │ 0G Storage SDK    │ 0G Compute
                   ▼                   ▼
           Log layer + KV         qwen-2.5-7b-instruct
                   │
                   ▼
       GrantRegistry.sol  (0G EVM, chain 16602)
```

### Commit format (DAG node stored as encrypted blob)

```
ZeroCommit {
  version:       1
  parent:        rootHash | null        ← DAG link
  agent_id:      string                 ← agentId passed to ZeroMem.create()
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

| Key pattern | Value | Written by |
|---|---|---|
| `head/{agentId}/{branch}` | latest commitId | every `remember/reflect/grant/forget` |
| `root/{agentId}/{branch}` | first commitId (write-once) | first `remember` |
| `idx/{agentId}/{branch}/{ns}/count` | integer item count | every `remember` |
| `idx/{agentId}/{branch}/{ns}/v/{shard}` | JSON vector shard | every `remember` |
| `skill/{agentId}/{name}` | blob rootHash | `skills.add()` |
| `skill/{agentId}/__manifest__` | JSON name list | `skills.add()` |
| `grant/{from}/{to}/{scope}` | `{grantId, ttl, granterAgentId}` | `grant()` |
| `grantidx/{grantId}` | `{from, to, scope}` | `grant()` — for revoke event lookup |
| `tomb/{agentId}/{commitId}` | `"1"` | `forget()` |
| `branches/{agentId}` | JSON branch list | `branch()` / `create()` |

All KV writes are on-chain transactions via `0G-KV Batcher`. Reads are off-chain via `KvClient`.

---

## Unit tests

```bash
cd packages/sdk
npm test
```

59 tests, zero network calls, run in ~10 seconds.

| Suite | Tests | Covers |
|---|---|---|
| `commit.test.ts` | 7 | build/sign/verify, tamper detection, encode/decode |
| `kv-views.test.ts` | 23 | all KV keys, grant index, manifest, tombstone, root anchor |
| `vector.test.ts` | 15 | cosine order, k-limit, shard overflow (257 entries), cross-shard search, merge |
| `client.test.ts` | 14 | remember/recall, tags, namespaces, log, branch isolation, merge, forget, reflect, plan, restore after KV wipe, grant |

---

## Project structure

```
zeromem/
├── .env.example
├── README.md
├── IMPLEMENTATION_PLAN.md
├── HANDOVER.md
├── packages/
│   ├── sdk/                        ← @zeromem/sdk
│   │   ├── src/
│   │   │   ├── client.ts           ← ZeroMem class (main entry point)
│   │   │   ├── commit.ts           ← DAG commit format + signing
│   │   │   ├── storage.ts          ← 0G upload/download/KV wrappers
│   │   │   ├── kv-views.ts         ← all KV key namespaces
│   │   │   ├── vector.ts           ← cosine similarity search over KV shards
│   │   │   ├── git.ts              ← branch/fork/merge/replay/blame
│   │   │   ├── grant.ts            ← grant/revoke + on-chain event listener
│   │   │   ├── inference.ts        ← 0G Compute proxy (embed/reflect/plan)
│   │   │   ├── skills.ts           ← procedural memory (signed blobs)
│   │   │   ├── types.ts            ← all TypeScript interfaces
│   │   │   └── __tests__/          ← 59 unit tests + MockStorageClient
│   │   └── jest.config.js
│   ├── contracts/                  ← GrantRegistry.sol (0G EVM)
│   │   ├── contracts/GrantRegistry.sol
│   │   ├── scripts/deploy.ts
│   │   └── hardhat.config.ts
│   ├── openclaw-plugin/            ← @zeromem/openclaw
│   │   └── src/index.ts            ← withZeroMem() + zeromemMiddleware()
│   └── relayer/                    ← optional HTTP service
│       └── src/index.ts
└── examples/
    ├── research-agent/             ← flagship 2-agent CLI demo
    │   └── src/index.ts
    └── visual-demo/                ← Next.js UI for demo video
        ├── app/page.tsx
        ├── app/api/zeromem/[action]/route.ts
        └── next.config.js
```

---

## Deploying to 0G testnet

### Step 1 — Get testnet tokens

```
https://faucet.0g.ai   (0.1 0G per wallet per day)
https://cloud.google.com/application/web3/faucet/0g/galileo
```

You need **two wallets** for the multi-agent grant demo.

### Step 2 — Fill `.env`

```bash
cp .env.example .env
# Required:
#   ZG_PRIVATE_KEY=0x...           (your main wallet)
#   RESEARCHER_PRIVATE_KEY=0x...   (for demo)
#   WRITER_PRIVATE_KEY=0x...       (for demo)
# Optional but recommended:
#   ZG_COMPUTE_PROVIDER=0x...      (from compute-marketplace.0g.ai/inference)
#   ZG_COMPUTE_ENDPOINT=https://...
#   GRANT_REGISTRY_ADDRESS=0x...   (after step 3)
```

### Step 3 — Deploy GrantRegistry

```bash
cd packages/contracts
npm install
npx hardhat compile
npm run deploy:testnet
# Paste the logged address into .env as GRANT_REGISTRY_ADDRESS
```

### Step 4 — Run research-agent demo

```bash
cd examples/research-agent
npm install
npm run dev
```

Watch the 14-step output: remember → recall → branch → grant → cross-agent recall → revoke → restore.

### Step 5 — Run visual demo UI

```bash
cd examples/visual-demo
npm install
npm run dev
# Open http://localhost:3000
```

Type a memory, press `mem.remember()`, then `mem.recall()` — watch the commit DAG build up.

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

---

## Verification checklist

- [x] Unit tests — 59/59 passing, no network
- [x] `remember()` → signed commit, ECIES blob, KV head + vector index updated
- [x] `recall()` → cosine similarity, branch-isolated namespaces
- [x] `branch()` / `merge()` — isolated vector index per branch, fast-forward merge
- [x] `forget()` → tombstone in KV, entry removed from search
- [x] `restore(tipCommitId)` → walks 0G DAG, rebuilds KV from scratch
- [x] `grant()` → granterAgentId stored, reverse-index for revoke events
- [x] `revoke()` → on-chain + KV cleanup, event listener auto-removes on future revokes
- [x] Skills → signed blobs, manifest in KV, `list()` / `run()`
- [x] GrantRegistry.sol compiled on 0G EVM
- [x] OpenClaw plugin — `withZeroMem()` + `zeromemMiddleware()`
- [ ] Testnet end-to-end run (needs funded wallets + `.env`)
- [ ] Sealed inference via 0G Compute (needs provider address)
- [ ] GrantRegistry deployed to Galileo (needs gas)
- [ ] Demo video recorded
