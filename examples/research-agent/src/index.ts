/**
 * ZeroMem Research-Agent Demo
 *
 * Two agents collaborate:
 *   - Researcher (Agent A): gathers and stores research findings
 *   - Writer    (Agent B): granted read access to Researcher's memory
 *
 * Demonstrates: remember → recall → ask → branch → grant → revoke
 */

import 'dotenv/config';
import { ZeroMem } from '@zeromem/sdk';

const RESEARCHER_KEY = process.env.RESEARCHER_PRIVATE_KEY!;
const WRITER_KEY = process.env.WRITER_PRIVATE_KEY!;

async function main() {
  console.log('=== ZeroMem Research-Agent Demo ===\n');

  // ── Agent A: Researcher ──────────────────────────────────────────────────
  console.log('1. Spinning up Researcher agent...');
  const researcher = await ZeroMem.create({
    privateKey: RESEARCHER_KEY,
    agentId: 'researcher-v1',
    branch: 'main',
    rpcUrl: process.env.ZG_RPC,
    indexerUrl: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
    postgresUrl: process.env.POSTGRES_URL,
    computeEndpoint: process.env.ZG_COMPUTE_ENDPOINT,
    computeProviderAddress: process.env.ZG_COMPUTE_PROVIDER,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  });
  console.log('   Researcher ready.\n');

  // ── Step 1: Researcher stores findings ──────────────────────────────────
  console.log('2. Researcher storing findings...');
  const c1 = await researcher.remember(
    '0G Network uses append-only Log layer with Merkle-rooted blobs for cheap verifiable storage.',
    { tags: ['0g', 'storage'] }
  );
  const c2 = await researcher.remember(
    '0G KV layer supports mutable keyed store for materialized views and vector indices.',
    { tags: ['0g', 'kv'] }
  );
  const c3 = await researcher.remember(
    '0G Compute offers sealed inference with qwen-2.5-7b-instruct on testnet — no data leaves the TEE.',
    { tags: ['0g', 'compute', 'sealed-inference'] }
  );
  console.log(`   Stored 3 commits: ${c1.slice(0, 12)}... ${c2.slice(0, 12)}... ${c3.slice(0, 12)}...\n`);

  // ── Step 2: Researcher branches for hypothesis ───────────────────────────
  console.log('3. Researcher branching to test a hypothesis...');
  const draft = await researcher.branch('hypothesis-vector-sharding');
  await draft.remember(
    'Sharding vector indices across KV keys by namespace+shard_id enables parallel retrieval.',
    { tags: ['hypothesis', 'vector'] }
  );
  console.log('   Branch created: hypothesis-vector-sharding\n');

  // ── Step 3: Recall ───────────────────────────────────────────────────────
  console.log('4. Researcher recalling knowledge about 0G storage...');
  const hits = await researcher.recall('how does 0G storage work?', { k: 3 });
  console.log('   Top results:');
  for (const h of hits) {
    console.log(`   [${(h.score * 100).toFixed(1)}%] ${h.text.slice(0, 80)}...`);
  }
  console.log();

  // ── Step 4: Ask (recall + answer) ────────────────────────────────────────
  console.log('5. Researcher asking a question over recalled memory...');
  const askResult = await researcher.ask('How does 0G storage work and why is it useful?', { k: 3 });
  console.log(`   Answer: ${askResult.answer}\n`);

  // ── Step 5: Plan ─────────────────────────────────────────────────────────
  console.log('6. Researcher generating a plan...');
  const plan = await researcher.plan('Write a technical blog post about ZeroMem on 0G');
  console.log(`   Plan (${plan.tasks.length} tasks):`);
  for (const t of plan.tasks.slice(0, 3)) {
    console.log(`   - [${t.id}] ${t.description}`);
  }
  console.log();

  // ── Step 6: Grant access to Writer ──────────────────────────────────────
  console.log('7. Researcher granting Writer access to research memories (24h)...');

  // Derive writer address from private key
  const { ethers } = await import('ethers');
  const writerWallet = new ethers.Wallet(WRITER_KEY);
  const writerAddr = writerWallet.address;
  const writerPubKey = ethers.SigningKey.computePublicKey(
    writerWallet.signingKey.publicKey,
    true
  );

  const grantId = await researcher.grant({
    to: writerAddr,
    toPubKey: writerPubKey,
    scope: 'default',
    ttl: '24h',
  });
  console.log(`   Grant created: ${grantId.slice(0, 20)}...\n`);

  // ── Step 7: Writer reads granted memories ───────────────────────────────
  console.log('8. Spinning up Writer agent...');
  const writer = await ZeroMem.create({
    privateKey: WRITER_KEY,
    agentId: 'writer-v1',
    branch: 'main',
    rpcUrl: process.env.ZG_RPC,
    indexerUrl: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
    postgresUrl: process.env.POSTGRES_URL,
    computeEndpoint: process.env.ZG_COMPUTE_ENDPOINT,
    computeProviderAddress: process.env.ZG_COMPUTE_PROVIDER,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
  });

  console.log('   Writer recalling from Researcher\'s memory via grant...');
  const researcherAddr = new ethers.Wallet(RESEARCHER_KEY).address;

  try {
    const grantedHits = await writer.recall(
      'What did the researcher find about 0G?',
      { k: 3, from: researcherAddr }
    );
    console.log('   Retrieved from Researcher:');
    for (const h of grantedHits) {
      console.log(`   [${(h.score * 100).toFixed(1)}%] ${h.text.slice(0, 80)}...`);
    }
  } catch (e: any) {
    console.log(`   (Skipped — no grant contract: ${e.message})`);
  }
  console.log();

  // ── Step 8: Writer remembers their own work ──────────────────────────────
  console.log('9. Writer storing their own note...');
  await writer.remember(
    'Draft blog intro written: ZeroMem turns 0G into a Git-like memory layer for AI agents.',
    { tags: ['blog', 'draft'] }
  );
  console.log('   Note stored.\n');

  // ── Step 9: Commit log ───────────────────────────────────────────────────
  console.log('10. Researcher commit log (last 5):');
  const commits = await researcher.log({ limit: 5 });
  for (const { commitId, commit } of commits) {
    const ts = new Date(commit.metadata.ts).toISOString();
    console.log(
      `    ${commitId.slice(0, 12)}...  [${commit.op}] branch=${commit.branch}  ${ts}`
    );
  }
  console.log();

  // ── Step 10: Blame ───────────────────────────────────────────────────────
  console.log('11. Blame: find commit that first mentioned "sealed inference"...');
  const blameResult = await researcher.blame('sealed inference');
  if (blameResult.length > 0) {
    console.log(
      `    Found in commit ${blameResult[0].commitId.slice(0, 12)}... (op: ${blameResult[0].op})`
    );
  } else {
    console.log('    Not found via blame (requires inference endpoint for embeddings).');
  }
  console.log();

  // ── Step 11: Time-travel replay ─────────────────────────────────────────
  console.log('12. Time-travel: replaying state at first commit...');
  const snapshot = await researcher.replay({ at: c1 });
  const snapshotHits = await snapshot.recall('0G', { k: 2 });
  console.log(`    Snapshot recalled ${snapshotHits.length} results from commit ${c1.slice(0, 12)}...`);
  console.log();

  // ── Step 12: Revoke grant ────────────────────────────────────────────────
  console.log('13. Researcher revoking Writer\'s grant...');
  await researcher.revoke(grantId);
  console.log('    Grant revoked.\n');

  // ── Step 13: Restore KV from Log ─────────────────────────────────────────
  console.log('14. Demonstrating KV restore from Log (simulated wipe)...');
  await researcher.restore('main');
  console.log('    KV rebuilt from 0G Log layer.\n');

  // ── Step 14: Skills ──────────────────────────────────────────────────────
  console.log('15. Researcher registering a skill...');
  const skillRoot = await researcher.skills.add({
    name: 'summarize',
    code: `
      const lines = input.text.split('\\n').filter(Boolean);
      return { summary: lines.slice(0, 3).join(' | ') };
    `,
    schema: {
      input: { type: 'object', properties: { text: { type: 'string' } } },
      output: { type: 'object', properties: { summary: { type: 'string' } } },
    },
  });
  console.log(`    Skill blob stored: ${skillRoot.slice(0, 12)}...`);

  const result = await researcher.skills.run('summarize', {
    text: 'Line one.\nLine two.\nLine three.\nLine four.',
  });
  console.log(`    Skill output: ${JSON.stringify(result)}\n`);

  // ── Step 15: OpenClaw gateway plugin ─────────────────────────────────────
  console.log('16. Wiring ZeroMem as an OpenClaw gateway plugin...');
  const { createZeroMemPlugin } = await import('@zeromem/openclaw-gateway');
  const plugin = await createZeroMemPlugin({
    privateKey: RESEARCHER_KEY,
    agentId: 'researcher-v1',
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
    rpc: process.env.ZG_RPC,
    indexer: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
  });

  const recallCtx = await plugin.hooks.before_prompt_build({
    sessionKey: 'agent:researcher:demo-session',
    prompt: 'How does 0G storage work and why is it useful for agent memory?',
  });
  console.log('    auto-recall prependContext:');
  console.log(
    (recallCtx.prependContext ?? '(no memories surfaced)')
      .split('\n')
      .map((l) => '      ' + l)
      .join('\n'),
  );
  console.log(`    namespace instruction: ${recallCtx.appendSystemContext}\n`);

  await plugin.hooks.agent_end({
    sessionKey: 'agent:researcher:demo-session',
    messages: [
      {
        role: 'user',
        content: 'I prefer terse responses and TypeScript for backend work always.',
      },
      {
        role: 'assistant',
        content: 'Noted. I will keep responses terse and prefer TypeScript examples.',
      },
    ],
  });
  console.log('    auto-capture fired (best-effort).');

  const searchTool = plugin.tools.find((t) => t.name === 'memory_search')!;
  const toolOut = await searchTool.execute({ query: 'sealed inference', limit: 3 });
  console.log('    memory_search tool output:');
  console.log(toolOut.split('\n').map((l) => '      ' + l).join('\n'));
  console.log();

  console.log('=== Demo complete ===');
  console.log('\nAll memory stored on 0G testnet, fully encrypted with ECIES.');
  console.log('Grant Registry contract governs cross-agent access.');
  console.log('Commit DAG recoverable from 0G Log via restore().');
}

main().catch(console.error);
