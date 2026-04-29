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

## Full on-chain flow: what happens on each `remember()`

This traces one call — `mem.remember("0G uses append-only Log blobs")` — through every layer.

```
Developer code
     |
     v
ZeroMem SDK  (packages/sdk/src/client.ts)
     |
     |-- 1. EMBED
     |        inference.ts calls 0G Compute /embeddings endpoint
     |        → 384-dim float vector  [0.12, -0.34, 0.89 ...]
     |        Fallback chain: 0G Compute → @xenova/transformers WASM → pseudo-hash
     |
     |-- 2. BUILD PAYLOAD BLOB
     |        { text, embedding, tags, ts } — JSON, ~3-4 KB for 384-dim embed
     |        ECIES-encrypt to agent's own Ethereum wallet pubkey
     |        → sealed Uint8Array
     |
     |-- 3. UPLOAD PAYLOAD BLOB  →  0G Storage Log layer
     |        MemData(encryptedBytes) builds Merkle tree → rootHash computed
     |        Uploader.submitLogEntryNoReceipt() → EVM tx on Galileo (chain 16602)
     |          flow.submit(submission, { value: storageFee })
     |          fee ≈ 30-1100 Gwei × sectors (scales with blob size)
     |        Storage nodes download the shard once tx is mined
     |        Uploader.waitForLogEntry() polls nodes until one confirms it
     |        returns: payloadRoot = "0xabc..."
     |
     |-- 4. BUILD COMMIT OBJECT
     |        ZeroCommit {
     |          version: 1,
     |          parent: prevCommitId | null,
     |          agent_id: "researcher-v1",
     |          author_pubkey: "0x03...",
     |          op: "remember",
     |          branch: "main",
     |          namespace: "main/default",
     |          payload_root: payloadRoot,
     |          metadata: { ts, embedding_dim: 384, tags }
     |        }
     |        sign with secp256k1 via ethers.Wallet.signMessage()
     |
     |-- 5. UPLOAD COMMIT BLOB  →  0G Storage Log layer
     |        Same upload path as step 3
     |        returns: commitId = "0xdef..."   ← this IS the commit hash
     |
     |-- 6. KV WRITES  →  0G Storage KV layer (zgs_kv, self-hosted)
     |        Write 1 — HEAD pointer
     |          key:   head/researcher-v1/main
     |          value: commitId
     |        Write 2 — vector index shard
     |          key:   idx/researcher-v1/main/default/v/0
     |          value: JSON array of VectorEntry objects (append)
     |        Write 3 (first commit only) — root commit anchor
     |          key:   root/researcher-v1/main
     |          value: commitId
     |        Each write: Batcher encodes as StreamData blob → EVM tx → zgs_kv indexes it
     |        stream_id = keccak256("zeromem:" + lowercase(walletAddress))
     |        Write-through in-process cache makes reads visible immediately
     |        (zgs_kv replay lag is minutes; cache bridges the gap within the same process)
```

### How `recall()` uses what was stored

```
mem.recall("how does 0G store data?")
     |
     |-- 1. Embed query → vector Q
     |-- 2. KV GET all shards: idx/researcher-v1/main/default/v/0, v/1, ...
     |-- 3. Cosine similarity: score = dot(Q, entry.embedding) for each entry
     |-- 4. Return top-k entries sorted by score
     |        entry.text decoded and decrypted from payload blob on demand
```

### Why the demo tests this end-to-end

The 16-step research-agent demo exercises every layer:

| Step | Operation | What it proves |
|---|---|---|
| 1-3 | `remember()` × 3 | Blobs land on 0G Log + KV index is queryable |
| 4 | `branch('hypothesis-...')` | Branch creates isolated KV namespace, no bleed |
| 5 | `recall('storage')` | Cosine similarity search works over real vectors |
| 6 | `ask('question')` | Recall + 0G Compute answer over retrieved memory context |
| 7 | `plan('write paper')` | Planner returns valid DAG task structure |
| 8-9 | `grant(writerPubKey, 'read')` | GrantRegistry tx + HEAD re-encrypted to recipient |
| 10 | Writer `recallFromGrant()` | Cross-agent read via grant works |
| 11 | `revoke(grantId)` | On-chain revocation via GrantRegistry |
| 12 | `forget(commitId)` | Tombstone written, commit excluded from future recall |
| 13 | KV wipe → `restore(tipCommitId)` | DAG replayed from Log, vector index rebuilt |
| 14 | `skills.register()` + `skills.run()` | Signed code blob uploaded and executed |
| 15 | `merge('hypothesis-...')` | Branch vectors merged into main namespace |
| 16 | OpenClaw plugin | `before_prompt_build` auto-recall + `agent_end` auto-capture |

