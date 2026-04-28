import type { PluginContext, OpenClawHookCtx } from '../types.js';
import { namespaceFromSessionKey } from '../namespace.js';
import { stripMemoryTags, shouldCapture } from '../security.js';

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join(' ');
  }
  return '';
}

export function makeAgentEnd(plugin: PluginContext) {
  return async function agentEnd(ctx: OpenClawHookCtx): Promise<void> {
    if (!plugin.cfg.autoCapture) return;

    const ns = namespaceFromSessionKey(
      ctx.sessionKey ?? ctx.agentName,
      plugin.cfg.defaultNamespace,
    );

    const recent = (ctx.messages ?? []).slice(-plugin.cfg.captureMaxMessages);
    if (recent.length === 0) return;

    const blob = recent
      .map((m) => stripMemoryTags(extractText(m.content)))
      .filter((s) => s.length > 0)
      .join('\n');

    if (!shouldCapture(blob)) return;

    try {
      await plugin.mem.remember(blob, {
        ns,
        tags: ['auto-capture', 'openclaw'],
      });
    } catch {
      // capture is best-effort; never block the response path
    }
  };
}
