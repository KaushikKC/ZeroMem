# ZeroMem — Persistent Agent Memory on 0G

> Versioned · Encrypted · Multi-Agent · Web2 + Web3 Native

ZeroMem gives AI agents **persistent, versioned, encrypted memory** backed by the 0G decentralised network. Think of it as **Git for agent memory**: every write is a signed commit on an append-only DAG, agents can branch and merge their memory, and no memory is ever permanently lost — even if your database is wiped, full recovery is one call away from the chain.

---

## ZeroMem as a framework primitive

ZeroMem is designed to be **framework-agnostic at the core and framework-native at the edge**. The `@zeromem/sdk` engine has no opinion about what orchestrates agents — it exposes a clean TypeScript API that any agentic framework can wrap.

The plugin layer is thin and explicit: a factory function, a hooks object, a tools array. Any framework that follows a similar plugin contract can get a first-class ZeroMem integration:

```
                        @zeromem/sdk
                     (framework-agnostic core)
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
@zeromem/openclaw-    @zeromem/nemoclaw-    @zeromem/<any-framework>
gateway               (hypothetical)        — same pattern:
(OpenClaw plugin)     hooks + tools          factory → hooks + tools
```

**OpenClaw** is the first integration — `before_prompt_build` / `agent_end` hooks, `memory_search` / `memory_store` tools, loaded via `openclaw.plugin.json`.

**NemoClaw or any future framework** would follow the same pattern: implement a factory that returns a `{ hooks, tools, manifest }` object shaped to that framework's plugin contract, backed by the same `@zeromem/sdk` engine underneath. No changes to the SDK required — only a new thin adapter package.

**The Vercel AI SDK wrapper** (`@zeromem/openclaw`) shows this already works across different paradigms: a `Proxy`-based approach for `generateText` / `streamText`, using the same SDK.

**The relayer** extends this further — any language, any framework, zero SDK dependency. Web2 products get the same memory primitives over plain HTTP.

This means ZeroMem's memory model (signed commits, branching, grants, restore, skills) is a **reusable substrate** — not tied to any single orchestration layer. Build on top of it with your framework of choice.

---

## The problem ZeroMem solves

Most agent memory systems are a Postgres table or a Redis cache you manage yourself. They have no version history, no cross-agent sharing, no cryptographic proof of existence, and they vanish when you wipe the server.

ZeroMem solves all of this by splitting memory into two complementary layers:

- **Web3 layer (0G Storage + 0G KV)** — every memory is an ECIES-encrypted blob committed to 0G Storage. Content-addressed, append-only, permanent. The KV layer maintains HEAD pointers and vector index shards so agents can look up their latest state instantly without scanning blobs.
- **Web2 layer (Postgres/pgvector)** — when `POSTGRES_URL` is configured, embeddings land in a local pgvector table for sub-millisecond semantic search. Blobs still go to 0G regardless — you get web3 permanence with web2 speed.

You can start with just Postgres (pure web2), add 0G KV for on-chain index persistence, and the storage layer is always on-chain from day one. No lock-in, incremental migration.

---

## How a memory write works

When an agent calls `remember("Alice prefers terse replies")`:

```
1.  Text → embed()           InferenceClient calls 0G Compute (or local fallback)
                              → 384-dim float vector

2.  Encrypt payload          { text, embedding, ts, tags } → ECIES-encrypted with
                              agent's Ethereum wallet public key

3.  Upload to 0G Storage     Returns rootHash (content address of encrypted blob)

4.  Build ZeroCommit         { parent: prevCommitHash, op: "remember",
                               payload_root: rootHash, agentId, branch,
                               namespace, metadata: { ts, tags } }
                              Signed with agent's secp256k1 key

5.  Upload commit to 0G      Returns commitId (content address of the commit blob)

6.  Update KV                head/{agentId}/{branch}  → commitId
                              idx/{agentId}/{branch}/{ns}/v/{shard} → VectorRef[]
```

When an agent calls `recall("how should I respond to Alice?")`:

