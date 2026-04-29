# ZeroMem — Git-for-Agent-Memory on 0G

> Versioned · Encrypted · Multi-Agent · Sealed-Inference-Native

ZeroMem is a **TypeScript SDK** that gives AI agents persistent, encrypted, versioned memory on **0G Storage** and optional **0G Compute** (sealed inference).

Every memory is a signed commit on an append-only DAG (ECIES-encrypted blob on 0G). The KV layer materializes HEADs, branch metadata, tombstones, and small vector **shards** (each entry holds a blob `rootHash`; embeddings live off-KV). With `postgresUrl` set, searches can use Postgres/pgvector instead of KV shards — useful for heavier deployments.

Branches, merges, replay, blame, grants, skills, restore, reflection, ask/plan flows, and an OpenClaw gateway plugin behave like Git + memory primitives.

For hosted setups, **`@zeromem/client`** can talk to the optional **`relayer/`** service; the relayer wires keys, 0G access, Postgres, and the engine (`@zeromem/sdk`).

Built for the [0G Hackathon](https://build.0g.ai) — OpenClaw framework track.

---

## What ZeroMem does

- **Stores** agent memories as signed, encrypted commits on 0G Storage — permanent and tamper-proof
- **Recalls** via cosine similarity (KV shards and/or Postgres when configured)
- **Branches** memory — fork, experiment, merge, diff, snapshots
- **Grants** cross-agent reads — time-limited, revocable (`GrantRegistry` + KV capsule keys)
- **Recovers** from KV loss by replaying the blob DAG (`restore()`)
- **OpenClaw** gateway plugin (`openclaw-zeromem`) for hooks + tools

| Feature | MemWal (Walrus/Sui) | ZeroMem (0G) |
|---|---|---|
| Storage | Walrus blob | 0G Log (append-only DAG) |
| Vector index | Postgres + pgvector | KV shards (`VectorRef`) and/or Postgres + pgvector |
| History / branching | ❌ flat UUIDs | ✅ branch / fork / replay / blame |
| Agent-to-agent transfer | ❌ | ✅ grant / revoke |
| Embedding privacy | Leaks to OpenAI | ✅ 0G Compute when configured |
| KV rebuild after wipe | ❌ | ✅ `restore(tipCommitId)` walks DAG |
| Skills / procedural memory | ❌ | ✅ signed blobs + manifest |

---

## Quick start

```bash
git clone <repo> && cd zeromem
cp .env.example .env        # fill ZG_PRIVATE_KEY at minimum
npm install
cd packages/sdk && npm test  # 59 unit tests, no network needed
```

### Client-first usage

```ts
import { ZeroMemClient } from '@zeromem/client';

const mem = ZeroMemClient.create({
  agentId: 'my-agent',
  serverUrl: process.env.ZEROMEM_RELAYER_URL ?? 'http://localhost:3001',
  namespace: 'default',
});

// Remember through the relayer
const { commitId } = await mem.remember('Alice prefers terse responses.');

// Recall through the relayer
const { hits } = await mem.recall('how should I respond to Alice?', { k: 5 });

// Ask = recall + LLM answer over retrieved memories
const { answer } = await mem.ask('How should I respond to Alice?', { k: 5 });
```

### Server engine

The **`relayer/`** app (optional) uses `@zeromem/sdk` internally for commits, uploads, Postgres when enabled, grants, restore, replay, capsuled keys for grants, etc.

### Postgres index

When **`postgresUrl`** is set, expect Postgres with **`pgvector`**. Rows reference encrypted payload blobs on 0G; `remember()` uploads the blob then indexes embeddings in Postgres instead of KV `VectorRef` shards (same API).

### Branching (Git-style)

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

### Ask — recall + answer

```ts
const result = await mem.ask('How should I respond to Alice?', { k: 5 });
console.log(result.answer);
console.log(result.hits);
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

### Restore after KV wipe

```ts
const tipCommitId = '0x...'; // last known commit root from logs / backup
await mem.restore('main', { tipCommitId });
// Walks 0G DAG → rebuilds vector entries + KV head/branch metadata
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

### OpenClaw (framework track)

```
OpenClaw Agent
├── before_prompt_build hook  ← recalled memories → system prompt
├── agent_end hook            ← auto-capture conversation to 0G
├── memory_search / memory_store tools
         │
         ▼
  @zeromem/openclaw-gateway (openclaw-zeromem)
         │
         ▼
  @zeromem/sdk  →  0G Log + KV  (+ optional Postgres/pgvector + 0G Compute)
         │
         ▼
  GrantRegistry.sol  (0G EVM)
```

### Client → relayer (optional hosted path)

```
App / Agent  →  @zeromem/client  →  relayer (ZeroMem HTTP)  →  @zeromem/sdk  →  0G + KV + Postgres (optional)
```

### How a memory write works

1. Text → `embed()` via 0G Compute (or local WASM fallback)
2. `{ text, embedding, ts, tags }` → ECIES-encrypted → uploaded to 0G Storage → `rootHash`
3. `ZeroCommit { parent, op:"remember", payload_root: rootHash, sig }` → signed with agent's Ethereum key → uploaded to 0G Storage → `commitId`
4. KV writes: `head/{agent}/{branch}` updated; vector shards append **`VectorRef`** rows (small JSON); full vectors live in blobs

### Commit format

```
ZeroCommit {
  version:       1
  parent:        rootHash | null        ← DAG link
  agent_id:      string
  author_pubkey: secp256k1 compressed
  op:            remember | plan | forget | skill_add | grant | revoke
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
| `head/{agentId}/{branch}` | latest commitId | commits that advance HEAD |
| `root/{agentId}/{branch}` | first commitId (write-once) | first `remember` |
| `idx/{agentId}/{branch}/{ns}/count` | item count | `remember` |
| `idx/{agentId}/{branch}/{ns}/v/{shard}` | JSON **`VectorRef[]`** (`commitId` + blob `rootHash`) | `remember` |
| `skill/{agentId}/{name}` | blob rootHash | `skills.add()` |
| `skill/{agentId}/__manifest__` | JSON name list | `skills.add()` |
| `grant/{from}/{to}/{scope}` | `{ grantId, ttl, granterAgentId }` (+ tier/capsule) | `grant()` |
| `grantidx/{grantId}` | `{ from, to, scope }` | `grant()` — revoke lookups |
| `tomb/{agentId}/{commitId}` | redaction marker | `forget()` |
| `branches/{agentId}` | branch names | branching APIs |

Writes go through **`0G-KV`** (batcher); reads use **`KvClient`** (with **`kvCache`** bridging short replay lag).

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
| `vector.test.ts` | 15 | cosine order, shard overflow / cross-shard search, merge, `VectorRef` path |
| `client.test.ts` | 14 | remember/recall, ask/reflect branches, namespaces, restore, grants, … |
| `hooks.test.ts` | — | `before_prompt_build`, `agent_end` |
| `security.test.ts` | — | injection detection, escape, shouldCapture |
| `tools.test.ts` | — | memory_search, memory_store |
| `namespace.test.ts` | — | session → namespace |

---

## Project structure

```
zeromem/
├── .env.example
├── IMPLEMENTATION_PLAN.md
├── HANDOVER.md
├── packages/
│   ├── client/                    ← @zeromem/client (HTTP client to relayer)
│   ├── sdk/                       ← @zeromem/sdk (engine)
│   ├── openclaw-zeromem/          ← OpenClaw gateway plugin
│   ├── openclaw-plugin/           ← Vercel AI `withZeroMem` wrapper
│   ├── contracts/                 ← GrantRegistry.sol + Hardhat
│   └── relayer/                   ← optional HTTP service
└── examples/
    ├── relayer-client/
    ├── research-agent/
    └── visual-demo/
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


## Verification checklist

- [x] Unit tests — SDK + openclaw-zeromem (no network required for mock suites)
- [x] `remember()` → signed commit + ECIES blob; KV shards / Postgres rows updated
- [x] `recall()` / `search()` — cosine over refs or Postgres
- [x] `ask()` — recall + LLM answer; `reflect()` episodic compaction
- [x] `branch()` / `merge()`
- [x] `forget()` / `gc()`
- [x] `restore(tipCommitId)` — walks DAG → rebuild indices
- [x] `grant()` / `revoke()` + GrantRegistry ABI
- [x] OpenClaw packages — hooks, tools (`openclaw-zeromem`), optional `openclaw-plugin`
- [ ] Testnet soak + funded wallets
- [ ] Sealed inference via marketplace provider
- [ ] Deployed GrantRegistry address in `.env`
- [ ] Recorded demo
