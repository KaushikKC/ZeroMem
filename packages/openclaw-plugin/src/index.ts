import type { ZeroMem } from '@zeromem/sdk';

export interface WithZeroMemOpts {
  mem: ZeroMem;
  /** Automatically inject top-k recalled memories into system prompt */
  autoRecall?: boolean;
  /** Automatically capture LLM response as a memory */
  autoCapture?: boolean;
  /** Number of memories to inject (default 5) */
  topK?: number;
  /** Memory namespace */
  ns?: string;
}

/**
 * Wrap a Vercel AI SDK model with ZeroMem memory hooks.
 *
 * Usage (drop-in parity with @mysten-incubation/oc-memwal):
 *
 *   const model = withZeroMem(openai('gpt-4'), { mem, autoCapture: true });
 *   const { text } = await generateText({ model, prompt: '...' });
 */
export function withZeroMem<T extends object>(
  model: T,
  opts: WithZeroMemOpts
): T {
  const { mem, autoRecall = true, autoCapture = true, topK = 5, ns = 'default' } = opts;

  return new Proxy(model, {
    get(target, prop) {
      const original = (target as any)[prop];

      if (prop === 'doGenerate' || prop === 'doStream') {
        return async function (this: unknown, params: any, ...rest: unknown[]) {
          // Pre-call: inject recalled memories into system prompt
          if (autoRecall) {
            const userMessages = params.prompt?.filter((m: any) => m.role === 'user') ?? [];
            const latestUser = userMessages[userMessages.length - 1];
            if (latestUser) {
              const query = extractText(latestUser);
              const hits = await mem.recall(query, { k: topK, ns });
              if (hits.length > 0) {
                const memBlock = hits
                  .map((h, i) => `[Memory ${i + 1}] ${h.text}`)
                  .join('\n');
                const systemInjection = {
                  role: 'system' as const,
                  content: `Relevant memories:\n${memBlock}`,
                };
                params = {
                  ...params,
                  prompt: [systemInjection, ...(params.prompt ?? [])],
                };
              }
            }
          }

          // Call original
          const result = await original.call(this, params, ...rest);

          // Post-call: capture response as memory
          if (autoCapture) {
            const responseText = extractResponseText(result);
            if (responseText) {
              await mem.remember(responseText, { ns, tags: ['auto-capture'] }).catch(() => {});
            }
          }

          return result;
        };
      }

      if (typeof original === 'function') {
        return original.bind(target);
      }
      return original;
    },
  }) as T;
}

/**
 * Middleware for Vercel AI SDK streamText / generateText.
 * Wraps the `experimental_transform` pipeline hook.
 */
export function zeromemMiddleware(opts: WithZeroMemOpts) {
  const { mem, autoRecall = true, autoCapture = true, topK = 5, ns = 'default' } = opts;

  return {
    wrapGenerate: async (args: {
      doGenerate: () => Promise<any>;
      params: any;
    }) => {
      if (autoRecall) {
        const query = extractPromptQuery(args.params);
        if (query) {
          const hits = await mem.recall(query, { k: topK, ns });
          if (hits.length > 0) {
            const memBlock = hits.map((h, i) => `[Memory ${i + 1}] ${h.text}`).join('\n');
            args.params = injectSystemMessage(args.params, `Relevant memories:\n${memBlock}`);
          }
        }
      }

      const result = await args.doGenerate();

      if (autoCapture && result.text) {
        await mem.remember(result.text, { ns, tags: ['auto-capture'] }).catch(() => {});
      }

      return result;
    },

    wrapStream: async (args: {
      doStream: () => Promise<any>;
      params: any;
    }) => {
      if (autoRecall) {
        const query = extractPromptQuery(args.params);
        if (query) {
          const hits = await mem.recall(query, { k: topK, ns });
          if (hits.length > 0) {
            const memBlock = hits.map((h, i) => `[Memory ${i + 1}] ${h.text}`).join('\n');
            args.params = injectSystemMessage(args.params, `Relevant memories:\n${memBlock}`);
          }
        }
      }

      return args.doStream();
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function extractText(msg: any): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join(' ');
  }
  return '';
}

function extractResponseText(result: any): string {
  return result?.text ?? result?.choices?.[0]?.message?.content ?? '';
}

function extractPromptQuery(params: any): string {
  const messages: any[] = params?.prompt ?? params?.messages ?? [];
  const userMessages = messages.filter((m) => m.role === 'user');
  const last = userMessages[userMessages.length - 1];
  return last ? extractText(last) : '';
}

function injectSystemMessage(params: any, content: string): any {
  const existing = params.prompt ?? params.messages ?? [];
  return {
    ...params,
    prompt: [{ role: 'system', content }, ...existing],
  };
}
