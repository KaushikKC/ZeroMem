# ZeroMem — Implementation Plan

## Status: 2026-04-27

---

## Done

### Phase 1 — Foundations
- `storage.ts` — wraps `@0gfoundation/0g-ts-sdk`: `upload()` (ECIES/AES), `download()`, `kvGet()`, `kvSet()` via Batcher, `peekHeader()`, `selectNodes()`
- `commit.ts` — `ZeroCommit` DAG format, `buildCommit()`, `signCommit()` (secp256k1 via ethers), `verifyCommit()`, `encodeCommit()` / `decodeCommit()`, `walkCommits()` generator
- `kv-views.ts` — all KV key namespaces: HEAD, item count, vector shards, grants, grant reverse-index, skill blobs, skill manifest, tombstones, branches, root commit anchor
- `types.ts` — all TypeScript interfaces

### Phase 2 — Git core
- `git.ts` — `forkBranch()`, `mergeBranch()` (fast-forward + reflect), `log()`, `replay()`, `blame()`
- `client.ts:branch()` / `merge()` — returns new `ZeroMem` instance on the branch
- Branch-isolated vector namespaces — `main/default`, `feature/default` etc. so branches don't bleed into each other's recall results

### Phase 3 — Vector index
- `vector.ts` — `VectorIndex` class: `insert()`, `search()` (cosine similarity), `remove()`, `merge()`
- Shard-based storage: 256 entries per shard, shard index derived from persisted item count
- `kv-views.ts:incrementItemCount()` — fixes the shard count tracking bug so shards correctly overflow at 256 entries

### Phase 4 — Reflector + planner
- `inference.ts` — `InferenceClient`: `embed()` (0G Compute `/embeddings` → `@xenova/transformers` fallback → deterministic pseudo-embed), `reflect()`, `plan()`, `chat()`
- `client.ts:reflect()` — reads recent commits from Log, calls sealed inference, writes `reflect` commit
- `client.ts:plan()` — queries context via recall, calls inference planner, writes plan commit

### Phase 5 — Grant Registry
- `GrantRegistry.sol` — `registerAgent()`, `grant()`, `revoke()`, `isGranted()`, events; compiled on 0G EVM (chain 16602)
- `packages/contracts/scripts/deploy.ts` — Hardhat deploy to Galileo testnet
- `grant.ts` — `createGrant()` (re-encrypts to recipient pubkey, writes KV + reverse-index), `revoke()`, `isGranted()`, `getGrantRecord()`
- `grant.ts:initEventListeners()` — subscribes to on-chain `GrantRevoked` events → removes KV grant entry automatically
- `client.ts:grant()` — passes `granterAgentId` so recipient can find the right KV key prefix
- `client.ts:recallFromGrant()` — reads granter's KV stream using their wallet address, uses `granterAgentId` for index lookup

### Phase 6 — OpenClaw plugin
- `packages/openclaw-plugin/src/index.ts` — `withZeroMem(model, opts)` Proxy wrapper + `zeromemMiddleware()` for `streamText`/`generateText`
- Pre-call hook: top-k memories injected into system prompt
- Post-call hook: response auto-remembered when `autoCapture: true`

### Phase 7 — Skills
- `skills.ts` — `SkillsManager`: `add()` (sign blob, upload, update manifest), `load()`, `list()`, `run()` (sandboxed eval)
- `kv-views.ts:getSkillManifest()` / `setSkillManifest()` — manifest stored directly in KV (no extra blob download)

### Phase 8 — restore() after KV wipe
- `client.ts:restore(branch?, opts?)` — accepts `tipCommitId` param; priority: user-provided → `getHead()` → `getRootCommit()`; walks full DAG, rebuilds vector index + head + root anchor + branch list
- `kv-views.ts:setRootCommitIfAbsent()` / `getRootCommit()` — write-once root anchor at `root/{agent}/{branch}`; `remember()` writes this on first commit