```
1.  Embed query              Same InferenceClient
2.  Load vector shards       KV or Postgres rows — each holds commitId + blob rootHash
3.  Cosine similarity        Score against all stored vectors
4.  Fetch top-k blobs        Download + decrypt payload blobs from 0G Storage
5.  Return ranked hits       { text, score, commitId, ts, tags }[]
```

---

## Features at a glance

### Core memory

| Method | What it does |
|---|---|
| `remember(text, opts?)` | Encrypt + commit text to 0G. Returns `commitId`. |
| `recall(query, opts?)` | Semantic similarity search. Returns ranked `{ text, score, commitId }[]`. |
| `ask(question, opts?)` | Recall top-k memories then call an LLM to answer. Returns `{ answer, hits }`. |
| `search(opts)` | Filtered recall — by `tags`, `since` (time window), `minScore`, `recencyWeight`. |
| `forget(commitId)` | Tombstone a single commit. Excludes it from all future searches. |
| `forgetBulk(opts)` | Tombstone by tag, namespace, or age in one call. |
| `gc()` | Remove tombstoned entries from KV / Postgres. Reclaims storage. |

### Git-style versioning

| Method | What it does |
|---|---|
| `branch(name)` | Fork the current HEAD into a new named branch. |
| `merge(sourceBranch, opts?)` | Fast-forward or reflect-merge a branch back into the current one. |
| `diff(branchA, branchB)` | Show commits unique to each branch and where they diverged. |
| `snapshot(name)` | Tag the current HEAD with a name (like a git tag). |
| `checkout(name)` | Return a frozen read-only ZeroMem at the named snapshot. |
| `replay({ at: commitId })` | Time-travel: read-only view of memory at any past commit. |
| `blame(keyword)` | Walk the DAG to find the first commit that introduced a keyword. |
| `log(opts?)` | Full commit history from HEAD to genesis, optionally limited. |

### Multi-agent grants

| Method | What it does |
|---|---|
| `grant({ to, toPubKey, scope, ttl })` | Grant another agent scoped read access. Writes to `GrantRegistry.sol` on 0G EVM. Uses ECDH key-wrapping (MemoryCapsule) — recipient decrypts the granter's AES key with their own private key. No shared secret ever transmitted. |
| `revoke(grantId)` | Cancel a grant. Fires an on-chain event; KV entry auto-purged. |
| `batchGrant(recipients[])` | Grant multiple wallets in a single call. |
| `recall(query, { from: address })` | Read another agent's memories using a valid grant. |
| `createChallenge()` / `verifyChallenge()` | Challenge-response flow — cryptographically verify the recipient controls the target wallet before granting. |

### System operations

| Method | What it does |
|---|---|
| `stats()` | Agent overview: branches, namespaces, memory count, HEAD commitId. |
| `reflect(opts?)` | Episodic → semantic compaction. LLM summarises recent memories and writes a `[reflect]` commit. |
| `prove(commitId)` | Returns a two-signature Merkle attestation: the original commit sig + a fresh attestation sig, with a link to the blob on 0G StorageScan. |
| `restore(branch, opts?)` | Rebuild the KV vector index by walking the 0G blob DAG from a known tipCommitId. Full recovery from chain after any data loss. |
| `skills.add(name, fn)` | Upload a procedural skill as a signed blob to 0G + write manifest to KV. |
| `skills.run(name, input)` | Fetch skill blob, verify signature, execute. |
| `plan(goal)` | Break a goal into a hierarchical task tree, stored as a commit. |
| `completePlanTask(commitId, taskId)` | Mark a plan task done. |

---

## Components

ZeroMem is a monorepo. Each package has a distinct role. Here is what each one is and when you use it.

---

### `packages/sdk` — `@zeromem/sdk`

**The core engine.** All memory logic lives here. Every other package depends on it.

The SDK is built from these internal modules:

