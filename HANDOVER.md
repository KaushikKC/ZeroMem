# ZeroMem — Handover Document

**Date:** 2026-05-01  
**Project:** ZeroMem — Git-for-Agent-Memory on 0G  
**Hackathon:** 0G OpenClaw Framework Track  
**Status:** Core SDK complete · UI live · Tests passing · KV node temporarily down (in-memory fallback active)

---

## What is this project?

ZeroMem is a **TypeScript SDK** that gives AI agents persistent, versioned, encrypted memory — stored entirely on the 0G decentralised network. Think of it as **Git for agent memory**:

- Every memory write is a signed **commit** on an append-only DAG (like a git commit)
- Agents can create **branches**, make experiments, and **merge** them back
- Two agents can **grant** each other read access to their memories — time-limited, on-chain revocable, with access tiers
- Memory text in the KV index is **AES-256-GCM encrypted** per wallet — only the owner can read their own index
- Grants use **ECDH key-wrapping (MemoryCapsule)** — the recipient unwraps the granter's AES key using their own private key, no shared secret ever transmitted
- If the fast KV cache is wiped, you can fully **restore** from the permanent blob layer on 0G Storage

Built for the 0G Hackathon, OpenClaw framework track.

---

## Repository Layout

```
zeromem/
├── packages/
│   ├── sdk/                   ← THE CORE — all memory logic
│   ├── contracts/             ← GrantRegistry.sol (0G EVM, deployed)
│   ├── openclaw-zeromem/      ← OpenClaw gateway plugin (judges care about this)
│   ├── openclaw-plugin/       ← Vercel AI SDK wrapper (withZeroMem)
│   └── client/                ← lightweight HTTP client for relayer
├── examples/
│   ├── research-agent/        ← CLI demo (two-agent grant flow)
│   └── visual-demo/           ← Next.js UI at http://localhost:3000
├── relayer/                   ← optional self-hosted HTTP relayer
├── infra/
│   ├── postgres/              ← docker-compose for Postgres (pgvector backend)
│   └── zgs-kv/                ← config + setup script for local 0G KV node
├── HANDOVER.md                ← this file
├── TESTING_GUIDE.md           ← step-by-step UI testing flows (26 steps, 6 flows)
├── IMPLEMENTATION_PLAN.md     ← implementation phases + known gaps
└── README.md                  ← SDK API reference
```

---

## Deployed Contracts & Wallet Addresses

| Item | Value |
|---|---|
| GrantRegistry (0G Galileo) | `0x0eB90F38A7c52f5646DED48b37f6C4DBfcFbf70c` |
| Researcher wallet (`agent-a`) | `0x4ac8F862D1bcc4D58B812A4Bef11F431B40e755B` |
| Writer wallet (`writer-a`) | `0x6b31125575A0F6743996Cd5c95b6590983287dBd` |
| Default demo wallet | `0x3C4aa7c460C0e9631f62f1a8F2B49eAd88A1365d` |
| 0G RPC | `https://evmrpc-testnet.0g.ai` |
| 0G Storage Indexer | `https://indexer-storage-testnet-turbo.0g.ai` |
| 0G KV node | `http://3.101.147.150:6789` (currently unreachable — see KV section) |
| ChainScan | `https://chainscan-galileo.0g.ai` |
| StorageScan | `https://storagescan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai` (0.1 0G/wallet/day) |

---

## Environment Setup

The `.env` file lives at the **monorepo root**: `zeromem/.env`

The visual demo symlinks it: `examples/visual-demo/.env.local → ../../.env`

```bash
# 0G Testnet (Galileo — chain 16602)
ZG_RPC=https://evmrpc-testnet.0g.ai
ZG_INDEXER=https://indexer-storage-testnet-turbo.0g.ai
ZG_KV_URL=http://3.101.147.150:6789

# Three wallets — each agent uses a different one
ZG_PRIVATE_KEY=0x...            # demo-agent, fallback
RESEARCHER_PRIVATE_KEY=0x...    # agent-a, researcher-v1
WRITER_PRIVATE_KEY=0x...        # writer-a, writer-v1

# Deployed GrantRegistry
GRANT_REGISTRY_ADDRESS=0x0eB90F38A7c52f5646DED48b37f6C4DBfcFbf70c

# Optional — sealed inference via 0G Compute
ZG_COMPUTE_PROVIDER=0x...       # from compute-marketplace.0g.ai/inference
ZG_COMPUTE_ENDPOINT=https://...
```

**Which agent uses which key** (hardcoded in the route):

