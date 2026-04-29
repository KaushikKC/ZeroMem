import 'dotenv/config';
import { ZeroMemClient } from '@zeromem/client';

async function main() {
  const client = ZeroMemClient.create({
    agentId: 'researcher-v1',
    serverUrl: process.env.ZEROMEM_RELAYER_URL ?? 'http://localhost:3001',
    namespace: 'default',
  });

  console.log('=== ZeroMem Relayer Client Demo ===\n');

  const health = await client.health();
  console.log(`Relayer health: ${health.status}\n`);

  const remembered = await client.remember(
    '0G Log stores encrypted memory payload blobs while Postgres indexes vectors.',
    { tags: ['0g', 'architecture'] }
  );
  console.log(`remember() -> ${remembered.commitId}\n`);

  const recalled = await client.recall('How does ZeroMem index memories?', { k: 3 });
  console.log('recall() top hit:');
  console.log(`  ${recalled.hits[0]?.text ?? '(none)'}\n`);

  const asked = await client.ask('How does ZeroMem retrieve memories?', { k: 3 });
  console.log('ask() answer:');
  console.log(`  ${asked.answer}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