Blobs visible at `https://storagescan-galileo.0g.ai` for the demo wallet after the run.

---

## Key files — what each one does

| File | What it does |
|---|---|
| `sdk/src/client.ts` | The main `ZeroMem` class. This is the public API — `remember`, `recall`, `ask`, `branch`, `merge`, `replay`, `plan`, `grant`, `revoke`, `forget`, `restore`, `skills` |
| `sdk/src/commit.ts` | Defines the `ZeroCommit` struct. Build, sign (secp256k1 via ethers), verify, encode/decode, walk the DAG |
| `sdk/src/storage.ts` | Thin wrapper over `@0gfoundation/0g-ts-sdk`. Handles ECIES upload/download, KV reads/writes. Pre-filters indexer trusted nodes by `logSyncHeight` so Uploader never waits on a stalled storage node. Uses `FixedPriceFlow__factory` to construct the Flow contract with a real ABI (raw `new ethers.Contract(addr, [], signer)` was missing `market()` and crashed Batcher). Uploads default to `finalityRequired: false` + `skipIfFinalized: true` to keep demos under timeout. Monkey-patches `uploader.waitForLogEntry` to fix SDK bug: the SDK breaks on the first null node instead of trying all nodes — with numShard=2 the wrong shard's node returns null forever; the patch tries all nodes per tick and adds a 90s hard timeout so the demo isn't stuck after segments are already on-chain. Write-through `kvCache` bridges zgs_kv replay lag within the same process. |
| `sdk/src/kv-views.ts` | All the KV key patterns. Think of it as the "schema" for the KV layer |
| `sdk/src/vector.ts` | Cosine similarity search over KV shards. No external vector DB needed |
| `sdk/src/grant.ts` | Cross-agent memory grants. Writes to on-chain `GrantRegistry`, listens for revoke events |
| `sdk/src/inference.ts` | Wraps 0G Compute for embeddings + ask/planning. Falls back to local WASM if no endpoint |
| `sdk/src/skills.ts` | Procedural memory — store and run signed code blobs |
| `sdk/src/git.ts` | Branch, fork, merge, replay, blame. Lower-level helpers called by `client.ts` |
| `contracts/GrantRegistry.sol` | Solidity contract. Tracks agent pubkeys and grants on 0G EVM |
| `openclaw-plugin/src/index.ts` | Drop-in wrapper for Vercel AI SDK models |
| `openclaw-zeromem/` | OpenClaw **gateway** plugin (the one judges expect for the framework track). Hooks: `before_prompt_build` (auto-recall with HTML-escape + injection guard + `<zeromem-memories>` tag wrap) and `agent_end` (auto-capture with tag-stripping + `shouldCapture` filter). Tools: `memory_search`, `memory_store`. CLI: `zeromem search`, `zeromem stats`. Manifest: `openclaw.plugin.json`. 34/34 unit tests. |
| `examples/research-agent/src/index.ts` | The flagship demo. Run this to see everything work end-to-end |

---

## How to run the unit tests (no internet needed)

```bash
cd packages/sdk
npm test                            # 59/59 SDK tests
cd ../openclaw-zeromem
npm test                            # 34/34 gateway plugin tests
```

93 total tests, all in-memory, run in ~15 seconds. Fastest way to verify nothing is broken.

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
- Ask endpoint answers a question from recalled memory context
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