```
agent-a / researcher-v1 / main  →  RESEARCHER_PRIVATE_KEY
writer-a / writer-v1            →  WRITER_PRIVATE_KEY
everything else                 →  ZG_PRIVATE_KEY
```

---

## How to Run

### Tests (no network needed)

```bash
cd packages/sdk && npm test           # 61 tests
cd packages/openclaw-zeromem && npm test  # 34 tests
# Total: 95 tests, ~15 seconds
```

### Visual demo UI

```bash
cd examples/visual-demo
npm run dev
# → http://localhost:3000
```

### CLI research-agent demo

```bash
cd examples/research-agent
npm run dev
```

### Rebuild SDK after code changes

```bash
cd packages/sdk && npm run build
# Then restart the demo server
```

---

## What Was Built — Full Feature List

### `packages/sdk/src/`

| File | What it does |
|---|---|
| `client.ts` | `ZeroMem` class — the entire public API. 30+ methods. |
| `commit.ts` | `ZeroCommit` DAG node: build, sign (secp256k1), verify, encode/decode, `walkCommits()` async generator |
| `storage.ts` | Wraps `@0gfoundation/0g-ts-sdk`. ECIES upload/download, KV read/write with **process-level shared in-memory fallback** when KV node is down. Monkey-patches `waitForLogEntry` to fix SDK bug (polls all shards, 90s timeout). Uses `FixedPriceFlow__factory` for correct Flow contract ABI. |
| `kv-views.ts` | All KV key namespaces in one place — head, item count, vector shards, grants, grant reverse-index, capsule roots, skill manifest, tombstones, branches, root anchor, snapshot pointers, last-reflect timestamps |
| `vector.ts` | Cosine similarity search. KV shards store only `VectorRef {commitId, rootHash}` — entries are blobs on 0G. All shards fetched **in parallel** (`Promise.all`). Supports tag/time/score/recency filters. |
| `pg-index.ts` | PostgreSQL + pgvector HNSW alternative to KV shards. Activated with `postgresUrl` config. |
| `memory-index.ts` | `MemoryIndex` interface — both `VectorIndex` and `PostgresVectorIndex` implement it. |
| `inference.ts` | 0G Compute wrapper. `embed()` → `@xenova/transformers` WASM (384-dim, semantic) → pseudo-hash fallback. `ask()`, `reflect()`, `plan()` via chat completions. Uses ESM `new Function` trick to load xenova in CJS output. |
| `grant.ts` | `GrantManager`. Creates `MemoryCapsule` (ECDH-wrapped AES key), uploads to 0G, stores grant + reverse-index in granter's KV stream. On-chain `GrantRevoked` event listener auto-purges KV. |
| `acl.ts` | Full ACL crypto layer: `deriveKvSymKey`, AES-256-GCM KV text encrypt/decrypt, ECDH key-wrapping (`wrapKeyForRecipient` / `unwrapKey`), `MemoryCapsule` create/verify, `AccessChallenge` create/sign/verify. |
| `skills.ts` | Signed skill blobs. `add()` signs code with secp256k1, uploads to 0G, updates KV manifest. `list()` reads manifest from KV. `run()` executes code. |
| `errors.ts` | Typed error classes: `ZeroMemFrozenError`, `ZeroMemGrantNotFoundError`, `ZeroMemGrantExpiredError`, `ZeroMemStorageError`, `ZeroMemNoTipError`. |
| `git.ts` | `forkBranch`, `mergeBranch` (fast-forward + reflect), `log`, `blame`, `diffBranches` |
| `types.ts` | All interfaces: `ZeroCommit`, `VectorEntry`, `VectorRef`, `RecallResult`, `SearchOpts`, `MemStats`, `CommitProof`, `DiffResult`, `GcResult`, `AskResult`, `Plan`, `Skill` |

### `ZeroMem` public API (complete)

