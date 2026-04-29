import type { ZeroMem } from '@zeromem/sdk';

export interface ZeroMemPluginConfig {
  privateKey: string;
  agentId?: string;
  defaultNamespace?: string;
  rpc?: string;
  indexer?: string;
  kvUrl?: string;
  postgresUrl?: string;
  grantRegistryAddress?: string;

  autoRecall?: boolean;
  autoCapture?: boolean;
  maxRecallResults?: number;
  minRelevance?: number;
  captureMaxMessages?: number;
}

export interface PluginContext {
  mem: ZeroMem;
  cfg: Required<Omit<ZeroMemPluginConfig, 'agentId' | 'rpc' | 'indexer' | 'kvUrl' | 'postgresUrl' | 'grantRegistryAddress'>> & {
    agentId?: string;
    rpc?: string;
    indexer?: string;
    kvUrl?: string;
    postgresUrl?: string;
    grantRegistryAddress?: string;
  };
}

export interface OpenClawHookCtx {
  sessionKey?: string;
  agentName?: string;
  prompt?: string;
  messages?: { role: string; content: string | unknown }[];
}

export interface RecallHookResult {
  prependContext?: string;
  appendSystemContext?: string;
}

export const PLUGIN_DEFAULTS = {
  defaultNamespace: 'default',
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 5,
  minRelevance: 0.3,
  captureMaxMessages: 10,
} as const;

export const MEMORY_TAG_OPEN = '<zeromem-memories>';
export const MEMORY_TAG_CLOSE = '</zeromem-memories>';

export interface ZeroMemTool {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
  execute: (input: any) => Promise<string>;
}
