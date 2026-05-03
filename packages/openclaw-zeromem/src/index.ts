import { ZeroMem } from '@zeromem/sdk';
import type {
  ZeroMemPluginConfig,
  PluginContext,
  OpenClawHookCtx,
  RecallHookResult,
  ZeroMemTool,
} from './types.js';
import { PLUGIN_DEFAULTS } from './types.js';
import { makeBeforePromptBuild } from './hooks/before_prompt_build.js';
import { makeAgentEnd } from './hooks/agent_end.js';
import { makeMemorySearchTool } from './tools/memory_search.js';
import { makeMemoryStoreTool } from './tools/memory_store.js';

export * from './types.js';
export { namespaceFromSessionKey } from './namespace.js';
export {
  detectInjection,
  htmlEscape,
  wrapMemoryBlock,
  stripMemoryTags,
  shouldCapture,
} from './security.js';

/** Resolve `${ENV_VAR}` placeholders in config strings */
function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? '');
}

export interface ZeroMemPlugin {
  name: 'zeromem';
  mem: ZeroMem;
  hooks: {
    before_prompt_build: (ctx: OpenClawHookCtx) => Promise<RecallHookResult>;
    agent_end: (ctx: OpenClawHookCtx) => Promise<void>;
  };
  tools: ZeroMemTool[];
  /** Manifest written to openclaw.plugin.json by the gateway */
  manifest: {
    name: 'zeromem';
    version: string;
    hooks: ('before_prompt_build' | 'agent_end')[];
    tools: ('memory_search' | 'memory_store')[];
  };
}

/**
 * Factory: build a ZeroMem OpenClaw gateway plugin.
 *
 * Usage from openclaw.json:
 *   {
 *     "plugins": ["@zeromem/openclaw-gateway"],
 *     "zeromem": {
 *       "privateKey": "${ZEROMEM_PRIVATE_KEY}",
 *       "agentId": "main",
 *       "grantRegistryAddress": "${GRANT_REGISTRY_ADDRESS}"
 *     },
 *     "tools": { "allow": ["memory_search", "memory_store"] }
 *   }
 */
export async function createZeroMemPlugin(
  raw: ZeroMemPluginConfig,
): Promise<ZeroMemPlugin> {
  const privateKey = resolveEnv(raw.privateKey);
  if (!privateKey) {
    throw new Error('zeromem plugin: privateKey missing (or env var unresolved)');
  }

  const mem = await ZeroMem.create({
    privateKey,
    agentId: raw.agentId ?? 'main',
    rpcUrl: resolveEnv(raw.rpc),
    indexerUrl: resolveEnv(raw.indexer),
    kvUrl: resolveEnv(raw.kvUrl),
    postgresUrl: resolveEnv(raw.postgresUrl),
    grantRegistryAddress: resolveEnv(raw.grantRegistryAddress),
    openrouterApiKey: resolveEnv(raw.openrouterApiKey),
    openrouterModel: resolveEnv(raw.openrouterModel),
    openrouterBaseUrl: resolveEnv(raw.openrouterBaseUrl),
  });

  const cfg = {
    privateKey,
    agentId: raw.agentId,
    rpc: raw.rpc,
    indexer: raw.indexer,
    kvUrl: raw.kvUrl,
    postgresUrl: raw.postgresUrl,
    grantRegistryAddress: raw.grantRegistryAddress,
    defaultNamespace: raw.defaultNamespace ?? PLUGIN_DEFAULTS.defaultNamespace,
    autoRecall: raw.autoRecall ?? PLUGIN_DEFAULTS.autoRecall,
    autoCapture: raw.autoCapture ?? PLUGIN_DEFAULTS.autoCapture,
    maxRecallResults: raw.maxRecallResults ?? PLUGIN_DEFAULTS.maxRecallResults,
    minRelevance: raw.minRelevance ?? PLUGIN_DEFAULTS.minRelevance,
    captureMaxMessages:
      raw.captureMaxMessages ?? PLUGIN_DEFAULTS.captureMaxMessages,
  };

  const plugin: PluginContext = { mem, cfg };

  return {
    name: 'zeromem',
    mem,
    hooks: {
      before_prompt_build: makeBeforePromptBuild(plugin),
      agent_end: makeAgentEnd(plugin),
    },
    tools: [makeMemorySearchTool(plugin), makeMemoryStoreTool(plugin)],
    manifest: {
      name: 'zeromem',
      version: '0.1.0',
      hooks: ['before_prompt_build', 'agent_end'],
      tools: ['memory_search', 'memory_store'],
    },
  };
}