```typescript
// Core
mem.remember(text, opts)           // store memory → blob on 0G → KV index
mem.recall(query, opts)            // semantic search (cosine similarity)
mem.ask(question, opts)            // recall + LLM answer (RAG)
mem.search(opts)                   // recall with tag/time/score/recency filters

// Git
mem.branch(name)                   // fork HEAD → new ZeroMem on that branch
mem.merge(branch, opts)            // fast-forward or reflect strategy
mem.diff(branchA, branchB)         // commits exclusive to each branch
mem.log(opts)                      // commit history
mem.blame(keyword)                 // find which commit introduced a keyword
mem.replay(opts)                   // frozen read-only snapshot at commitId
mem.snapshot(name)                 // tag current HEAD as named checkpoint
mem.checkout(name)                 // frozen ZeroMem at named snapshot

// Memory lifecycle
mem.forget(commitId)               // tombstone one commit
mem.forgetBulk(opts)               // tombstone by tags/age/namespace
mem.gc(opts)                       // reclaim KV space from tombstoned entries
mem.restore(branch, opts)          // rebuild KV from 0G blob DAG

// Agent intelligence
mem.reflect(opts)                  // incremental episodic→semantic compaction
mem.plan(goal)                     // hierarchical task tree
mem.getPlan(commitId)              // load stored plan
mem.completePlanTask(planId, task) // mark task done

// Access control
mem.grant(opts)                    // ECDH MemoryCapsule + on-chain GrantRegistry
mem.revoke(grantId, opts)          // on-chain + KV cleanup
mem.batchGrant(opts)               // grant to multiple wallets at once
mem.createAccessChallenge(addr, scope)   // Step 1 of verified grant
ZeroMem.signAccessChallenge(key, challenge)  // Step 2 (recipient)
mem.grantVerified(opts)            // Step 3: verify proof then grant

// Proof & stats
mem.prove(commitId)                // two-sig Merkle attestation
mem.stats()                        // KV-only metadata snapshot
mem.skills.add/list/run(...)       // procedural memory
mem.raw                            // escape hatch: direct storage access
```

### `packages/openclaw-zeromem/`

Full OpenClaw gateway plugin:

- **`before_prompt_build` hook** — auto-recall top-k, injection detection, HTML-escape, `<zeromem-memories>` block, namespace instruction
- **`agent_end` hook** — auto-capture with `shouldCapture` filter (skips filler, short texts, injections)
- **`memory_search` tool** — agent-callable semantic search
- **`memory_store` tool** — agent-callable store with injection rejection
- **`security.ts`** — `detectInjection`, `htmlEscape`, `wrapMemoryBlock`, `stripMemoryTags`, `shouldCapture`
- **`namespace.ts`** — session key → memory namespace routing
- **`cli/index.ts`** — `zeromem search`, `zeromem stats`
- **`openclaw.plugin.json`** — manifest for OpenClaw framework

### `packages/contracts/GrantRegistry.sol`

Deployed on 0G Galileo (chain 16602). Features:

- `registerAgent(pubkey)` — on-chain agent pubkey registry
- `grant(to, scopeHash, ttl, commitRoot, capsuleRoot, tier)` — creates a grant
- `batchGrant(recipients[], ...)` — grant to multiple wallets in one tx
- `delegateGrant(parentGrantId, delegateTo, subTtl, subTier, capsuleRoot)` — ADMIN-tier holders can re-grant (no escalation)
- `revoke(grantId)` — emits `GrantRevoked` event → SDK listener purges KV
- `revokeAll(recipients[], scopeHash)` — nuke all grants for a scope
- `getAccessTier(from, to, scopeHash)` — returns tier enum
- `isGranted(from, to, scopeHash)` — quick boolean check

Access tiers: `NONE`, `READ_SEMANTIC` (summaries only), `READ_FULL` (all namespaces), `ADMIN` (can delegate)

### `examples/visual-demo/`

Full Next.js UI at `http://localhost:3000`. Five tabs:

| Tab | Features |
|---|---|
| Memory | remember, recall, ask (RAG), search with filters, forget, forgetBulk |
| Git | log, branch, merge, diff, blame, snapshot/checkout, **replay** (time-travel) |
| Grants | grant with tier, revoke, cross-agent recall, **challenge-response** 3-step verified grant, **batchGrant** |
| System | stats, reflect, gc, prove (with StorageScan link), restore |
| Skills & Plans | skills.add/list/run, plan, completePlanTask |

Header shows: wallet address (click to copy), KV mode badge (`✓ on-chain` / `⚠ in-memory`), ⟳ refresh.

---

## KV Layer Status — Important

**The 0G KV public testnet node (`3.101.147.150:6789`) is currently unreachable.**

The SDK has a **process-level shared in-memory fallback** (`StorageClient.sharedKv` static Map). When KV is down:

- All writes go to the shared in-memory Map instead of on-chain
- All reads check the shared Map (so cross-agent grants still work in-process)
- Blobs (commits, payloads, capsules) **still upload to real 0G Storage**
- KV data is **lost on server restart** — run `restore(tipCommitId)` to rebuild
- The header shows `⚠ KV: in-memory` when this mode is active