| Module | Responsibility |
|---|---|
| `client.ts` | `ZeroMem` class — the public API surface: remember, recall, ask, branch, merge, grant, etc. |
| `commit.ts` | Build, sign, encode, decode, and verify `ZeroCommit` objects. Walks the DAG for log/blame/restore. |
| `storage.ts` | `StorageClient` — wraps the 0G Storage JS SDK. Uploads blobs, fetches by rootHash, locates storage nodes. |
| `kv-views.ts` | `KvViews` — all KV read/write patterns (head, index shards, grants, tombstones, skills manifest, branches). |
| `vector.ts` | `VectorIndex` — cosine similarity search over KV `VectorRef` shards. |
| `pg-index.ts` | `PostgresVectorIndex` — same interface as `VectorIndex` but backed by pgvector. Used when `POSTGRES_URL` is set. |
| `memory-index.ts` | `MemoryIndex` interface — swap KV shards ↔ Postgres transparently. |
| `inference.ts` | `InferenceClient` — generates embeddings via 0G Compute or a local WASM fallback. |
| `grant.ts` | `GrantManager` — grant/revoke/verify via `GrantRegistry.sol` ABI + ECDH capsule key wrapping. |
| `acl.ts` | ECIES encrypt/decrypt, AES-GCM symmetric key derivation, challenge-response helpers. |
| `git.ts` | Branch, merge (fast-forward + reflect), diff, blame, log — all operate on the commit DAG. |
| `skills.ts` | `SkillsManager` — upload/run/list procedural skill blobs. |
| `errors.ts` | Typed errors: `ZeroMemFrozenError`, `ZeroMemGrantNotFoundError`, `ZeroMemGrantExpiredError`, `ZeroMemNoTipError`. |
| `types.ts` | Shared TypeScript types and defaults: `ZeroCommit`, `RecallResult`, `AskResult`, `SearchOpts`, etc. |

**Use `@zeromem/sdk` directly** when you control the server environment (Node.js), hold the private key, and want the full API without an HTTP hop.

```ts
import { ZeroMem } from '@zeromem/sdk';

const mem = await ZeroMem.create({
  privateKey: process.env.ZG_PRIVATE_KEY,
  agentId: 'my-agent',
  branch: 'main',
  rpcUrl: process.env.ZG_RPC,
  indexerUrl: process.env.ZG_INDEXER,
  kvUrl: process.env.ZG_KV_URL,
  postgresUrl: process.env.POSTGRES_URL,   // optional
  grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  openrouterApiKey: process.env.OPENAI_API_KEY,
  openrouterModel: process.env.LLM_MODEL,
});

const commitId = await mem.remember('Deploy only on Tuesdays.');
const { hits } = await mem.recall('deployment rules', { k: 3 });
const { answer } = await mem.ask('When can I deploy?');
```

---

### `packages/openclaw-zeromem` — `@zeromem/openclaw-gateway`

**The OpenClaw framework plugin.** Drop this into any OpenClaw agent and it gains persistent memory with zero manual wiring. This is the primary integration point for the hackathon track.

The plugin exposes two **hooks** (auto-wired into the agent lifecycle) and two **tools** (callable by the LLM at runtime).

#### Hooks

**`before_prompt_build`** — fires before every LLM call.

What it does internally:
1. Embeds the incoming prompt query
2. Recalls top-k memories from 0G (cosine similarity)
3. HTML-escapes all memory content (injection prevention)
4. Wraps results in a `<zeromem-memories>` block
5. Prepends to the system context so the LLM sees relevant history before answering
6. Appends a namespace instruction: `"When calling memory_search or memory_store, use namespace=..."` so the LLM uses the right scope

**`agent_end`** — fires after every agent response.