**0G KV endpoint must be self-hosted.** The hardcoded `http://3.101.147.150:6789` from the testnet docs is unreachable. Run `zgs_kv` locally (binary at `https://github.com/0gfoundation/0g-storage-kv/releases/download/v1.5.1/zgs_kv_linux.zip`) with `stream_ids = [keccak256("zeromem:" + lowercase(walletAddress))]`, set `ZG_KV_URL=http://localhost:6789`. First sync from genesis takes minutes — bump `log_sync_start_block_number` in `config_testnet_turbo.toml` to a recent block to skip ancient history.

**Indexer's selectNodes ignores sync state.** The default 'min'/'max' methods just sort by shardId/numShard. Trusted nodes can be tens of thousands of blocks behind chain head, in which case `Uploader.waitForLogEntry` polls forever. Storage layer pre-filters by `logSyncHeight >= chainHead - 200` before passing nodes to `Uploader`/`Batcher`.

**Flow contract ABI mismatch.** `@0gfoundation/0g-ts-sdk@1.2.6` calls `flow.market()` inside `submitLogEntryNoReceipt`. Constructing the Flow contract with empty ABI (`new ethers.Contract(addr, [], signer)`) silently breaks. Use the SDK's exported `FixedPriceFlow__factory.connect(addr, signer)` instead.

**0G Compute endpoint not yet wired.** With `ZG_COMPUTE_ENDPOINT` empty, `inference.ts` throws `NO_INFERENCE_ENDPOINT` from `chat()`. `ask()`, `reflect()`, and `plan()` catch it and return placeholders so the demo doesn't crash. Embeddings still fall back to `@xenova/transformers` (or pseudo-hash if WASM unavailable).

**Batcher API.** The `Batcher` constructor in `storage.ts` takes `(1, nodes, flowContractInstance, rpcUrl)`. If you update `@0gfoundation/0g-ts-sdk`, the constructor signature might change. Check the release notes.

**KV 256-byte blob limit (P0 bug — vector writes fail).** The 0G Flow contract silently rejects KV-tagged blob submissions that produce >1 SubmissionNode. A blob crosses the 1-node boundary at 256 bytes (1 chunk): `computePaddedSize(N chunks > 1)` returns multiple nodes, and `submit()` reverts with `require(false)` at `estimateGas`. Small KV writes (HEAD pointer, branch list, root anchor) encode to ≤256 bytes and succeed. Vector index shard writes encode a JSON array of VectorEntry objects — each entry contains a 384-dim float embedding (~8 KB as JSON) — and fail. **Fix:** do not store embeddings in KV at all. Upload each VectorEntry as a Log blob (same ECIES encrypt + upload path), store only the 32-byte rootHash per entry in the KV shard. Recall reads the shard (list of rootHashes), downloads each blob, decrypts, then runs cosine similarity. This respects the ≤256-byte KV constraint and mirrors how the commit DAG already works. Files to change: `sdk/src/vector.ts` (insert/search), `sdk/src/kv-views.ts` (shard stores rootHashes, not full entries).

**`recallFromGrant` assumes granter branch is `main`.** If the granter created their memories on a different branch, recall will return empty. This is hardcoded to `main` in `client.ts:recallFromGrant`. Easy to fix by adding a `grantorBranch` option to `grant()`.

**`skills.run()` uses `new Function()`** — this is fine for a hackathon but is a security risk in production. Replace with a WASM worker.

**Embeddings.** Without a 0G Compute endpoint, the SDK falls back to `@xenova/transformers` (WASM, ~20MB download on first run) and then to a deterministic hash-based pseudo-embedding. The pseudo-embedding makes `recall()` work for exact queries but semantic similarity is random. The tests use the hash-based embed — they pass but don't test real semantic search quality.

**research-agent demo loads `.env` from cwd.** The repo-root `.env` is not picked up by the example. Copy or symlink: `cp .env examples/research-agent/.env`. Same for `examples/visual-demo`.

**Demo run on Galileo (2026-04-28).** GrantRegistry deployed at `0xAa14A95b037b76B0D9CDfD5b34492138273057ec`. Wallet `0xdF572AFB46830bb6fd902c8F40e0F722930AdfCe`. Each `remember()` does ~3-4 on-chain ops (Log blob upload + commit blob upload + KV writes); on Galileo testnet ~10-30s per op. Full 16-step demo lands at ~10-20 min wall-clock with patches applied.

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