### Phase 9 — Unit tests (59/59 passing)
- `__tests__/helpers.ts` — `MockStorageClient` (in-memory blob + KV stores), `testEmbed()` (deterministic word-hash embedding)
- `__tests__/commit.test.ts` — 7 tests: build, sign/verify, tamper detection, encode/decode
- `__tests__/kv-views.test.ts` — 23 tests: all KV keys, grant index, manifest, tombstone, root anchor
- `__tests__/vector.test.ts` — 15 tests: cosine order, k-limit, 257-entry shard overflow, cross-shard search, merge, remove
- `__tests__/client.test.ts` — 14 tests: remember/recall, branch isolation, merge, forget, restore after KV wipe, grant, plan

### Phase 10 — Scaffolding
- `tsconfig.json` for all 5 packages
- `next.config.js` — server-only external packages for 0G SDK
- Tailwind CSS — `tailwind.config.js`, `postcss.config.js`, `globals.css`
- `@xenova/transformers` as optional dep in SDK
- `jest.config.js` — ts-jest with moduleNameMapper for `.js` imports

---

## Remaining (to ship the demo)

### P0 — Must-have before submission (~2 hrs)

| Task | How |
|---|---|
| Fund two testnet wallets | `https://faucet.0g.ai` — 0.1 0G/day each |
| Deploy `GrantRegistry.sol` | `cd packages/contracts && npm run deploy:testnet` |
| Fill `.env` with both private keys + contract address | See `.env.example` |
| Run `research-agent` demo end-to-end | `cd examples/research-agent && npm run dev` |
| Verify blobs appear on StorageScan | `https://storagescan-galileo.0g.ai` |

### P1 — Strong differentiator (~1 hr)

| Task | How |
|---|---|
| Wire sealed inference | Get provider address from `https://compute-marketplace.0g.ai/inference`, set `ZG_COMPUTE_PROVIDER` + `ZG_COMPUTE_ENDPOINT` in `.env` |
| Test `mem.reflect()` with real 0G Compute | Run research-agent, check that reflect commit calls `qwen-2.5-7b-instruct` not the pseudo-embed fallback |
| Test embedding quality | `mem.recall('storage')` should rank storage-related memories above compute ones |

### P2 — Demo polish (~1 hr)

| Task | How |
|---|---|
| Run visual-demo UI | `cd examples/visual-demo && npm run dev` → `http://localhost:3000` |
| Record demo video (< 3 min) | Screen-record the 14-step research-agent output + UI. Script below |
| Push to GitHub | `git push` — make repo public for judges |

### Demo video script (< 3 min)

1. **0:00** — Show MemWal comparison table. "MemWal was great but had three gaps."
2. **0:30** — `ZeroMem.create()` — one call, agent registered on-chain.
3. **0:45** — `remember()` — show StorageScan with the encrypted blob.
4. **1:00** — `recall()` — semantic search returns correct result.
5. **1:15** — `branch()` + `remember()` + `merge()` — show branch isolation.
6. **1:30** — Two agents: `grant()` → Agent B recalls Agent A's memory → `revoke()` → access gone.
7. **2:00** — Simulate KV wipe → `restore(tipCommitId)` → `recall()` still works.
8. **2:30** — OpenClaw plugin: one-line `withZeroMem(model, { mem })` drop-in.
9. **2:45** — Close: "All memory on 0G. No OpenAI. No Postgres. Just the chain."

### P3 — Optional enhancements

- Replace pseudo-embedding fallback with `@xenova/transformers` WASM worker
- Add `merge()` reflect strategy (summarize branch diffs via sealed inference before merging)
- Add `mem.export()` — download all commits as a portable JSON archive
- Add `mem.diff(branch)` — show what changed between two branches
- Add `runPlan()` — execute a persisted plan step by step

---

## Known limitations / workarounds

| Issue | Status | Workaround |
|---|---|---|
| 0G Batcher signer API — exact constructor arg order for KV writes | Needs live testnet test | `storage.ts` passes `flowContractInstance` as 3rd arg; adjust if SDK version differs |
| 0G Compute embed endpoint — `qwen-2.5-7b-instruct` is chat-only on testnet | Confirmed chat-only | `inference.ts` falls back to `@xenova/transformers` WASM embed |
| KV wipe recovery requires knowing tip commitId | By design | Every `remember()` returns the commitId — log it locally |
| `skills.run()` uses `new Function()` eval | Dev-only | In production, replace with a WASM worker |
| `recallFromGrant` assumes granter's branch is `'main'` | Hardcoded | Pass `grantorBranch` in grant opts if granter uses non-main branch |