**To get proper KV persistence:** self-host `zgs_kv` locally:

```bash
cd infra/zgs-kv
chmod +x setup.sh && ./setup.sh   # downloads binary, writes config
# Edit config.toml.template — set blockchain.rpc_endpoint, log_contract_address
# Set ZG_KV_URL=http://localhost:6789 in .env
```

---

## How the Memory/Grant Flow Works End-to-End

### `remember()` — one call, many layers

```
remember("0G uses append-only Log blobs")
   │
   ├─ 1. Embed text → 384-dim vector (xenova all-MiniLM-L6-v2 or 0G Compute)
   │
   ├─ 2. Encrypt text with AES-256-GCM using per-wallet key
   │     kvSymKey = keccak256("zeromem:kv:sym:v1" + privateKey)
   │
   ├─ 3. Upload payload blob { text_encrypted, embedding, ts, tags }
   │     → ECIES encrypt to agent's own pubkey
   │     → 0G Storage (indexer → storage nodes) → returns payloadRoot
   │
   ├─ 4. Build ZeroCommit { parent, op, branch, namespace, payloadRoot, sig }
   │     → sign with secp256k1 via ethers.Wallet
   │     → upload as blob → returns commitId
   │
   └─ 5. KV writes (one batched transaction):
         head/{agentId}/{branch}     = commitId
         idx/{agentId}/{ns}/{shard}  = [...VectorRef { commitId, rootHash }]
         idx/{agentId}/{ns}/count    = count + 1
         root/{agentId}/{branch}     = commitId  (first commit only)
```

### `grant()` — the MemoryCapsule

```
grant({ to: writerAddr, toPubKey: "0x02...", scope: "default", ttl: "24h", tier: "READ_FULL" })
   │
   ├─ 1. Create MemoryCapsule:
   │     sharedSecret = ECDH(granterPrivKey, writerPubKey)   ← ECDH, symmetric
   │     wrapKey = keccak256("zeromem:wrap:v1" + sharedSecret)
   │     wrappedKvKey = AES-GCM(wrapKey, granterKvSymKey)
   │     capsule = { ..., wrappedKvKey, tier, sig }
   │
   ├─ 2. Upload capsule blob → ECIES encrypted to writer's pubkey → capsuleRoot
   │
   ├─ 3. On-chain: GrantRegistry.grant(writerAddr, scopeHash, ttl, commitRoot, capsuleRoot, 2)
   │     emits GrantCreated event → grantId
   │
   └─ 4. KV writes (granter's stream):
         grant/{granterAddr}/{writerAddr}/default = { grantId, ttl, granterAgentId, tier, capsuleRoot }
         grantidx/{grantId} = { from, to, scope }   ← reverse-index for revoke events
```

### `recallFromGrant()` — recipient reads granter's memories

```
recall("0G storage", { from: granterAddr })
   │
   ├─ 1. Read grant record from granter's KV stream (not recipient's)
   │
   ├─ 2. Download capsule blob from 0G (ECIES decrypt with recipient's key)
   │
   ├─ 3. Unwrap kvSymKey:
   │     sharedSecret = ECDH(recipientPrivKey, granterPubKey)   ← same shared secret
   │     wrapKey = keccak256("zeromem:wrap:v1" + sharedSecret)
   │     granterKvSymKey = AES-GCM-decrypt(wrapKey, capsule.wrappedKvKey)
   │
   ├─ 4. Read granter's KV shards → list of VectorRef
   │
   ├─ 5. Download each VectorEntry blob from 0G → cosine similarity
   │
   └─ 6. Decrypt result texts with granterKvSymKey → return to recipient
```

---

## What Works, What Doesn't

### Working (tested live)

| Feature | Notes |
|---|---|
| Blob upload to 0G Storage | ~30–40s per remember(); blobs visible on StorageScan |
| Semantic recall | `@xenova/transformers` all-MiniLM-L6-v2, 384-dim, correct ranking |
| All Git operations | branch/merge/diff/blame/replay/snapshot work in-session |
| Grants + revoke | GrantRegistry deployed, events wired |
| MemoryCapsule ECDH | Key wrapping/unwrapping works |
| Challenge-response grant | Wallet ownership verified before grant |
| Skills + Plans | Upload/run/track works |
| Reflect + Ask | Fallback mode active (no LLM, lists recalled memories) |
| Prove (attestation) | Returns sig + StorageScan link |
| Restore | Rebuilds KV from 0G blob DAG |
| Visual demo UI | All 29 endpoints wired, fully working |
| 95 tests | 61 SDK + 34 gateway plugin, all passing |

