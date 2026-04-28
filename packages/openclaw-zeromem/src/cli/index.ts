#!/usr/bin/env node
import { createZeroMemPlugin } from '../index.js';
import { namespaceFromSessionKey } from '../namespace.js';

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
      flags[k] = v;
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

  const cfg = {
    privateKey: process.env.ZEROMEM_PRIVATE_KEY ?? process.env.ZG_PRIVATE_KEY ?? '',
    agentId: flags.agent ?? process.env.ZEROMEM_AGENT_ID ?? 'main',
    grantRegistryAddress: process.env.GRANT_REGISTRY_ADDRESS,
    kvUrl: process.env.ZG_KV_URL,
    rpc: process.env.ZG_RPC,
    indexer: process.env.ZG_INDEXER,
  };

  if (!cfg.privateKey) {
    console.error('error: ZEROMEM_PRIVATE_KEY (or ZG_PRIVATE_KEY) not set');
    process.exit(1);
  }

  const plugin = await createZeroMemPlugin(cfg);

  switch (cmd) {
    case 'search': {
      const query = positional.join(' ');
      if (!query) {
        console.error('usage: zeromem search "<query>" [--limit N] [--agent NAME]');
        process.exit(1);
      }
      const ns = namespaceFromSessionKey(
        flags.agent ? `agent:${flags.agent}:cli` : undefined,
      );
      const k = flags.limit ? Number(flags.limit) : 5;
      const hits = await plugin.mem.recall(query, { k, ns });
      console.log(JSON.stringify(hits, null, 2));
      break;
    }
    case 'stats': {
      const agentId = cfg.agentId;
      console.log(JSON.stringify({
        agentId,
        defaultNamespace: 'default',
        autoRecall: true,
        autoCapture: true,
        rpc: cfg.rpc ?? '(default)',
        kvUrl: cfg.kvUrl ?? '(default)',
        keyMasked: cfg.privateKey.slice(0, 6) + '...' + cfg.privateKey.slice(-4),
        grantRegistry: cfg.grantRegistryAddress ?? '(unset)',
      }, null, 2));
      break;
    }
    default:
      console.error('zeromem <search|stats> [args]');
      console.error('  search "<query>" [--limit N] [--agent NAME]');
      console.error('  stats [--agent NAME]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
