# ZeroMem — Full UI Testing Guide

**Date:** 2026-05-01  
**UI:** http://localhost:3000  
**Network:** 0G Galileo Testnet (chain 16602)

---

## Before You Start

### Start the server (if not already running)

```bash
cd zeromem/examples/visual-demo
npm run dev
# → http://localhost:3000
```

### What the header shows

```
ZeroMem  agent: [__________]  branch: [________]  0x4ac8…55B  ⚠ KV: in-memory  ⟳  GrantRegistry: 0xAa14…
```

| Element | Meaning |
|---|---|
| `agent:` field | The agentId — determines which wallet is used |
| `branch:` field | Current Git branch for this agent |
| `0x4ac8…` | Your wallet address (click to copy) |
| `⚠ KV: in-memory` | 0G KV node is down — data lives in RAM this session, blobs are on real 0G |
| `✓ KV: on-chain` | KV node is up — full persistence |
| `⟳` | Refresh status |

### Wallet → Agent mapping

| Agent ID | Wallet Address | Private key in .env |
|---|---|---|
| `agent-a`, `researcher-v1`, `main` | `0x4ac8F862D1bcc4D58B812A4Bef11F431B40e755B` | `RESEARCHER_PRIVATE_KEY` |
| `writer-a`, `writer-v1` | `0x6b31125575A0F6743996Cd5c95b6590983287dBd` | `WRITER_PRIVATE_KEY` |
| anything else (`demo-agent`, etc.) | `0x3C4aa7c460C0e9631f62f1a8F2B49eAd88A1365d` | `ZG_PRIVATE_KEY` |

### Activity log (right panel)

Every action you take appears here in real time. If something fails, the error shows in red. Each entry is expandable — the JSON is the exact API response.

---

## Flow 1 — Core Memory (10 min)

> Goal: store memories, search semantically, use RAG answer, use filters.

**Setup:** Set `agent: agent-a`, `branch: main` in the header. Click ⟳.

---

### Step 1 — Store 3 memories

Go to **Memory tab**.

Store each one — click `mem.remember()` after typing:

```
Memory 1: "0G uses append-only Log layer with Merkle-rooted blobs for cheap verifiable storage."
Memory 2: "Sealed inference runs inside a TEE so embeddings never leave 0G Compute."
Memory 3: "The KV layer stores vector index shards and HEAD pointers for instant lookup."
```

**Expected:** Each returns a `commitId` like `0x94bc...` in the activity log. After each remember, the commit log (Git tab → Refresh) gains a `[remember]` row.

> **Note:** First `remember()` takes ~30–40 seconds — it uploads a blob to 0G Storage. Subsequent ones are faster.

---

### Step 2 — Semantic recall

In the **recall card**, type `storage` and click `recall()`.

**Expected:**
- Memory 1 (Log layer / storage) → ~42–50% score — top result ✓
- Memory 3 (KV / lookup) → ~25–35%
- Memory 2 (sealed inference) → ~10–15% — lowest ✓

If all three scores are identical at ~33%, the semantic model hasn't finished downloading yet (give it 60 seconds and retry).

---

### Step 3 — RAG answer

In the **ask card**, type `"What privacy features does 0G provide?"` and click `ask()`.

**Expected:**
- If `ZG_COMPUTE_ENDPOINT` is set: a proper LLM answer grounded in memories
- If not set: `"Inference unavailable. Relevant memories: [1] Sealed inference runs inside a TEE…"` — the TEE/inference memory correctly ranked first

---

### Step 4 — Search with filters

Fill in:
- Query: `"compute"`
- Since: `1h`
- MinScore: `0.2`

Click `mem.search()`.

**Expected:** Returns memories that match "compute" stored in the last hour with score > 0.2. Memory 2 (sealed inference compute) should appear.

Now add `Tags: "0g"` and click again — should return empty (memories were stored without tags).  
Store a new memory WITH tags: `text: "0G provides both storage and compute"`, Tags: `0g,demo` → click `remember()`.  
Now search with Tags: `"0g"` → should return only that tagged memory.

---

### Step 5 — Forget a memory

In the **forget card**: paste a commitId from the activity log (one of the ones from step 1).  
Click `forget()`.

Then recall "storage" again → that specific memory should no longer appear.

---

### Step 6 — Forget bulk + GC

