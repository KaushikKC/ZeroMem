/**
 * ZeroMem OpenClaw Plugin — end-to-end demo
 *
 * Drives the @zeromem/openclaw-gateway plugin against a real ZeroMem instance:
 *   1. before_prompt_build hook  — auto-recall on incoming prompt
 *   2. agent_end hook            — auto-capture final agent turn
 *   3. memory_search tool        — LLM-callable retrieval
 *   4. memory_store tool         — LLM-callable write
 *   5. mem.ask()                 — OpenRouter LLM answer over recalled memory
 *
 * The plugin uses the SDK directly (no relayer hop), so this exercises the same
 * code path the OpenClaw runtime will hit when the manifest is loaded.
 */

import 'dotenv/config';
import { createZeroMemPlugin } from '@zeromem/openclaw-gateway';

const PRIVATE_KEY = process.env.ZG_PRIVATE_KEY!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? process.env.LLM_MODEL ?? 'openai/gpt-4o-mini';
const OPENROUTER_BASE_URL = process.env.OPENAI_API_BASE ?? 'https://openrouter.ai/api/v1';

async function main() {
  console.log('=== ZeroMem OpenClaw Plugin e2e ===\n');

  if (!OPENROUTER_API_KEY) {
    console.warn(
      'WARN: OPENROUTER_API_KEY not set — `ask` will fall back to the memory dump.\n'
    );
  } else {
    console.log(`Using OpenRouter model: ${OPENROUTER_MODEL}\n`);
  }

  // ── 1. Build the plugin ────────────────────────────────────────────────────
  console.log('1. Creating ZeroMem plugin...');
  const plugin = await createZeroMemPlugin({
    privateKey: PRIVATE_KEY,
    agentId: 'openclaw-demo',
    defaultNamespace: 'reviewer',
    rpc: process.env.ZG_RPC,
    indexer: process.env.ZG_INDEXER,
    kvUrl: process.env.ZG_KV_URL,
    postgresUrl: process.env.POSTGRES_URL,
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
    openrouterApiKey: OPENROUTER_API_KEY || undefined,
    openrouterModel: OPENROUTER_MODEL,
    openrouterBaseUrl: OPENROUTER_BASE_URL,
    autoRecall: true,
    autoCapture: true,
    minRelevance: 0.1,
  });
  console.log(`   Plugin ready. Agent = ${plugin.name}`);
  console.log(`   Tools: ${plugin.tools.map((t) => t.name).join(', ')}`);
  console.log(`   Hooks: ${Object.keys(plugin.hooks).join(', ')}\n`);

  // ── 2. Seed some memories so recall has something to find ─────────────────
  console.log('2. Seeding memories...');
  const seed1 = await plugin.mem.remember(
    'User prefers terse code review comments — single sentence per finding, no fluff.',
    { ns: 'reviewer', tags: ['preference', 'review-style'] }
  );
  const seed2 = await plugin.mem.remember(
    'Stack uses Postgres with pgvector. Don\'t suggest Pinecone or Weaviate.',
    { ns: 'reviewer', tags: ['stack'] }
  );
  console.log(`   Stored: ${seed1.slice(0, 12)}... ${seed2.slice(0, 12)}...\n`);

  // ── 3. Drive before_prompt_build hook ──────────────────────────────────────
  console.log('3. Hook: before_prompt_build...');
  const recallResult = await plugin.hooks.before_prompt_build({
    sessionKey: 'demo-session-1',
    agentName: 'reviewer',
    prompt: 'How should I review this PR? It uses Pinecone for vector search.',
  });
  console.log('   appendSystemContext:', recallResult.appendSystemContext);
  if (recallResult.prependContext) {
    console.log('   prependContext (first 200 chars):');
    console.log('   ', recallResult.prependContext.slice(0, 200), '...');
  } else {
    console.log('   (no memories surfaced — recall returned empty)');
  }
  console.log();

  // ── 4. memory_search tool ─────────────────────────────────────────────────
  console.log('4. Tool: memory_search...');
  const searchTool = plugin.tools.find((t) => t.name === 'memory_search')!;
  const searchOut = await searchTool.execute({
    query: 'review style preferences',
    limit: 3,
    namespace: 'reviewer',
  });
  console.log('   Result:');
  console.log('   ' + searchOut.split('\n').join('\n   '));
  console.log();

  // ── 5. memory_store tool ──────────────────────────────────────────────────
  console.log('5. Tool: memory_store...');
  const storeTool = plugin.tools.find((t) => t.name === 'memory_store')!;
  const storeOut = await storeTool.execute({
    text: 'Reviewer also dislikes emojis in commit messages.',
    namespace: 'reviewer',
  });
  console.log('   Result:', storeOut);
  console.log();

  // ── 6. agent_end hook (auto-capture) ──────────────────────────────────────
  console.log('6. Hook: agent_end (auto-capture)...');
  await plugin.hooks.agent_end({
    sessionKey: 'demo-session-1',
    agentName: 'reviewer',
    messages: [
      { role: 'user', content: 'Reviewed the auth PR.' },
      {
        role: 'assistant',
        content:
          'Found 3 issues: missing input validation in login handler, race condition in session refresh, and a hardcoded JWT secret in tests.',
      },
    ],
  });
  console.log('   Captured (best-effort).\n');

  // ── 7. ask() with OpenRouter ──────────────────────────────────────────────
  console.log('7. mem.ask() — OpenRouter-backed answer...');
  const ask = await plugin.mem.ask(
    'Given my preferences, write a one-line review summary for the auth PR.',
    { k: 5, ns: 'reviewer' }
  );
  console.log('   Answer:');
  console.log('   ' + ask.answer.split('\n').join('\n   '));
  console.log(`\n   (used ${ask.hits.length} memories as context)\n`);

  // ── 8. Confirm captures landed in the log ─────────────────────────────────
  console.log('8. Recent commit log:');
  const log = await plugin.mem.log({ limit: 5 });
  for (const { commitId, commit } of log) {
    console.log(
      `   ${commitId.slice(0, 12)}...  [${commit.op}] ns=${commit.namespace}`
    );
  }

  console.log('\n=== Demo complete ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