### Partial / Known Limitations

| Issue | Detail | Fix |
|---|---|---|
| KV node unreachable | `3.101.147.150:6789` is down. SDK falls back to shared in-memory Map. Data lost on restart. | Self-host `zgs_kv` (see `infra/zgs-kv/`) |
| No LLM answer in `ask()` | `ZG_COMPUTE_ENDPOINT` not set. Returns fallback with recalled memories. | Set `ZG_COMPUTE_PROVIDER` + `ZG_COMPUTE_ENDPOINT` in `.env` |
| `recallFromGrant` hardcodes `'main'` branch | If granter stored on a non-main branch, recall returns empty | Add `grantorBranch` param to `grant()` opts |
| `skills.run()` uses `new Function()` | Security risk in production | Replace with WASM worker |
| Cross-session KV loss | Any server restart loses in-memory KV state | Run `restore(tipCommitId)` to rebuild |

---

## Testing

**For a complete step-by-step testing guide → see `TESTING_GUIDE.md`**

It covers all 26 steps across 6 flows:
1. Core Memory (remember, recall, ask, search, forget, forgetBulk, gc)
2. Git (branch, merge, diff, blame, snapshot, replay)
3. Grants (direct grant, cross-agent recall, revoke, challenge-response, batch)
4. System (stats, reflect, prove, restore)
5. Skills & Plans
6. Batch grant

### Quick test (unit tests only, no network)

```bash
cd packages/sdk && npm test
cd packages/openclaw-zeromem && npm test
```

### Live test

```bash
cd examples/visual-demo && npm run dev
# Open http://localhost:3000
# Set agent: to "agent-a", click ⟳
# Go to Memory tab → type a memory → remember()
# → first one takes ~30–40s (blob upload to 0G)
```

---

## Key Technical Decisions

**Flat cosine search vs HNSW** — KV shards store VectorRef pointers; entries are 0G blobs. On recall, refs are fetched in parallel then blobs are downloaded for top candidates. Correct for <10k memories. For production: layer in HNSW or use the Postgres backend (`postgresUrl` config).

**ECIES for grants, AES for KV index** — Blob payloads are ECIES-encrypted to owner's pubkey (no shared secret). KV vector index text is AES-256-GCM with a per-wallet deterministic key. Grants use ECDH key-wrapping so the recipient can decrypt the granter's AES key without any out-of-band communication.

**Branch-isolated vector namespaces** — `recall()` on `main` only searches `main/default` shards, never `feature/default`. Prevents cross-branch leakage found during testing.

**Process-level shared KV fallback** — All `StorageClient` instances share one static `Map`. This lets `agent-a` write a grant and `writer-a` read it in the same server process, even without a live KV node.

**`new Function` for xenova import** — TypeScript compiles `import()` to `require()` in CJS output. `@xenova/transformers` is ESM-only. Wrapping in `new Function('m', 'return import(m)')` escapes TypeScript's transform and keeps it as a real dynamic ESM import.

---

## File Quick Reference

```
.env                              → all secrets (single source of truth)
packages/sdk/src/client.ts        → ZeroMem class (start reading here)
packages/sdk/src/storage.ts       → 0G network layer, KV fallback logic
packages/sdk/src/acl.ts           → ECDH, AES, MemoryCapsule, challenge-response
packages/sdk/src/grant.ts         → GrantManager (capsule upload, event listener)
packages/contracts/GrantRegistry.sol → deployed on-chain, handles tiers + delegation
packages/openclaw-zeromem/        → OpenClaw gateway plugin (judges look here)
examples/visual-demo/app/page.tsx → UI (React)
examples/visual-demo/app/api/zeromem/[action]/route.ts → all 31 API endpoints
TESTING_GUIDE.md                  → step-by-step test flows
```

---

## Links

| Resource | URL |
|---|---|
| 0G Docs | https://docs.0g.ai |
| 0G Discord | https://discord.gg/0glab |
| 0G Galileo Explorer | https://chainscan-galileo.0g.ai |
| 0G Storage Explorer | https://storagescan-galileo.0g.ai |
| 0G Faucet | https://faucet.0g.ai |
| 0G Compute Marketplace | https://compute-marketplace.0g.ai/inference |
| GrantRegistry on-chain | https://chainscan-galileo.0g.ai/address/0x0eB90F38A7c52f5646DED48b37f6C4DBfcFbf70c |