Go to **forgetBulk card**:
- Tags: `demo`
- Click `forgetBulk()`

Then go to **System tab** → `mem.gc()` → activity log shows how many entries were removed.

---

## Flow 2 — Git: Branch, Merge, Diff, Replay (10 min)

> Goal: demonstrate that memory has Git-like version control.

**Setup:** Still `agent: agent-a`, `branch: main`. At least 3 memories stored from Flow 1.

---

### Step 7 — Create a branch

Go to **Git tab**.

In `mem.branch()` card, type `experiment` → click `branch()`.

**Expected:** The `branch:` field in the header changes to `experiment`. The activity log shows the branch was created.

---

### Step 8 — Add memory on branch

Go to **Memory tab** (still on `experiment` branch).

Store: `"Hypothesis: using pgvector instead of KV would handle larger memory sets better."`

---

### Step 9 — Confirm branch isolation

Change header `branch:` back to `main`.

Recall `"pgvector hypothesis"` → should return **0 results** (that memory only exists on `experiment`).

---

### Step 10 — Diff the branches

Git tab → **diff card**:
- Branch A: `main`
- Branch B: `experiment`
- Click `diff()`

**Expected:**
- `Only in experiment: 1 commits`
- `Diverged at: 0x...` — the commit where they split

---

### Step 11 — Merge

Git tab → **merge card**:
- `experiment` in the "branch to merge from" field
- Strategy: `fast-forward`
- Click `merge()`, then `Refresh log`

**Expected:** Log now shows the experiment branch commit in main's history.

Recall `"pgvector hypothesis"` again → should now return a result with a score.

---

### Step 12 — Blame

Git tab → **blame card**:
- Keyword: `"sealed"`
- Click `blame()`

**Expected:** Shows the commitId + timestamp where "sealed" was first mentioned. This is the `remember()` from Step 1, Memory 2.

---

### Step 13 — Snapshot and time-travel

Git tab → **snapshot card**:
- Name: `before-merge`
- Click `snapshot()` (saves current HEAD)

Now store another memory: `"Post-merge addition for testing replay"`

**Replay card**:
- Paste the commitId of the snapshot (grab from activity log)
- Click `replay()`

**Expected:** Returns a frozen branch name like `replay/a1b2c3d4`.

Change header `branch:` to `replay/a1b2c3d4`.

