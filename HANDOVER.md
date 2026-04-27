# ZeroMem — Handover Document

**Date:** 2026-04-27  
**Project:** ZeroMem — Git-for-Agent-Memory on 0G  
**Hackathon:** 0G OpenClaw Framework Track

---

## What is this project?

ZeroMem is a **TypeScript SDK** that gives AI agents persistent, versioned, encrypted memory — stored entirely on the 0G decentralized network.

Think of it as **Git for agent memory**:
- Every memory a write is a signed **commit** on a DAG (like a git commit)
- Agents can create **branches**, make experiments, and **merge** them back
- Two agents can **grant** each other read access to their memories, with on-chain revocation
- If the fast cache layer (KV) gets wiped, you can fully **restore** from the permanent blob layer

The closest comparison is [MemWal](https://github.com/MystenLabs/MemWal) by MystenLabs, but that project runs on Walrus/Sui and has no branching, no agent-to-agent transfer, and sends embeddings to OpenAI. ZeroMem is built entirely on 0G and adds all of those features.

---

## Repository layout

```
zeromem/
├── packages/
│   ├── sdk/              ← THE CORE — start here
│   ├── contracts/        ← Solidity (GrantRegistry.sol)
│   ├── openclaw-plugin/  ← Vercel AI SDK integration
│   └── relayer/          ← optional HTTP service
└── examples/
    ├── research-agent/   ← main demo script (run this to test)
    └── visual-demo/      ← Next.js web UI
```

The most important folder is `packages/sdk/src/`. That is the entire brain.

---

## The core idea in plain English

When an agent calls `mem.remember("Alice likes terse replies")`:

1. The text gets **embedded** (converted to a vector of numbers) via 0G Compute
2. The vector + text get **encrypted** with ECIES (public-key encryption) using the agent's Ethereum wallet
3. The encrypted blob gets **uploaded to 0G Storage** — returns a `rootHash` (like a content address)
4. A **commit object** is built: `{ parent: prevCommitHash, op: "remember", payload_root: rootHash, sig: ... }` — signed with secp256k1
5. The commit is **uploaded to 0G Storage** (also encrypted) — returns a new `rootHash` (the commitId)
6. Two **KV writes** happen: update the HEAD pointer + add the vector to the index shard

When the agent calls `mem.recall("how should I talk to Alice?")`:

1. The query gets embedded
2. All KV vector shards are read (cosine similarity search)
3. Top-k results returned by score

---

## Key files — what each one does

| File | What it does |
|---|---|
| `sdk/src/client.ts` | The main `ZeroMem` class. This is the public API — `remember`, `recall`, `branch`, `merge`, `replay`, `reflect`, `plan`, `grant`, `revoke`, `forget`, `restore`, `skills` |
| `sdk/src/commit.ts` | Defines the `ZeroCommit` struct. Build, sign (secp256k1 via ethers), verify, encode/decode, walk the DAG |
| `sdk/src/storage.ts` | Thin wrapper over `@0gfoundation/0g-ts-sdk`. Handles ECIES upload/download, KV reads/writes |
| `sdk/src/kv-views.ts` | All the KV key patterns. Think of it as the "schema" for the KV layer |
| `sdk/src/vector.ts` | Cosine similarity search over KV shards. No external vector DB needed |
| `sdk/src/grant.ts` | Cross-agent memory grants. Writes to on-chain `GrantRegistry`, listens for revoke events |
| `sdk/src/inference.ts` | Wraps 0G Compute for embeddings + reflection. Falls back to local WASM if no endpoint |
| `sdk/src/skills.ts` | Procedural memory — store and run signed code blobs |
| `sdk/src/git.ts` | Branch, fork, merge, replay, blame. Lower-level helpers called by `client.ts` |
| `contracts/GrantRegistry.sol` | Solidity contract. Tracks agent pubkeys and grants on 0G EVM |
| `openclaw-plugin/src/index.ts` | Drop-in wrapper for Vercel AI SDK models |
| `examples/research-agent/src/index.ts` | The flagship demo. Run this to see everything work end-to-end |

---

## How to run the unit tests (no internet needed)

```bash
cd packages/sdk
npm test
```

59 tests, all in-memory, run in ~10 seconds. This is the fastest way to verify nothing is broken.

The tests use a `MockStorageClient` that replaces the real 0G network calls. It stores blobs and KV data in JavaScript Maps. The inference is mocked to return deterministic word-hash embeddings.

---

## How to test the full flow on testnet

### Prerequisites
- Two Ethereum wallets (even `cast wallet new` or MetaMask export works)
- Some 0G testnet tokens: `https://faucet.0g.ai` (0.1 per wallet per day)

### Steps

```bash
# 1. Copy and fill the env file
cp .env.example .env
# Fill in: ZG_PRIVATE_KEY, RESEARCHER_PRIVATE_KEY, WRITER_PRIVATE_KEY

# 2. Deploy the GrantRegistry contract to 0G Galileo testnet
cd packages/contracts
npm install && npx hardhat compile
npm run deploy:testnet
# It will print: "GrantRegistry deployed to: 0x..."
# Paste that address into .env as GRANT_REGISTRY_ADDRESS

# 3. Run the research-agent demo
cd ../../examples/research-agent
npm install
npm run dev
```

The demo prints 14 steps including:
- Researcher stores 3 facts
- Creates an experiment branch
- Recalls semantically similar memories
- Reflector compacts episodic → semantic
- Generates a hierarchical plan
- Grants Writer agent 24h read access
- Writer recalls from Researcher's memory
- Revoke
- Simulate KV restore
- Register a skill + run it

After running, check `https://storagescan-galileo.0g.ai` — you should see your wallet's blob uploads.

### Visual demo

```bash
cd examples/visual-demo
npm install
npm run dev
# Open http://localhost:3000
```

---

## Environment variables

```
ZG_RPC=https://evmrpc-testnet.0g.ai           # don't change
ZG_INDEXER=https://indexer-storage-testnet-turbo.0g.ai  # don't change
ZG_KV_URL=http://3.101.147.150:6789           # check 0G Discord if this changes

ZG_PRIVATE_KEY=0x...                          # main wallet
RESEARCHER_PRIVATE_KEY=0x...                  # demo Agent A
WRITER_PRIVATE_KEY=0x...                      # demo Agent B

# Optional — enables sealed inference (no fallback to local)
ZG_COMPUTE_PROVIDER=0x...                     # from compute-marketplace.0g.ai
ZG_COMPUTE_ENDPOINT=https://...               # from the same page

# Fill after deploying GrantRegistry
GRANT_REGISTRY_ADDRESS=0x...
```

---

## What still needs to be done

### Before submitting (P0 — ~2 hrs total)

1. **Fund wallets and deploy** the GrantRegistry contract (steps above)
2. **Run `research-agent` end-to-end** and verify blobs appear on StorageScan
3. **Record demo video** (< 3 min) — script is in `IMPLEMENTATION_PLAN.md`
4. **Push to GitHub** and make the repo public

### For a stronger demo (P1 — ~1 hr)

5. **Get a 0G Compute provider address** from `https://compute-marketplace.0g.ai/inference` and add it to `.env`. This enables real sealed embeddings instead of the local fallback — which is the key privacy claim of the project.

---

## Things to watch out for

**0G KV endpoint might change.** The default `http://3.101.147.150:6789` is from the testnet docs. If KV reads return nothing, check the 0G Discord for the current testnet KV node address and update `ZG_KV_URL`.

**Batcher API.** The `Batcher` constructor in `storage.ts` takes `(1, nodes, flowContractInstance, rpcUrl)`. If you update `@0gfoundation/0g-ts-sdk`, the constructor signature might change. Check the release notes.

**`recallFromGrant` assumes granter branch is `main`.** If the granter created their memories on a different branch, recall will return empty. This is hardcoded to `main` in `client.ts:recallFromGrant`. Easy to fix by adding a `grantorBranch` option to `grant()`.

**`skills.run()` uses `new Function()`** — this is fine for a hackathon but is a security risk in production. Replace with a WASM worker.

**Embeddings.** Without a 0G Compute endpoint, the SDK falls back to `@xenova/transformers` (WASM, ~20MB download on first run) and then to a deterministic hash-based pseudo-embedding. The pseudo-embedding makes `recall()` work for exact queries but semantic similarity is random. The tests use the hash-based embed — they pass but don't test real semantic search quality.

---

## Technical decisions worth knowing

**Why cosine similarity in KV instead of a proper HNSW index?**  
Proper HNSW (like hnswlib) would need a binary format stored in KV, which complicates restore(). Flat cosine search is correct for small-to-medium memory sets (up to ~10k entries before it gets slow) and is fully rebuildable from the Log. For a production SDK, we'd layer in approximate indexing.

**Why ECIES encryption per blob instead of symmetric?**  
Each blob is encrypt-to-self using the agent's Ethereum wallet key. For grants, the head commit gets re-uploaded encrypted to the recipient's pubkey. This avoids key management complexity — the wallet IS the key.

**Why store the root commit in KV if it could also be wiped?**  
It's a best-effort anchor. The real recovery path is `restore(tipCommitId)` where the user passes the last known commitId. The root commit anchor helps if KV is only partially corrupted. In a more complete implementation, we'd emit an on-chain event on first commit.

**Why branch-isolated vector namespaces?**  
A bug we found during testing: if branches share a namespace, `recall()` on `main` would return memories written on `feature`. Fixed by qualifying the namespace: `main/default`, `feature/default`, etc. Merge copies entries from `srcBranch/ns` to `dstBranch/ns`.

---

## Contacts / links

- 0G docs: `https://docs.0g.ai`
- 0G Discord: `https://discord.gg/0glab` — ask in `#developer` if testnet endpoints change
- MemWal reference: `https://github.com/MystenLabs/MemWal`
- 0G Galileo Explorer: `https://chainscan-galileo.0g.ai`
- 0G Storage Explorer: `https://storagescan-galileo.0g.ai`
- 0G Faucet: `https://faucet.0g.ai`
