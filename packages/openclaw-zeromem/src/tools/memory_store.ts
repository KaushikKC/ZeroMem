import type { PluginContext, ZeroMemTool } from '../types.js';
import { detectInjection, stripMemoryTags } from '../security.js';

export interface MemoryStoreInput {
  text: string;
  namespace?: string;
}

export function makeMemoryStoreTool(plugin: PluginContext): ZeroMemTool {
  return {
    name: 'memory_store',
    description:
      'Save a piece of information to long-term memory. The text will be ' +
      'embedded, encrypted, and committed to the 0G storage network.',
    schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Information to store' },
        namespace: { type: 'string', description: 'Memory namespace (auto-filled)' },
      },
      required: ['text'],
    },
    async execute(input: MemoryStoreInput): Promise<string> {
      const cleaned = stripMemoryTags(input.text ?? '');
      if (cleaned.length < 3) return 'Rejected: text too short.';
      if (detectInjection(cleaned)) return 'Rejected: prompt-injection pattern detected.';

      const ns = input.namespace ?? plugin.cfg.defaultNamespace;
      const commitId = await plugin.mem.remember(cleaned, {
        ns,
        tags: ['tool-store', 'openclaw'],
      });

      const preview = cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
      return `Stored memory (commit ${commitId.slice(0, 10)}…): ${preview}`;
    },
  };
}