Recall `"post-merge addition"` → should return **0 results** (that memory didn't exist at snapshot time). ✓

Change branch back to `main`.

---

## Flow 3 — Grants: Cross-Agent Memory Access (10 min)

> Goal: Researcher (agent-a) grants Writer (writer-a) access. Writer reads Researcher's memories.

---

### Step 14 — Note your wallet addresses

Click ⟳ while on `agent-a`. The header shows: `0x4ac8…55B`

Click the address to copy it — **this is the Researcher's address.**

Switch header to `agent: writer-a`. The header shows: `0x6b31…DBd` — **this is the Writer's address.**

**Reference:**
```
Researcher (agent-a): 0x4ac8F862D1bcc4D58B812A4Bef11F431B40e755B
Writer (writer-a):    0x6b31125575A0F6743996Cd5c95b6590983287dBd
Writer pubkey:        0x02d1ac7074c5d7cb9036ad1575772e2165239c5538dc8804325358af36ec49c32d
```

To get the Writer's pubkey: the ⟳ button refreshes it, or run `node -e "const {ethers}=require('ethers'); require('dotenv').config({path:'.env'}); const w=new ethers.Wallet(process.env.WRITER_PRIVATE_KEY); console.log(ethers.SigningKey.computePublicKey(w.signingKey.publicKey,true));"` in the zeromem directory.

---

### Step 15 — Grant access (as Researcher)

Switch header to `agent: agent-a`, `branch: main`.

Grants tab → **mem.grant() card**:
```
Recipient address:  0x6b31125575A0F6743996Cd5c95b6590983287dBd
Recipient pubkey:   0x02d1ac7074c5d7cb9036ad1575772e2165239c5538dc8804325358af36ec49c32d
Scope:              default
TTL:                24h
Tier:               READ_FULL — all namespaces
```

Click `mem.grant()`.

**Expected:** `grantId: 0xe699...` appears next to the button in the activity log.

---

### Step 16 — Cross-agent recall (as Writer)

Switch header to `agent: writer-a`, `branch: main`.

Grants tab → **Cross-agent recall card**:
```
Granter address: 0x4ac8F862D1bcc4D58B812A4Bef11F431B40e755B
Query:           0G storage
```

Click `recall(from:)`.

**Expected:** Returns the Researcher's memories about 0G storage with scores. ✓

---

### Step 17 — Revoke the grant (as Researcher)

Switch back to `agent: agent-a`.

Grants tab → **revoke card**:
```
grantId:   (paste the grantId from Step 15)
scope:     default
recipient: 0x6b31125575A0F6743996Cd5c95b6590983287dBd
```

Click `revoke()`.

Switch back to `agent: writer-a`. Try the cross-agent recall again.

**Expected:** `"No grant found from 0x4ac8... for scope 'default'"` — access revoked ✓

---

### Step 18 — Challenge-Response verified grant

Switch to `agent: agent-a`.

Grants tab → **Challenge-Response card**:

**Step 1:** Recipient address: `0x6b31125575A0F6743996Cd5c95b6590983287dBd`, Scope: `default` → click `1. createChallenge()`

**Expected:** A JSON challenge object appears in the text area.

**Step 2:** Paste `WRITER_PRIVATE_KEY` (from your `.env`) into the recipient private key field → click `2. signChallenge()`

**Expected:** Shows `✓ Signed by: 0x6b31...` — confirms the signature came from the Writer's wallet.

**Step 3:** Paste Writer's pubkey in the pubkey field → click `3. grantVerified()`

**Expected:** `✓ 0xe69913...` — grant was created AND verified the recipient actually owns that wallet.

Now try wrong key: paste `RESEARCHER_PRIVATE_KEY` in Step 2 instead → Step 3 should fail: `"Access challenge failed: Signature mismatch"` ✓

---

## Flow 4 — System: Stats, Reflect, Prove, Restore (10 min)

---

### Step 19 — Stats

Switch to `agent: agent-a`. Go to **System tab**.

Click `Load stats`.

**Expected:**
```
Agent: agent-a
Branch: main
Branches: [main, experiment]
Total memories: ~5 (depends on how many you stored)
Namespaces: { "main/default": 4, "main/semantic": 1 }
```

---

### Step 20 — Reflect (episodic → semantic compaction)

System tab → **reflect card**:
- Since: `1h`
- Click `mem.reflect()`

**Expected:**
- If `ZG_COMPUTE_ENDPOINT` set: A `[reflect]` commit appears in the log with a summarized view of your memories
- If not set: A reflect commit is still written (with "(reflector unavailable)" as the summary)

Check Git tab → Refresh log → should show a `[reflect]` commit at the top.

---

### Step 21 — Prove (Merkle attestation)

System tab → **prove card**:
- Paste any `commitId` from the commit log
- Click `prove()`

**Expected:**
```
agentAddr: 0x4ac8F862D1bcc4D58B812A4Bef11F431B40e755B
op:        [remember]
branch:    main
provedAt:  2026-05-01T...
sig:       0x...  (40 chars shown)
[View on 0G StorageScan →]  ← link to the actual blob on-chain
```

The link opens `https://storagescan-galileo.0g.ai/tx/0x...` — shows the blob is real and on-chain. ✓

---

### Step 22 — Restore after KV wipe

This simulates what happens when the KV layer loses data (e.g. server restart, node failure).

Note your current tip commitId (topmost in the commit log).

System tab → **restore card**:
- tipCommitId: paste that commitId
- Click `mem.restore()`

**Expected:** KV is rebuilt from 0G blob DAG. Commit log refreshes and shows the same history. All memories are searchable again. ✓

---

## Flow 5 — Skills and Plans (5 min)

---

### Step 23 — Add a skill

Switch to **Skills & Plans tab**.

The `summarize` skill is pre-loaded in the code field. Click `skills.add()`.

**Expected:** Blob uploaded to 0G, manifest written to KV.

Click `skills.list()` → `summarize` badge appears.

---

### Step 24 — Run the skill

Input field: `{"text":"0G storage is fast.\n0G KV stores indices.\n0G Compute runs inference."}`

Click `skills.run()`.

**Expected:**
```json
{ "summary": "0G storage is fast. | 0G KV stores indices. | 0G Compute runs inference." }
```

---

### Step 25 — Create and track a plan

In the **plan card**, type: `"Write a technical blog post about ZeroMem on 0G"`

Click `plan()`.

**Expected:** A task tree appears, e.g.:
```
⬜  Research 0G Storage architecture
⬜  Research ZeroMem SDK features
⬜  Write introduction section
```

Click the ✓ button on the first task → it becomes ✅ and the plan reloads.

---

## Flow 6 — Batch Grant (2 min)

Grants tab → **batchGrant card**:

Paste two recipients (one per line):
```
0x6b31125575A0F6743996Cd5c95b6590983287dBd:0x02d1ac7074c5d7cb9036ad1575772e2165239c5538dc8804325358af36ec49c32d
0x3C4aa7c460C0e9631f62f1a8F2B49eAd88A1365d:0x02232253978e6bc0f5a93a763637ee2dbaeb953302ed9bde8a0c681cc84b3e36fa
```

Scope: `default`, TTL: `24h`, Tier: `READ_SEMANTIC`

Click `batchGrant()`.

**Expected:** Two grantIds appear in the activity log. One grant per recipient.

---

## What Each Status Means

| What you see | What it means |
|---|---|
| `⚠ KV: in-memory` | 0G KV node at `3.101.147.150:6789` is unreachable. All data is in RAM this session. Blobs ARE on 0G. After server restart, call `restore()` with the last commitId to rebuild. |
| `✓ KV: on-chain` | Full persistence — everything writes to 0G KV on-chain. |
| Empty recall results | Either no memories stored yet, or the tag/score filter is too strict. |
| `Inference unavailable` in ask() | `ZG_COMPUTE_ENDPOINT` not configured. Recall still works; LLM answer generation doesn't. |
| `No grant found` on cross-agent recall | Either wrong granter address, or grant was revoked. Use the address shown in the header. |
| Score ~33% for all results | Embedding model still downloading (first-time only, ~80MB). Wait 60s and retry. |
| First `remember()` takes 30–40s | Normal — blob uploading to 0G Storage over the network. |

---

## Quick Reference: Agent → Address

```
Header agent: "agent-a"       → wallet 0x4ac8F862D1bcc4D58B812A4Bef11F431B40e755B  (Researcher)
Header agent: "writer-a"      → wallet 0x6b31125575A0F6743996Cd5c95b6590983287dBd  (Writer)
Header agent: "demo-agent"    → wallet 0x3C4aa7c460C0e9631f62f1a8F2B49eAd88A1365d  (Default)

GrantRegistry:  0x0eB90F38A7c52f5646DED48b37f6C4DBfcFbf70c
StorageScan:    https://storagescan-galileo.0g.ai
ChainScan:      https://chainscan-galileo.0g.ai
```

---

## Complete Feature Checklist

| Feature | Tab | Steps |
|---|---|---|
| Store memory | Memory | 1 |
| Semantic recall | Memory | 2 |
| RAG answer (ask) | Memory | 3 |
| Search with filters (since/tags/score) | Memory | 4 |
| Forget single commit | Memory | 5 |
| Forget bulk by tags/age | Memory | 6 |
| Garbage collect tombstones | System | 6 |
| Create branch | Git | 7 |
| Branch isolation | Memory+Git | 8–9 |
| Diff two branches | Git | 10 |
| Fast-forward merge | Git | 11 |
| Blame (find first commit with keyword) | Git | 12 |
| Named snapshot + checkout | Git | 13 |
| Time-travel replay (frozen read) | Git | 13 |
| View commit log | Git | Any |
| Simple grant (READ_FULL) | Grants | 14–16 |
| Revoke grant | Grants | 17 |
| Challenge-response verified grant | Grants | 18 |
| Challenge rejection (wrong key) | Grants | 18 |
| Cross-agent recall via grant | Grants | 16 |
| Stats overview | System | 19 |
| Reflect (episodic → semantic) | System | 20 |
| Prove (Merkle attestation + StorageScan) | System | 21 |
| Restore KV from 0G blob DAG | System | 22 |
| Add skill | Skills | 23 |
| Run skill | Skills | 24 |
| Hierarchical plan + task completion | Skills | 25 |
| Batch grant (multiple wallets) | Grants | 26 |
