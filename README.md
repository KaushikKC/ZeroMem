# ZeroMem — Git-for-Agent-Memory on 0G

> Versioned · Encrypted · Multi-Agent · Sealed-Inference-Native

ZeroMem turns 0G Storage + Compute into a **Git-like memory layer for AI agents**.
Every memory is a signed commit on an append-only DAG, stored as an ECIES-encrypted blob on 0G.
The KV layer materializes HEADs, vector indices, and grant records.

Built for the [0G Hackathon](https://build.0g.ai) — OpenClaw framework track.

---

## Why ZeroMem vs MemWal

| Feature | MemWal (Walrus/Sui) | ZeroMem (0G) |
|---|---|---|
| Storage | Walrus blob | 0G Log (append-only DAG) |
| Vector index | Postgres + pgvector | 0G KV (HNSW shards) |
| History / branching | ❌ flat UUIDs | ✅ branch / fork / replay / blame |
| Agent-to-agent transfer | ❌ | ✅ grant / revoke (on-chain) |
| Embedding privacy | Leaks to OpenAI | ✅ 0G Compute (sealed inference) |
| KV rebuild | ❌ | ✅ `restore()` walks DAG |

---

## Quick Start

```bash
cp .env.example .env   # fill in ZG_PRIVATE_KEY + ZG_COMPUTE_ENDPOINT
npm install
npm run build
```

### Minimal usage

```ts
import { ZeroMem } from '@zeromem/sdk';

const mem = await ZeroMem.create({
  privateKey: process.env.ZG_PRIVATE_KEY,
  agentId: 'my-agent',
  branch: 'main',
});

// Store a memory — ECIES-encrypted, committed to 0G Log, KV index updated
const commitId = await mem.remember("Alice prefers terse responses.");

// Semantic recall — embedding via 0G Compute, search over KV vector index
const hits = await mem.recall("how should I respond to Alice?", { k: 5 });
```

### Multi-agent grant

```ts
// Agent A grants Agent B read access for 24h
const grantId = await memA.grant({ to: agentBAddress, scope: 'default', ttl: '24h' });

// Agent B reads from A's memory
const hits = await memB.recall("what did A learn?", { from: agentAAddress });

// Revoke any time
await memA.revoke(grantId);
```

### Branching

```ts
const draft = await mem.branch('experiment-v2');
await draft.remember("Trying a new approach...");
await mem.merge('experiment-v2');      // keep it
// or just drop the branch — main is untouched
```

### Reflector (episodic → semantic)

```ts
await mem.reflect({ since: '24h' });
// Reads recent 'remember' commits → sealed inference → 'reflect' commit written
```

### OpenClaw / Vercel AI SDK drop-in

```ts
import { withZeroMem } from '@zeromem/openclaw';

const model = withZeroMem(openai('gpt-4'), { mem, autoCapture: true });
// auto-recall injected to system prompt, auto-remember after response
```

---

## Architecture

```
OpenClaw Agent (TS)
├─ planner  (hierarchical, sealed inference)
├─ reflector (Episodic→Semantic compaction)
└─ ZeroMem SDK
        │
        ▼
  ┌─────────────────────────────────────┐
  │  ZeroMem SDK                        │
  │  commit.ts   — build/sign/verify    │
  │  storage.ts  — 0G upload/download   │
  │  kv-views.ts — head/idx/grant/skill │
  │  vector.ts   — cosine over KV shards│
  │  git.ts      — branch/fork/replay   │
  │  grant.ts    — grant/revoke + EVM   │
  │  inference.ts— 0G Compute proxy     │
  └──────────┬──────────────────────────┘
             │ 0G Storage SDK          │ 0G Compute
             ▼                         ▼
         Log layer + KV           qwen-2.5-7b-instruct
             │
             ▼
     GrantRegistry.sol (0G EVM, chain 16602)
```

### Commit format (DAG node)

```
ZeroCommit {
  version:      1
  parent:       rootHash | null
  agent_id:     EVM address
  author_pubkey secp256k1 compressed
  op:           remember | reflect | forget | skill_add | grant | revoke
  branch:       string
  namespace:    string
  payload_root: rootHash (ECIES-encrypted blob on 0G)
  metadata:     { ts, embedding_dim, tags }
  sig:          secp256k1 over all above
}
```

### KV materialized views

| Key | Value |
|---|---|
| `head/{agent}/{branch}` | latest commit root hash |
| `idx/{agent}/{ns}/v/{shard}` | vector shard JSON |
| `skill/{agent}/{name}` | signed skill blob root |
| `grant/{from}/{to}/{scope}` | grantId + ttl |
| `tomb/{agent}/{commit}` | redaction marker |
| `branches/{agent}` | branch list JSON |

---

## Project Structure

```
zeromem/
├── packages/
│   ├── sdk/              # @zeromem/sdk — core TypeScript SDK
│   ├── contracts/        # GrantRegistry.sol + Hardhat (0G EVM)
│   ├── openclaw-plugin/  # @zeromem/openclaw — Vercel AI drop-in
│   └── relayer/          # Optional self-hosted HTTP relayer
└── examples/
    ├── research-agent/   # Multi-agent end-to-end demo
    └── visual-demo/      # Next.js UI (for demo video)
```

---

## Deployment

### 1. Get testnet tokens

```
https://faucet.0g.ai  (0.1 0G/day)
```

### 2. Deploy GrantRegistry

```bash
cd packages/contracts
npm install
npx hardhat compile
npm run deploy:testnet
# Copy the address to .env GRANT_REGISTRY_ADDRESS=0x...
```

### 3. Run the research-agent demo

```bash
cd examples/research-agent
npm install
npm run dev
```

### 4. Run the visual demo

```bash
cd examples/visual-demo
npm install
npm run dev
# Open http://localhost:3000
```

---

## Testnet config

| Parameter | Value |
|---|---|
| Network | 0G Galileo Testnet |
| Chain ID | 16602 |
| RPC | `https://evmrpc-testnet.0g.ai` |
| Storage Indexer | `https://indexer-storage-testnet-turbo.0g.ai` |
| Flow Contract | `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296` |
| Explorer | `https://chainscan-galileo.0g.ai` |
| Storage Explorer | `https://storagescan-galileo.0g.ai` |

---

## Verification checklist

- [ ] `remember()` → blob on 0G, KV head updated, vector index updated
- [ ] `recall()` → cosine similarity over KV shards
- [ ] `branch()` / `merge()` on testnet
- [ ] `grant()` / `revoke()` — two wallets, cross-agent recall
- [ ] GrantRegistry deployed on 0G EVM; events trigger KV updates
- [ ] `restore()` — wipe KV, rebuild from Log
- [ ] Sealed inference (embed + reflect) via 0G Compute
- [ ] OpenClaw plugin parity with MemWal `oc-memwal`
- [ ] End-to-end research-agent demo recordable