What it does internally:
1. Takes the last N messages from the conversation
2. Strips any `<zeromem-memories>` blocks from message content (don't re-store injected memories)
3. Runs `shouldCapture` filter: skips filler phrases, messages shorter than 20 chars, detected prompt injections
4. Stores meaningful turns as memories on 0G Storage

#### Tools

**`memory_search`** — the LLM calls this when it decides it needs to look something up.
- Parameters: `query` (string), `limit` (number, default 5), `namespace` (string)
- Returns: formatted string listing found memories with relevance scores
- Safety: validates input, rejects injection patterns

**`memory_store`** — the LLM calls this when it decides something is worth remembering.
- Parameters: `text` (string), `namespace` (string)
- Returns: confirmation string with truncated commitId
- Safety: validates text length, rejects injection patterns before writing to 0G

#### Setup

```ts
import { createZeroMemPlugin } from '@zeromem/openclaw-gateway';

const plugin = await createZeroMemPlugin({
  privateKey: process.env.ZG_PRIVATE_KEY,
  agentId: 'my-agent',
  defaultNamespace: 'default',
  rpc: process.env.ZG_RPC,
  indexer: process.env.ZG_INDEXER,
  kvUrl: process.env.ZG_KV_URL,
  postgresUrl: process.env.POSTGRES_URL,
  grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  openrouterApiKey: process.env.OPENAI_API_KEY,
  openrouterModel: process.env.LLM_MODEL,
  autoRecall: true,    // inject memories before every prompt automatically
  autoCapture: true,   // save conversation turns to 0G automatically
  minRelevance: 0.1,   // only inject memories above this cosine score
});

// Register with OpenClaw
agent.use(plugin);

// Or drive manually
const ctx = await plugin.hooks.before_prompt_build({
  prompt: 'How should I review this PR?',
  sessionKey: 'session-1',
  agentName: 'reviewer',
});
// ctx.prependContext  — the <zeromem-memories> block to inject
// ctx.appendSystemContext — namespace instruction for tools

await plugin.hooks.agent_end({
  messages: [
    { role: 'user', content: 'Review the auth PR.' },
    { role: 'assistant', content: 'Found 3 issues: ...' },
  ],
  sessionKey: 'session-1',
  agentName: 'reviewer',
});
```

#### Manifest config (`openclaw.json`)

```json
{
  "plugins": ["@zeromem/openclaw-gateway"],
  "zeromem": {
    "privateKey": "${ZG_PRIVATE_KEY}",
    "agentId": "my-agent",
    "grantRegistryAddress": "${GRANT_REGISTRY_ADDRESS}",
    "autoRecall": true,
    "autoCapture": true,
    "maxRecallResults": 5,
    "minRelevance": 0.3
  }
}
```

---

### `packages/openclaw-plugin` — `@zeromem/openclaw`

**Vercel AI SDK wrapper.** Wraps any Vercel AI SDK model with ZeroMem memory hooks using a `Proxy` — so it's a drop-in with no changes to your existing `generateText` / `streamText` calls.

```ts
import { withZeroMem, zeromemMiddleware } from '@zeromem/openclaw';

// Drop-in model wrapper
const model = withZeroMem(openai('gpt-4o'), {
  mem,
  autoRecall: true,   // inject recalled memories into system prompt before every generate
  autoCapture: true,  // save LLM responses as memories after every generate
  topK: 5,
  ns: 'default',
});

const { text } = await generateText({ model, prompt: 'What do you know about deployments?' });

// Or as middleware in the experimental_transform pipeline
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: '...',
  experimental_transform: zeromemMiddleware({ mem, autoRecall: true, autoCapture: true }),
});
```

`withZeroMem` proxies `doGenerate` and `doStream` — before calling the underlying model it embeds the latest user message, recalls top-k memories, and prepends them as a system message. After the call it captures the response text as a new memory.

---

### `packages/client` — `@zeromem/client`

**Lightweight HTTP client for the relayer.** Use this when your agent code does NOT hold a private key and talks to a hosted relayer instead. Language-agnostic interface — all calls are plain HTTP internally.

```ts
import { ZeroMemClient } from '@zeromem/client';

const mem = ZeroMemClient.create({
  agentId: 'my-agent',
  serverUrl: 'http://localhost:3001',
  namespace: 'default',
  branch: 'main',
  timeoutMs: 180_000,   // chain writes take 30–90s — generous timeout is important
});

const { commitId } = await mem.remember('Deploy only on Tuesdays.');
const { hits } = await mem.recall('deployment rules', { k: 3 });
const { answer } = await mem.ask('When can I deploy?');
const draft = await mem.branchOff('experiment');  // returns a new client on the new branch
await mem.merge('experiment', { strategy: 'fast-forward' });
const { grantId } = await mem.grant({ to: '0x...', scope: 'default', ttl: '24h' });
await mem.revoke(grantId);
```

Typed response interfaces: `RememberResponse`, `RecallResponse` (with `RecallHit[]`), `AskResponse`, `LogResponse`, `BlameResponse`, `GrantResponse`, `PlanResponse`.

---

### `packages/contracts` — `@zeromem/contracts`

**`GrantRegistry.sol`** deployed on 0G Galileo EVM (`0xAa14A95b037b76B0D9CDfD5b34492138273057ec`).

What it does:
- Records grants on-chain: `(from, to, scope, ttl, tier)` with a `grantId`
- Emits `GrantCreated` / `GrantRevoked` events — the SDK listens for revocation to auto-purge KV entries
- Stores a `capsuleHash` — fingerprint of the ECDH-wrapped AES key so the on-chain record proves the grant was set up correctly

Deploy your own:
```bash
cd packages/contracts
npm install && npx hardhat compile
npm run deploy:testnet
# Paste the logged address into .env as GRANT_REGISTRY_ADDRESS
```

---

### `relayer/` — ZeroMem Relayer

**Self-hosted HTTP gateway.** The relayer sits between your existing product and the 0G network, handling every 0G concern — key management, blob uploads, KV writes, Postgres indexing, grant verification — so your product never needs to touch a private key or a blockchain RPC directly.

This is the **primary onboarding path for web2 products** moving to 0G:

- **Any language, any stack** — Python, Ruby, Go, PHP — one HTTP call and your service has persistent decentralised agent memory.
- **No key exposure** — private keys stay on the relayer. Clients send only `agentId` and content.
- **No blockchain knowledge needed** — teams call `/remember` and `/recall` like any REST API. The relayer handles blobs, commitIds, KV shards, and chain writes transparently.
- **Incremental migration path** — run with only `POSTGRES_URL` set for pure web2 speed. Add `ZG_KV_URL` to persist the index on-chain. Blobs land on 0G Storage regardless from day one — you get web3 permanence without changing any client code.
- **Multi-agent, zero config** — each `agentId` in the request body gets its own isolated `ZeroMem` instance. No per-agent setup required. Instances are cached in memory after first creation.

```
Your app (Python / Ruby / Go / JS)
         │
         │  POST /remember  { agentId, branch?, text, ns?, tags? }
         │  POST /recall    { agentId, branch?, query, k?, ns?, from? }
         │  ... plain HTTP
         ▼
  ZeroMem Relayer  (Node.js, :3001)
         │  holds ZG_PRIVATE_KEY
         │  manages ZeroMem instances per agentId+branch
         │  picks Postgres or KV per env config
         ▼
  0G Storage · 0G KV · Postgres/pgvector · GrantRegistry.sol
```

#### Full API reference

| Method | Endpoint | Request body | Response |
|---|---|---|---|
| `GET` | `/health` | — | `{ status: "ok", ts: number }` |
| `POST` | `/remember` | `{ agentId, branch?, text, ns?, tags? }` | `{ commitId }` |
| `POST` | `/recall` | `{ agentId, branch?, query, k?, ns?, from? }` | `{ hits: RecallHit[] }` |
| `POST` | `/ask` | `{ agentId, branch?, question, k?, ns?, from? }` | `{ answer, hits: RecallHit[] }` |
| `POST` | `/branch` | `{ agentId, branch?, name }` | `{ branch: name }` |
| `POST` | `/merge` | `{ agentId, branch?, sourceBranch, strategy? }` | `{ ok: true }` |
| `POST` | `/log` | `{ agentId, branch?, limit? }` | `{ entries: LogEntry[] }` |
| `POST` | `/blame` | `{ agentId, branch?, keyword }` | `{ matches: BlameEntry[] }` |
| `POST` | `/restore` | `{ agentId, branch?, tipCommitId? }` | `{ ok: true }` |
| `POST` | `/grant` | `{ agentId, branch?, to, toPubKey?, scope, ttl }` | `{ grantId }` |
| `POST` | `/revoke` | `{ agentId, branch?, grantId }` | `{ ok: true }` |
| `POST` | `/plan` | `{ agentId, branch?, goal }` | `{ plan: { goal, commitId, tasks[] } }` |

**`RecallHit`**: `{ text, score, commitId, ts, tags[] }`  
**`LogEntry`**: `{ commitId, commit: { op, branch, namespace, metadata: { ts, tags } } }`  
**`BlameEntry`**: `{ commitId, ts, op }`

#### Call from any language

```python
import requests

BASE = "http://localhost:3001"

# Store a memory
requests.post(f"{BASE}/remember", json={
    "agentId": "support-bot",
    "text": "User prefers email over Slack for updates.",
    "tags": ["preference"]
})

# Semantic recall on the next conversation
r = requests.post(f"{BASE}/recall", json={
    "agentId": "support-bot",
    "query": "how does this user prefer to be contacted?",
    "k": 3
})
for hit in r.json()["hits"]:
    print(f"[{hit['score']:.0%}] {hit['text']}")

# Ask — recall + LLM answer
r = requests.post(f"{BASE}/ask", json={
    "agentId": "support-bot",
    "question": "What communication preference does this user have?",
})
print(r.json()["answer"])
```

```bash
# curl
curl -s -X POST http://localhost:3001/remember \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"my-agent","text":"Deploy only on Tuesdays."}'

curl -s -X POST http://localhost:3001/recall \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"my-agent","query":"deployment schedule","k":3}'
```

#### Start

```bash
cd relayer
cp ../.env .env
npm run dev   # :3001
```

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Integration layer (pick one or more)                                │
│                                                                      │
│  OpenClaw agent          Vercel AI SDK app       Any language        │
│  @zeromem/openclaw-      @zeromem/openclaw        via HTTP           │
│  gateway (hooks+tools)   (Proxy wrapper)          (relayer REST)     │
└────────────┬──────────────────┬──────────────────────┬──────────────┘
             │                  │                       │
             ▼                  ▼                       ▼
      (direct SDK)        (direct SDK)          @zeromem/client
             │                  │                       │
             └──────────────────┴───────────────────────┘
                                │
                                ▼
                       @zeromem/sdk  (engine)
                        ┌─────────────────────────────┐
                        │  commit · kv-views · vector  │
                        │  storage · inference · grant │
                        │  git · acl · skills          │
                        └──────┬──────────────┬────────┘
                               │              │
                    ┌──────────┘              └──────────┐
                    ▼                                    ▼
           0G Network                           Web2 index
           ├─ 0G Storage (blobs)                └─ Postgres/pgvector
           ├─ 0G KV (head+index)                   (optional, fast search)
           ├─ 0G Compute (embeddings)
           └─ GrantRegistry.sol (0G EVM)
```

---

## Prerequisites

| Requirement | Purpose | Notes |
|---|---|---|
| Node.js ≥ 18 | Runtime for all packages | |
| Docker | Postgres/pgvector | `docker compose up -d` in `infra/postgres/` |
| 0G testnet wallet | Sign commits + pay storage fees | Fund at [faucet.0g.ai](https://faucet.0g.ai) — 0.1 0G/wallet/day |
| `zgs_kv` binary | Local KV node for on-chain index | Optional — falls back to in-memory if absent |
| OpenRouter API key | `ask()` / `reflect()` LLM calls | Any OpenRouter-compatible key works |

---

## Running Everything

### 1. Clone and install

```bash
git clone <repo> && cd zeromem
npm install
```

### 2. Configure environment

```bash
cat > .env <<'EOF'
ZG_RPC=https://evmrpc-testnet.0g.ai
ZG_INDEXER=https://indexer-storage-testnet-turbo.0g.ai
ZG_KV_URL=http://localhost:6789
POSTGRES_URL=postgres://postgres:postgres@localhost:5433/zeromem

ZG_PRIVATE_KEY=0x<your-key>
RESEARCHER_PRIVATE_KEY=0x<researcher-key>
WRITER_PRIVATE_KEY=0x<writer-key>

GRANT_REGISTRY_ADDRESS=0xAa14A95b037b76B0D9CDfD5b34492138273057ec

OPENAI_API_KEY=<openrouter-key>
OPENAI_API_BASE=https://openrouter.ai/api/v1
LLM_MODEL=nvidia/nemotron-3-super-120b-a12b:free
EOF

cp .env examples/openclaw-demo/.env
cp .env examples/research-agent/.env
cp .env relayer/.env
cp .env examples/visual-demo/.env.local
```

### 3. Start Postgres

```bash
docker compose -f infra/postgres/docker-compose.yml up -d
# Postgres listens on localhost:5433
```

### 4. Start local KV node (optional)

Enables full on-chain KV persistence. Without it, ZeroMem falls back to in-memory KV for the session — blobs still land on 0G Storage, and `restore()` rebuilds the index after restart.

```bash
# Download binary (linux)
wget https://github.com/0gfoundation/0g-storage-kv/releases/download/v1.5.1/zgs_kv_linux.zip
unzip zgs_kv_linux.zip -d infra/zgs-kv/
chmod +x infra/zgs-kv/zgs_kv

# Generate config from .env (derives stream_id from wallet address)
bash infra/zgs-kv/setup.sh

# Run
cd infra/zgs-kv && ./zgs_kv --config config.toml &
# Listens on localhost:6789
```

### 5. Build

```bash
npm run build
```

### 6. Run tests

```bash
cd packages/sdk && npm test                # 59 tests — core SDK (no network)
cd packages/openclaw-zeromem && npm test   # 34 tests — plugin (no network)
```

---

## Examples

### OpenClaw plugin e2e

Exercises the full plugin against a real 0G deployment.

```bash
cd examples/openclaw-demo && npm run dev
```

```
1. Plugin created           ✓  tools: memory_search, memory_store
2. Memories seeded          ✓  2 commits on 0G Storage
3. before_prompt_build      ✓  pgvector/stack memory injected into context
4. memory_search tool       ✓  41% / 9% relevance
5. memory_store tool        ✓  blob committed to 0G
6. agent_end hook           ✓  conversation captured
7. mem.ask()                ✓  LLM answered using 4 memories as context
8. Commit log               ✓  4 [remember] commits on-chain
=== Demo complete ===
```

---

### Research agent (two-agent grant flow)

CLI demo — Researcher stores memories, grants Writer read access, Writer recalls cross-agent, Researcher revokes.

```bash
cd examples/research-agent && npm run dev
```

Covers: `remember` → `branch` → `recall` → `reflect` → `plan` → `grant` → cross-agent recall → `revoke` → `restore` → `skills`.

---

### Visual demo (full UI)

Next.js interactive playground at `http://localhost:3000` for all 26 features across 6 flows.

```bash
cd examples/visual-demo && npm run dev
```

| Flow | Features covered |
|---|---|
| Core Memory | remember, recall, ask, search with filters, forget, bulk forget, GC |
| Git | branch, merge, diff, blame, snapshot, time-travel replay |
| Grants | grant, revoke, cross-agent recall, challenge-response, batch grant |
| System | stats, reflect, prove (Merkle + StorageScan link), restore |
| Skills & Plans | add skill, run skill, hierarchical plan + task completion |
| Batch Grant | grant multiple wallets in one call |

---

### Relayer

```bash
cd relayer && npm run dev   # :3001
```

---

## Project structure

```
zeromem/
├── packages/
│   ├── sdk/                ← @zeromem/sdk — core engine (all memory logic)
│   ├── openclaw-zeromem/   ← @zeromem/openclaw-gateway — OpenClaw hooks + tools
│   ├── openclaw-plugin/    ← @zeromem/openclaw — Vercel AI SDK wrapper
│   ├── client/             ← @zeromem/client — HTTP client for relayer
│   └── contracts/          ← GrantRegistry.sol + Hardhat
├── examples/
│   ├── openclaw-demo/      ← OpenClaw e2e (start here)
│   ├── research-agent/     ← two-agent CLI demo
│   └── visual-demo/        ← Next.js UI at localhost:3000
├── relayer/                ← self-hosted HTTP gateway
└── infra/
    ├── postgres/           ← docker-compose pgvector
    └── zgs-kv/             ← zgs_kv config + setup script
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
| GrantRegistry | `0xAa14A95b037b76B0D9CDfD5b34492138273057ec` |
| Chain Explorer | `https://chainscan-galileo.0g.ai` |
| Storage Explorer | `https://storagescan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai` (0.1 0G/wallet/day) |
