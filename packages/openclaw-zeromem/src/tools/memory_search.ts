import type { RecallResult } from '@zeromem/sdk';
import type { PluginContext, ZeroMemTool } from '../types.js';
import { detectInjection, htmlEscape } from '../security.js';

export interface MemorySearchInput {
  query: string;
  limit?: number;
  namespace?: string;
}

export function makeMemorySearchTool(plugin: PluginContext): ZeroMemTool {
  return {
    name: 'memory_search',
    description:
      'Search the agent\'s long-term memory for facts relevant to a query. ' +
      'Returns ranked memories with relevance scores.',
    schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        namespace: { type: 'string', description: 'Memory namespace (auto-filled)' },
      },
      required: ['query'],
    },
    async execute(input: MemorySearchInput): Promise<string> {
      const q = (input.query ?? '').trim();
      if (q.length < 3) return 'Query too short.';

      const ns = input.namespace ?? plugin.cfg.defaultNamespace;
      const k = input.limit ?? plugin.cfg.maxRecallResults;

      const hits: RecallResult[] = await plugin.mem.recall(q, { k, ns });
      const safe = hits
        .filter((h: RecallResult) => !detectInjection(h.text))
        .map((h: RecallResult, i: number) => {
          const pct = Math.round(h.score * 100);
          return `${i + 1}. ${htmlEscape(h.text)} (${pct}% relevance)`;
        });

      if (safe.length === 0) return `No memories found for "${q}".`;
      return `Found ${safe.length} memories:\n\n${safe.join('\n')}`;
    },
  };
}
